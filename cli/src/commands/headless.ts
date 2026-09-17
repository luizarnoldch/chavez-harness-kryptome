import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { parseExecutionMode } from "../llm/execution-mode";
import { formatWatchLine } from "../llm/watch-format";
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
          "Turn aceptado por el daemon. Usa `chat watch` o el hub web para ver el stream.",
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
        const chatId = rest[0];
        const toolCallId = rest[1];
        if (!chatId || !toolCallId) {
          throw new Error(`Uso: … chat ${action} <chatId> <toolCallId>`);
        }
        const res = await client.request({
          type: action === "approve" ? "agent.tool.approve" : "agent.tool.deny",
          chatId,
          toolCallId,
        });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "watch") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: … chat watch <chatId>");
        // Keep connection open — do not close in finally
        const watchClient = client;
        // prevent finally from closing: re-assign pattern
        watchClient.onPush((msg) => {
          const data = msg.data as { chatId?: string } | undefined;
          if (data?.chatId && data.chatId !== chatId) return;
          const line = formatWatchLine({ type: msg.type, data: msg.data });
          if (line) console.log(line);
        });
        console.error(`watching chat=${chatId} (Ctrl+C para salir)`);
        await new Promise(() => {});
        return;
      }
      throw new Error(
        "Uso: chavez headless chat <create|list|append|get|ask|cancel|watch|approve|deny> …",
      );
    } finally {
      if (action !== "watch") client.close();
    }
  }

  throw new Error(`Grupo desconocido: ${group}`);
}
