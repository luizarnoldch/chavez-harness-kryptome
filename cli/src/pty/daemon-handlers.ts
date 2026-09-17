import { hostname } from "node:os";
import type { ChavezWsClient, WsPushMessage } from "../ws/client";
import { PTY_CHUNK_MAX_BYTES } from "./constants";
import { PtyManager } from "./manager";
import { nativePtyBackend } from "./native";
import { persistPtyTranscript } from "./redact";

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export function createDaemonPty(input: {
  client: ChavezWsClient;
  getCwd: () => string;
  backend?: ConstructorParameters<typeof PtyManager>[0];
}): PtyManager {
  const manager = new PtyManager(input.backend ?? nativePtyBackend, {
    onOpen(session, opened) {
      if (session.kind !== "agent") return;
      void input.client.request({
        type: "pty.attach",
        ptyId: opened.ptyId,
        ownerConnectionId: session.ownerConnectionId,
        hostname: opened.hostname,
        path: opened.cwd,
        chatId: session.chatId,
        metadata: {
          kind: session.kind,
          command: session.command,
          pid: opened.pid,
        },
      });
    },
    onData(ptyId, chunk) {
      const slice =
        chunk.byteLength > PTY_CHUNK_MAX_BYTES
          ? chunk.slice(0, PTY_CHUNK_MAX_BYTES)
          : chunk;
      void input.client.request({
        type: "pty.data",
        ptyId,
        chunk: b64(slice),
        encoding: "base64",
      });
    },
    onExit(ptyId, info) {
      void input.client.request({
        type: "pty.exit",
        ptyId,
        chatId: info.session.chatId,
        path: info.session.cwd,
        hostname: info.session.hostname,
        exitCode: info.exitCode,
        reason: info.reason,
        metadata: {
          transcript: persistPtyTranscript(info.transcript),
          kind: info.session.kind,
          command: info.session.command,
          pid: info.session.pid,
        },
      });
    },
  });
  manager.startSweeper();
  return manager;
}

export async function handlePtyPush(
  manager: PtyManager,
  client: ChavezWsClient,
  msg: WsPushMessage,
  getCwd: () => string,
): Promise<boolean> {
  const data = (msg.data || {}) as Record<string, unknown>;
  if (msg.type === "pty.open.dispatch") {
    const requestId = String(data.requestId || "");
    if (!requestId) return true;
    try {
      const opened = manager.open({
        kind: (data.kind as "user" | "agent") || "user",
        ownerConnectionId: String(data.ownerConnectionId || ""),
        cwd: String(data.path || getCwd()),
        cols: typeof data.cols === "number" ? data.cols : undefined,
        rows: typeof data.rows === "number" ? data.rows : undefined,
        chatId: typeof data.chatId === "string" ? data.chatId : undefined,
        command: typeof data.command === "string" ? data.command : undefined,
        toolCallId:
          typeof data.toolCallId === "string" ? data.toolCallId : undefined,
      });
      await client.request({
        type: "pty.open.result",
        requestId,
        ptyId: opened.ptyId,
        hostname: opened.hostname || hostname(),
        path: opened.cwd,
        cols: opened.cols,
        rows: opened.rows,
        ownerConnectionId: String(data.ownerConnectionId || ""),
        chatId: typeof data.chatId === "string" ? data.chatId : undefined,
        metadata: { pid: opened.pid, kind: opened.kind },
      });
    } catch (error) {
      await client.request({
        type: "pty.open.result",
        requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return true;
  }
  if (msg.type === "pty.input.dispatch") {
    const raw = Buffer.from(String(data.chunk || ""), "base64");
    manager.write(
      String(data.ptyId),
      String(data.ownerConnectionId || ""),
      new Uint8Array(raw),
    );
    return true;
  }
  if (msg.type === "pty.resize.dispatch") {
    manager.resize(
      String(data.ptyId),
      String(data.ownerConnectionId || ""),
      Number(data.cols) || 80,
      Number(data.rows) || 24,
    );
    return true;
  }
  if (msg.type === "pty.close.dispatch" || msg.type === "pty.kill.dispatch") {
    await manager.close(String(data.ptyId), String(data.reason || "close"));
    return true;
  }
  return false;
}
