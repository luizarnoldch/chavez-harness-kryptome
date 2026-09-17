import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { parseApproveArgs } from "./approval-args";
import { ALREADY_RESOLVED_ERROR } from "../llm/approval-constants";
import { parseExecutionMode } from "../llm/execution-mode";
import { formatDiffStat, formatWatchLine } from "../llm/watch-format";
import { ChavezWsClient } from "../ws/client";
import {
  clearWorkspaceState,
  cwdPath,
  isPidAlive,
  readWorkspaceState,
  workspaceHash,
  writeWorkspaceState,
} from "../workspace";

function requireAuth(): string {
  const token = loadConfig().accessToken;
  if (!token) throw new Error("No hay sesión. Ejecuta: chavez login");
  return token;
}

async function workspaceOpen(): Promise<void> {
  const path = cwdPath();
  const existing = readWorkspaceState(path);
  if (existing && isPidAlive(existing.pid)) {
    console.log(`Ya abierto (pid=${existing.pid}) path=${path}`);
    return;
  }
  if (existing) clearWorkspaceState(path);

  const daemonPath = join(import.meta.dir, "../ws/daemon.ts");
  const logFile = join(
    process.env.USERPROFILE || process.env.HOME || ".",
    ".chavez",
    "workspaces",
    `${workspaceHash(path)}.log`
  );
  mkdirSync(join(process.env.USERPROFILE || process.env.HOME || ".", ".chavez", "workspaces"), {
    recursive: true,
  });

  if (process.platform === "win32") {
    // Detach on Windows so the daemon survives after the CLI exits
    Bun.spawn(
      [
        "cmd",
        "/c",
        "start",
        "/b",
        "",
        "bun",
        "run",
        daemonPath,
        path,
      ],
      {
        cwd: process.cwd(),
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: {
          ...process.env,
          CHAVEZ_WS_DAEMON_LOG: logFile,
        },
      }
    );
  } else {
    const proc = Bun.spawn(["bun", "run", daemonPath, path], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: Bun.file(logFile),
      stdin: "ignore",
      env: process.env,
    });
    proc.unref();
  }

  for (let i = 0; i < 50; i++) {
    await Bun.sleep(150);
    const st = readWorkspaceState(path);
    if (st && isPidAlive(st.pid)) {
      console.log(`Workspace WS abierto cwd=${path} pid=${st.pid}`);
      return;
    }
  }
  throw new Error(
    `No se pudo confirmar el daemon WS. Revisa ~/.chavez/workspaces/${workspaceHash(path)}.log`
  );
}

async function workspaceClose(): Promise<void> {
  const path = cwdPath();
  const st = readWorkspaceState(path);
  if (!st) {
    console.log("No hay workspace WS abierto para este cwd");
    return;
  }
  if (isPidAlive(st.pid)) {
    try {
      process.kill(st.pid, "SIGTERM");
    } catch {
      try {
        process.kill(st.pid);
      } catch {
        // ignore
      }
    }
  }
  clearWorkspaceState(path);
  console.log(`Workspace WS cerrado cwd=${path}`);
}

async function workspaceStatus(): Promise<void> {
  const path = cwdPath();
  const st = readWorkspaceState(path);
  console.log(`cwd: ${path}`);
  if (!st) {
    console.log("status: closed");
    return;
  }
  const alive = isPidAlive(st.pid);
  console.log(`status: ${alive ? "open" : "stale"}`);
  console.log(`pid: ${st.pid}`);
  console.log(`openedAt: ${st.openedAt}`);
  if (st.workspaceId) console.log(`workspaceId: ${st.workspaceId}`);
  if (!alive) clearWorkspaceState(path);
}

async function ensureClient(): Promise<ChavezWsClient> {
  const token = requireAuth();
  const path = cwdPath();
  const st = readWorkspaceState(path);
  // Prefer ephemeral client for RPC even if daemon is open
  // (daemon holds presence; commands use short-lived WS)
  const client = new ChavezWsClient(token);
  await client.connect();
  const bound = await client.bind(path);
  if (!bound.ok) throw new Error(bound.error || "bind failed");
  if (!st?.workspaceId) {
    const workspace = (bound.data as { workspace?: { id: string } })?.workspace;
    if (workspace && st) {
      writeWorkspaceState({ ...st, workspaceId: workspace.id });
    }
  }
  return client;
}

export async function headlessCommand(args: string[]): Promise<void> {
  requireAuth();
  console.log(`cwd: ${cwdPath()}`);

  const [group, action, ...rest] = args;
  if (!group) {
    throw new Error(
      "Uso: chavez headless <workspace|session|chat|connections> …"
    );
  }

  if (group === "connections") {
    const data = await apiFetch<{ connections: unknown[] }>("/connections");
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (group === "workspace") {
    switch (action) {
      case "open":
        await workspaceOpen();
        return;
      case "close":
        await workspaceClose();
        return;
      case "status":
        await workspaceStatus();
        return;
      default:
        throw new Error("Uso: chavez headless workspace <open|close|status>");
    }
  }

  if (group === "session") {
    const client = await ensureClient();
    try {
      if (action === "create") {
        const title = rest.join(" ") || "Session";
        const res = await client.request({ type: "session.create", title });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "list") {
        const res = await client.request({ type: "session.list" });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      throw new Error("Uso: chavez headless session <create|list> [title]");
    } finally {
      client.close();
    }
  }

  if (group === "chat") {
    const client = await ensureClient();
    try {
      if (action === "create") {
        const sessionId = rest[0];
        const title = rest.slice(1).join(" ") || "Chat";
        if (!sessionId) throw new Error("Uso: … chat create <sessionId> [title]");
        const res = await client.request({
          type: "chat.create",
          sessionId,
          title,
        });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "list") {
        const sessionId = rest[0];
        if (!sessionId) throw new Error("Uso: … chat list <sessionId>");
        const res = await client.request({ type: "chat.list", sessionId });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "append") {
        const chatId = rest[0];
        const content = rest.slice(1).join(" ");
        if (!chatId || !content) {
          throw new Error("Uso: … chat append <chatId> <message…>");
        }
        const res = await client.request({
          type: "chat.append",
          chatId,
          role: "user",
          content,
        });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "get") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: … chat get <chatId>");
        const res = await client.request({ type: "chat.get", chatId });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "ask") {
        let modeArg: string | undefined;
        const filtered: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--mode") {
            modeArg = rest[++i];
            continue;
          }
          filtered.push(rest[i]!);
        }
        const chatId = filtered[0];
        const prompt = filtered.slice(1).join(" ");
        if (!chatId || !prompt) {
          throw new Error(
            "Uso: … chat ask [--mode plan|auto|ask] <chatId> <prompt…>",
          );
        }
        if (modeArg) {
          const mode = parseExecutionMode(modeArg, { defaultOnEmpty: false });
          await apiFetch("/providers/preferences", {
            method: "PUT",
            body: JSON.stringify({ activeExecutionMode: mode }),
          });
        }
        const res = await client.request(
          {
            type: "agent.turn.request",
            chatId,
            prompt,
          },
          30_000,
        );
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        console.log(
          "Turn aceptado por el daemon. En modo ask, write/edit/bash esperan Web, TUI o `chat watch` — no se auto-aprueban.",
        );
        console.log(
          "Usa `chavez headless chat watch <chatId>` o `chavez headless chat approve <chatId> <toolCallId>`.",
        );
        return;
      }
      if (action === "cancel") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: … chat cancel <chatId>");
        const res = await client.request({ type: "agent.turn.cancel", chatId });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "approve" || action === "deny") {
        const parsed = parseApproveArgs(action, rest);
        const res = await client.request({
          type: parsed.action === "approve" ? "agent.tool.approve" : "agent.tool.deny",
          chatId: parsed.chatId,
          toolCallId: parsed.toolCallId,
        });
        if (!res.ok) {
          const err = res.error || ALREADY_RESOLVED_ERROR;
          console.error(err);
          process.exit(1);
        }
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "watch") {
        const chatId = rest.find((a) => !a.startsWith("-"));
        const verbose = rest.includes("--verbose") || rest.includes("-v");
        if (!chatId) throw new Error("Uso: … chat watch <chatId> [--verbose]");
        const watchClient = client;
        let lastAwaiting: { chatId: string; toolCallId: string } | null = null;

        watchClient.onPush((msg) => {
          const data = (msg.data || {}) as Record<string, unknown>;
          if (data.chatId && data.chatId !== chatId) return;
          const line = formatWatchLine(
            { type: msg.type, data: msg.data },
            { verbose },
          );
          if (line) console.log(line);
          else {
            console.log(
              JSON.stringify({
                type: msg.type,
                eventId: msg.eventId,
                data: msg.data,
              }),
            );
          }
          if (msg.type === "chat.tool.update" || msg.type === "chat.tool.start") {
            const message = (data.message || {}) as {
              metadata?: Record<string, unknown>;
            };
            const meta = message.metadata || {};
            if (meta.status === "awaiting_approval" && meta.toolCallId) {
              lastAwaiting = { chatId, toolCallId: String(meta.toolCallId) };
            }
            if (meta.resolution) lastAwaiting = null;
          }
          if (msg.type === "chat.tool.resolved") lastAwaiting = null;
        });

        if (process.stdin.isTTY) {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          rl.on("line", async (raw) => {
            const t = raw.trim().toLowerCase();
            if (t !== "y" && t !== "n" && t !== "approve" && t !== "deny") {
              return;
            }
            if (!lastAwaiting) {
              console.error("No tool awaiting approval");
              return;
            }
            const decision =
              t === "y" || t === "approve"
                ? "agent.tool.approve"
                : "agent.tool.deny";
            const res = await watchClient.request({
              type: decision,
              chatId: lastAwaiting.chatId,
              toolCallId: lastAwaiting.toolCallId,
            });
            if (!res.ok) {
              console.error(res.error || ALREADY_RESOLVED_ERROR);
              return;
            }
            lastAwaiting = null;
          });
        }

        console.error(`watching chat=${chatId} (Ctrl+C para salir)`);
        await new Promise(() => {});
        return;
      }
      if (action === "diffs") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: … chat diffs <chatId>");
        const res = await client.request({ type: "chat.get", chatId });
        if (!res.ok) throw new Error(res.error);
        const diffs =
          (res.data as { diffs?: Array<{ path: string; kind: string; additions: number; deletions: number; streamId: string; id: string; truncated?: boolean }> })
            ?.diffs ?? [];
        if (diffs.length === 0) {
          console.log("sin diffs");
          return;
        }
        for (const d of diffs) {
          console.log(
            `${d.streamId.slice(0, 8)}  ${formatDiffStat(d)}${d.truncated ? "  [truncated]" : ""}`,
          );
        }
        return;
      }
      if (action === "diff") {
        const chatId = rest[0];
        const want = rest[1];
        if (!chatId || !want) throw new Error("Uso: … chat diff <chatId> <path|diffId>");
        const listed = await client.request({ type: "chat.get", chatId });
        if (!listed.ok) throw new Error(listed.error);
        const diffs =
          (listed.data as { diffs?: Array<{ id: string; path: string; preview: string; truncated?: boolean; omitted?: boolean }> })
            ?.diffs ?? [];
        const row =
          diffs.find((d) => d.id === want) ||
          diffs.filter((d) => d.path === want).at(-1);
        if (!row) throw new Error(`No hay diff para ${want}`);
        const full = await client.request({
          type: "chat.diff.get",
          chatId,
          diffId: row.id,
        });
        if (!full.ok) throw new Error(full.error);
        const diff = (full.data as { diff?: { body?: string | null; preview?: string; omitted?: boolean } })?.diff;
        if (diff?.omitted || diff?.body == null) {
          console.log(diff?.preview || row.preview);
          return;
        }
        console.log(diff.body);
        return;
      }
      if (action === "undo") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: chavez headless chat undo <chatId>");
        const res = await client.request(
          { type: "agent.turn.undo", chatId },
          30_000,
        );
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as {
          noop?: boolean;
          message?: string;
          restored?: string[];
          warning?: string | null;
        };
        if (data.noop) {
          console.log(data.message || "Nothing to undo: the last turn made no applied changes");
        } else {
          console.log(data.message || "undone");
          if (data.restored?.length) console.log(`restored: ${data.restored.join(", ")}`);
          if (data.warning) console.log(data.warning);
        }
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "retry") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: chavez headless chat retry <chatId>");
        const res = await client.request(
          { type: "agent.turn.retry", chatId },
          30_000,
        );
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        console.log(
          "Retry aceptado. Usa `chat watch` o el hub web para ver el stream.",
        );
        return;
      }
      throw new Error(
        "Uso: chavez headless chat <create|list|append|get|ask|watch|undo|retry|cancel|diffs|diff|approve|deny> …",
      );
    } finally {
      if (action !== "watch") client.close();
    }
  }

  throw new Error(`Grupo desconocido: ${group}`);
}
