import { hostname as osHostname } from "node:os";
import {
  PTY_BUSY,
  PTY_CHUNK_MAX_BYTES,
  PTY_DEFAULT_COLS,
  PTY_DEFAULT_ROWS,
  PTY_IDLE_CLOSED,
  PTY_IDLE_MS,
  PTY_IDLE_SWEEP_MS,
  PTY_KILL_GRACE_MS,
  PTY_MAX_SESSIONS,
  PTY_NOT_FOUND,
  PTY_OWNER_GONE,
  PTY_TRANSCRIPT_MAX_CHARS,
} from "./constants";
import type { PtyBackend, PtyChild } from "./backend";
import { sanitizePtyEnv } from "./env";
import { persistPtyTranscript } from "./redact";
import type { PtyKind, PtyOpenInput, PtyOpenResult, PtyStatus } from "./types";

export type PtySession = {
  ptyId: string;
  kind: PtyKind;
  ownerConnectionId: string;
  cwd: string;
  hostname: string;
  chatId?: string;
  toolCallId?: string;
  cols: number;
  rows: number;
  pid: number;
  status: PtyStatus;
  startedAt: number;
  lastActivityAt: number;
  transcript: string;
  child: PtyChild;
  command?: string;
  exitNotified?: boolean;
  pendingCloseReason?: string;
};

export type PtyManagerHooks = {
  onData: (ptyId: string, chunk: Uint8Array) => void;
  onOpen?: (session: PtySession, opened: PtyOpenResult) => void;
  onExit: (
    ptyId: string,
    info: PtyExitInfo,
  ) => void;
};

export type PtyExitInfo = {
  exitCode: number | null;
  reason: string;
  transcript: string;
  session: PtySession;
};

export class PtyManager {
  readonly sessions = new Map<string, PtySession>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private exitWaiters = new Map<
    string,
    Set<(info: PtyExitInfo) => void>
  >();
  private completedExits = new Map<string, PtyExitInfo>();

  constructor(
    private backend: PtyBackend,
    private hooks: PtyManagerHooks,
    private now: () => number = Date.now,
    private graceMs = PTY_KILL_GRACE_MS,
  ) {}

  startSweeper() {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.reapIdle(), PTY_IDLE_SWEEP_MS);
  }

  stopSweeper() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  open(input: PtyOpenInput): PtyOpenResult {
    if (this.sessions.size >= PTY_MAX_SESSIONS) throw new Error(PTY_BUSY);
    const cols = input.cols || PTY_DEFAULT_COLS;
    const rows = input.rows || PTY_DEFAULT_ROWS;
    const shell = process.env.SHELL || "/bin/bash";
    const file = input.kind === "agent" ? "/bin/bash" : shell;
    const args =
      input.kind === "agent" ? ["-lc", input.command || "true"] : ["-i"];
    const child = this.backend.spawn({
      cwd: input.cwd,
      env: sanitizePtyEnv(),
      file,
      args,
      cols,
      rows,
    });
    const ptyId = crypto.randomUUID();
    const timestamp = this.now();
    const session: PtySession = {
      ptyId,
      kind: input.kind,
      ownerConnectionId: input.ownerConnectionId,
      cwd: input.cwd,
      hostname: osHostname(),
      chatId: input.chatId,
      toolCallId: input.toolCallId,
      cols,
      rows,
      pid: child.pid,
      status: "open",
      startedAt: timestamp,
      lastActivityAt: timestamp,
      transcript: "",
      child,
      command: input.command,
    };
    this.sessions.set(ptyId, session);
    child.onData((chunk) => {
      session.lastActivityAt = this.now();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk);
      session.transcript = (session.transcript + text).slice(
        -PTY_TRANSCRIPT_MAX_CHARS * 2,
      );
      this.hooks.onData(ptyId, chunk);
    });
    child.onExit(({ exitCode, signal }) => {
      const fallbackReason = signal ? `signal ${signal}` : `exit ${exitCode ?? 0}`;
      const reason = session.pendingCloseReason ?? fallbackReason;
      this.notifyExit(session, exitCode, reason);
    });
    const opened = {
      ptyId,
      pid: child.pid,
      hostname: session.hostname,
      cwd: session.cwd,
      cols,
      rows,
      kind: input.kind,
      shell: file,
    };
    this.hooks.onOpen?.(session, opened);
    return opened;
  }

  write(ptyId: string, ownerConnectionId: string, data: Uint8Array) {
    const session = this.requireOwner(ptyId, ownerConnectionId);
    const chunk =
      data.byteLength > PTY_CHUNK_MAX_BYTES
        ? data.slice(0, PTY_CHUNK_MAX_BYTES)
        : data;
    session.lastActivityAt = this.now();
    session.child.write(chunk);
  }

  resize(
    ptyId: string,
    ownerConnectionId: string,
    cols: number,
    rows: number,
  ) {
    const session = this.requireOwner(ptyId, ownerConnectionId);
    session.cols = cols;
    session.rows = rows;
    session.child.resize(cols, rows);
  }

  async close(ptyId: string, reason = "close") {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(PTY_NOT_FOUND);
    await this.killSession(session, reason);
  }

  async waitForExit(ptyId: string, timeoutMs: number): Promise<PtyExitInfo> {
    const completed = this.completedExits.get(ptyId);
    if (completed) {
      this.completedExits.delete(ptyId);
      return completed;
    }
    if (!this.sessions.has(ptyId)) throw new Error(PTY_NOT_FOUND);

    return await new Promise<PtyExitInfo>((resolve, reject) => {
      let settled = false;
      const finish = (info: PtyExitInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.exitWaiters.get(ptyId)?.delete(finish);
        this.completedExits.delete(ptyId);
        resolve(info);
      };
      const waiters = this.exitWaiters.get(ptyId) ?? new Set();
      waiters.add(finish);
      this.exitWaiters.set(ptyId, waiters);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        if (!waiters.size) this.exitWaiters.delete(ptyId);
        void this.close(ptyId, "agent timeout")
          .catch(() => {})
          .finally(() => reject(new Error("PTY agent timeout")));
      }, timeoutMs);
    });
  }

  async ownerGone(ownerConnectionId: string) {
    const owned = [...this.sessions.values()].filter(
      (session) => session.ownerConnectionId === ownerConnectionId,
    );
    for (const session of owned) {
      await this.killSession(session, PTY_OWNER_GONE);
    }
  }

  async killAll(reason = "daemon shutdown") {
    for (const session of [...this.sessions.values()]) {
      await this.killSession(session, reason);
    }
  }

  reapIdle() {
    const timestamp = this.now();
    for (const session of [...this.sessions.values()]) {
      if (timestamp - session.lastActivityAt >= PTY_IDLE_MS) {
        void this.killSession(session, PTY_IDLE_CLOSED);
      }
    }
  }

  private requireOwner(
    ptyId: string,
    ownerConnectionId: string,
  ): PtySession {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(PTY_NOT_FOUND);
    if (session.ownerConnectionId !== ownerConnectionId) {
      throw new Error(PTY_NOT_FOUND);
    }
    return session;
  }

  private notifyExit(
    session: PtySession,
    exitCode: number | null,
    reason: string,
  ) {
    if (session.exitNotified) return;
    session.exitNotified = true;
    session.status = "exited";
    const transcript = persistPtyTranscript(session.transcript);
    this.sessions.delete(session.ptyId);
    const info: PtyExitInfo = {
      exitCode,
      reason,
      transcript,
      session,
    };
    const waiters = this.exitWaiters.get(session.ptyId);
    if (waiters?.size) {
      for (const resolve of [...waiters]) resolve(info);
      this.exitWaiters.delete(session.ptyId);
    } else {
      this.completedExits.set(session.ptyId, info);
      if (this.completedExits.size > 64) {
        this.completedExits.delete(this.completedExits.keys().next().value!);
      }
    }
    this.hooks.onExit(session.ptyId, info);
  }

  private async killSession(session: PtySession, reason: string) {
    if (
      session.exitNotified ||
      session.status === "killed" ||
      session.status === "exited"
    ) {
      return;
    }
    session.status = "killed";
    session.pendingCloseReason = reason;
    session.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, this.graceMs));
    if (this.sessions.has(session.ptyId) && !session.exitNotified) {
      session.child.kill("SIGKILL");
    }
    if (this.sessions.has(session.ptyId) && !session.exitNotified) {
      this.notifyExit(session, null, reason);
    }
  }
}
