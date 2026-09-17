import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { parseApproveArgs } from "./approval-args";
import { chatOrgAction } from "./chat-org-args";
import { parsePlanArgv, PLAN_ARGV_USAGE } from "./plan-argv";
import { NO_CURRENT_PLAN } from "../llm/plan-artifact";
import { ALREADY_RESOLVED_ERROR } from "../llm/approval-constants";
import { parseExecutionMode } from "../llm/execution-mode";
import { isSlashInput } from "../llm/slash";
import { liveSlashIo } from "../llm/slash-io-live";
import { runSlash } from "../llm/slash-run";
import { formatGitSnapshot } from "../llm/git-format";
import type { GitHeadDiff, GitSnapshot } from "../llm/git-format";
import type { GitPrResult } from "../llm/git-pr";
import { formatDiffStat, formatWatchLine } from "../llm/watch-format";
import { formatContextBanner } from "../llm/context-budget";
import { rulesWatchLine, toRuleRef, type RulesMetadata } from "../llm/rules-merge";
import {
  loadLocalRules,
  loadProjectRules,
  localMachineRulesPath,
  writeLocalMachineRules,
} from "../llm/rules-load";
import { ensureLocalRulesGitExcluded } from "../llm/rules-git-exclude";
import { ChavezWsClient } from "../ws/client";
import {
  askPreflightError,
  NO_DAEMON_ERROR,
  NO_PROVIDER_ASK,
  type OnboardingSnapshot,
} from "../onboarding/status";
import {
  clearWorkspaceState,
  cwdPath,
  isPidAlive,
  readWorkspaceState,
  workspaceHash,
  writeWorkspaceState,
} from "../workspace";
import { isNonInteractive, resolveAskPolicy } from "../queue/admission";
import { QUEUE_CI_BUSY } from "../queue/constants";
import { parseAskArgs } from "../queue/parse-ask-args";
import { onAskPush, timeoutError } from "./headless-ask-wait";

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
      "Uso: chavez headless <workspace|session|chat|git|rules|mcp|skills|connections> …"
    );
  }

  if (group === "connections") {
    const data = await apiFetch<{
      connections: Array<{
        connectionId: string;
        clientKind?: string;
        role?: string;
        hostname?: string | null;
        path?: string | null;
        lastSeen?: string;
        turnBusy?: boolean;
      }>;
    }>("/connections");
    const rows = data.connections ?? [];
    const daemons = rows.filter((c) => c.clientKind === "daemon");
    if (daemons.length === 0) {
      console.log("daemons: (none)");
    } else {
      console.log("daemons:");
      for (const d of daemons) {
        console.log(
          `  ${d.hostname || "—"}  ${d.path || "—"}  ${d.role || "?"}  last-seen ${d.lastSeen || "—"}  busy=${Boolean(d.turnBusy)}  ${d.connectionId}`,
        );
      }
    }
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (group === "mcp") {
    if (action !== "status") {
      throw new Error("Uso: chavez headless mcp status");
    }
    const client = await ensureClient();
    try {
      const res = await client.request(
        { type: "workspace.mcp.snapshot" },
        15_000,
      );
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    } finally {
      client.close();
    }
  }

  if (group === "skills") {
    if (action) throw new Error("Uso: chavez headless skills");
    const client = await ensureClient();
    try {
      const res = await client.request(
        { type: "workspace.skills.snapshot" },
        15_000,
      );
      if (!res.ok) throw new Error(res.error);
      console.log(JSON.stringify(res.data, null, 2));
      return;
    } finally {
      client.close();
    }
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
      if (action === "plan") {
        const parsed = parsePlanArgv(rest);
        const { sub, chatId, artifactId } = parsed;
        if (sub === "list") {
          const res = await client.request({ type: "chat.plan.list", chatId });
          if (!res.ok) throw new Error(res.error);
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (sub === "get") {
          const res = await client.request({ type: "chat.plan.list", chatId });
          if (!res.ok) throw new Error(res.error);
          const data = res.data as {
            currentPlanArtifactId?: string | null;
            plans?: Array<{ id: string; content: string; metadata?: unknown }>;
          };
          const id = artifactId || data.currentPlanArtifactId;
          const plan = data.plans?.find((p) => p.id === id);
          if (!plan) throw new Error(NO_CURRENT_PLAN);
          process.stdout.write(
            plan.content.endsWith("\n") ? plan.content : `${plan.content}\n`,
          );
          return;
        }
        if (sub === "update") {
          if (!artifactId) {
            throw new Error("Uso: … chat plan update <chatId> <artifactId> [--stdin]");
          }
          const markdown = parsed.stdin
            ? await Bun.stdin.text()
            : rest.filter((a) => a !== "--stdin").slice(3).join(" ");
          const res = await client.request({
            type: "chat.plan.update",
            chatId,
            artifactId,
            markdown,
          });
          if (!res.ok) throw new Error(res.error);
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (sub === "current") {
          if (!artifactId) {
            throw new Error("Uso: … chat plan current <chatId> <artifactId>");
          }
          const res = await client.request({
            type: "chat.plan.setCurrent",
            chatId,
            artifactId,
          });
          if (!res.ok) throw new Error(res.error);
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (sub === "apply") {
          const res = await client.request({
            type: "chat.plan.apply",
            chatId,
            artifactId,
          });
          if (!res.ok) throw new Error(res.error);
          const data = res.data as { executionMode?: string; gitCommit?: boolean };
          if (data.gitCommit) {
            throw new Error("apply must not commit");
          }
          console.log(JSON.stringify(res.data, null, 2));
          console.log(
            `Mode → ${data.executionMode}. Next chat ask will use the current plan as brief. No git commit.`,
          );
          return;
        }
        throw new Error(PLAN_ARGV_USAGE);
      }
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
      if (
        action === "list" ||
        action === "search" ||
        action === "pin" ||
        action === "unpin" ||
        action === "archive" ||
        action === "unarchive" ||
        action === "rename" ||
        action === "move"
      ) {
        const rpc = chatOrgAction(action, rest);
        const res = await client.request(rpc);
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
        const ctx = (
          res.data as {
            context?: {
              pct?: number;
              level?: string;
              usedTokens?: number;
              budgetTokens?: number;
            };
          }
        )?.context;
        if (ctx) {
          console.error(
            `context ${ctx.usedTokens}/${ctx.budgetTokens} (${ctx.pct}%) ${ctx.level}`,
          );
          const banner = formatContextBanner(ctx as never);
          if (banner) console.error(banner);
        }
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "compact") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: … chat compact <chatId>");
        const res = await client.request({ type: "chat.compact", chatId }, 90_000);
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as {
          skipped?: boolean;
          reason?: string;
          context?: {
            pct?: number;
            level?: string;
            usedTokens?: number;
            budgetTokens?: number;
          };
        };
        if (data.skipped) {
          console.log(data.reason || "Nothing to compact — chat is already short.");
        } else {
          console.log("contexto compactado");
        }
        if (data.context) {
          console.log(
            `context ${data.context.usedTokens}/${data.context.budgetTokens} (${data.context.pct}%) ${data.context.level}`,
          );
        }
        return;
      }
      if (action === "ask") {
        const parsed = parseAskArgs(rest);
        const { chatId, prompt } = parsed;
        if (!chatId || !prompt) {
          throw new Error(
            "Uso: … chat ask [--no-queue] [--wait-timeout <ms>] [--mode plan|auto|ask] [--provider claude|cursor] [--model <id>] <chatId> <prompt…>",
          );
        }
        const patch: Record<string, string> = {};
        if (parsed.mode) {
          patch.activeExecutionMode = parseExecutionMode(parsed.mode, {
            defaultOnEmpty: false,
          });
        }
        if (parsed.provider) patch.activeProvider = parsed.provider;
        if (parsed.model) patch.activeModel = parsed.model;
        if (Object.keys(patch).length) {
          await apiFetch("/providers/preferences", {
            method: "PUT",
            body: JSON.stringify(patch),
          });
        }
        if (isSlashInput(prompt)) {
          const getRes = await client.request({ type: "chat.get", chatId });
          if (!getRes.ok) throw new Error(getRes.error);
          const sessionId =
            (getRes.data as { chat?: { sessionId?: string } })?.chat?.sessionId ??
            null;
          const io = liveSlashIo({ client });
          const result = await runSlash(prompt, io, { chatId, sessionId });
          console.log(result.text);
          if (result.navigatedChatId) {
            console.log(`chatId: ${result.navigatedChatId}`);
          }
          if (!result.ok) process.exitCode = 1;
          return;
        }
        try {
          const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
          const pre = askPreflightError({
            runnableLinked: snap.steps.providerLinked,
            daemonBound: snap.steps.daemonBound,
          });
          if (pre) throw new Error(pre);
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message === NO_PROVIDER_ASK || err.message === NO_DAEMON_ERROR)
          ) {
            throw err;
          }
          // GET onboarding caído: dejar que agent.turn.request aplique NO_DAEMON_ERROR
        }
        const policy = resolveAskPolicy({
          nonInteractive: isNonInteractive(),
          noQueue: parsed.noQueue,
          waitTimeoutMs: parsed.waitTimeoutMs,
        });
        const res = await client.request(
          {
            type: "agent.turn.request",
            chatId,
            prompt,
            enqueue: policy.enqueue,
          },
          30_000,
        );
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as {
          queued?: boolean;
          position?: number;
          queueId?: string;
          accepted?: boolean;
        };
        console.log(JSON.stringify(res.data, null, 2));

        if (!policy.enqueue && data.queued) {
          await client.request({
            type: "agent.queue.cancel",
            queueId: data.queueId,
          });
          throw new Error(QUEUE_CI_BUSY);
        }

        if (data.queued && policy.waitTimeoutMs <= 0) {
          console.log(
            `Turn encolado posición ${data.position}. Usa chat watch o --wait-timeout.`,
          );
          return;
        }

        if (!data.queued && policy.waitTimeoutMs <= 0 && process.stdout.isTTY) {
          console.log(
            "Turn aceptado por el daemon. Usa `chat watch` o el hub web para ver el stream.",
          );
          return;
        }

        if (policy.waitTimeoutMs > 0) {
          let state = {
            queueId: data.queueId,
            chatId,
            promoted: !data.queued,
            finished: false as boolean,
            error: undefined as string | undefined,
          };
          const done = new Promise<void>((resolve, reject) => {
            const t = setTimeout(async () => {
              if (state.queueId && !state.promoted) {
                await client.request({
                  type: "agent.queue.cancel",
                  queueId: state.queueId,
                });
              }
              reject(new Error(timeoutError()));
            }, policy.waitTimeoutMs);
            client.onPush((msg) => {
              state = onAskPush(state, msg);
              if (state.finished) {
                clearTimeout(t);
                if (state.error) reject(new Error(state.error));
                else resolve();
              }
            });
          });
          try {
            await done;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(message);
            process.exitCode = 1;
            throw err;
          }
          console.log("Turn finished");
          return;
        }

        console.log(
          "Turn aceptado por el daemon. En modo ask, write/edit/bash esperan Web, TUI o `chat watch` — no se auto-aprueban.",
        );
        console.log(
          "Usa `chavez headless chat watch <chatId>` o `chavez headless chat approve <chatId> <toolCallId>`.",
        );
        return;
      }
      if (action === "queue") {
        const chatId = rest[0];
        const res = await client.request({
          type: "agent.queue.list",
          ...(chatId ? { chatId } : {}),
        });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "dequeue") {
        const queueId = rest[0];
        if (!queueId) {
          throw new Error("Uso: … chat dequeue <queueId>");
        }
        const res = await client.request({
          type: "agent.queue.cancel",
          queueId,
        });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "cost") {
        const chatId = rest[0];
        if (!chatId) throw new Error("Uso: chavez headless chat cost <chatId>");
        const io = liveSlashIo({ client });
        const result = await runSlash("/cost", io, { chatId, sessionId: null });
        console.log(result.text);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (action === "clear") {
        const sessionId = rest[0];
        if (!sessionId) throw new Error("Uso: chavez headless chat clear <sessionId>");
        const io = liveSlashIo({ client });
        const result = await runSlash("/clear", io, { chatId: null, sessionId });
        console.log(result.text);
        if (result.navigatedChatId) console.log(`chatId: ${result.navigatedChatId}`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (action === "steer") {
        const chatId = rest[0];
        const content = rest.slice(1).join(" ");
        if (!chatId || !content.trim()) {
          throw new Error("Uso: … chat steer <chatId> <text…>");
        }
        const res = await client.request({
          type: "agent.turn.steer",
          chatId,
          content,
        });
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
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
          const data = msg.data as {
            chatId?: string;
            items?: Array<{ chatId?: string }>;
            running?: { chatId?: string };
          } | undefined;
          const matches =
            data?.chatId === chatId ||
            data?.running?.chatId === chatId ||
            data?.items?.some((it) => it.chatId === chatId);
          if (msg.type === "agent.queue.updated") {
            if (!matches) return;
          } else if (data?.chatId && data.chatId !== chatId) {
            return;
          }
          const line = formatWatchLine(
            { type: msg.type, data: msg.data },
            { verbose },
          );
          if (msg.type.startsWith("chat.plan.")) {
            console.error(`[plan] ${msg.type}`);
          }
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
          const raw = (msg.data || {}) as Record<string, unknown>;
          if (msg.type === "chat.tool.update" || msg.type === "chat.tool.start") {
            const message = (raw.message || {}) as {
              metadata?: Record<string, unknown>;
            };
            const meta = message.metadata || {};
            if (meta.status === "awaiting_approval" && meta.toolCallId) {
              lastAwaiting = { chatId, toolCallId: String(meta.toolCallId) };
            }
            if (meta.resolution) lastAwaiting = null;
          }
          if (msg.type === "chat.tool.resolved") lastAwaiting = null;
          if (msg.type === "chat.stream.end") {
            const message = (raw.message || {}) as {
              metadata?: { rules?: RulesMetadata };
            };
            const meta = message.metadata?.rules;
            if (meta?.counts) console.error(rulesWatchLine(meta));
          }
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
        "Uso: chavez headless chat <create|list|append|get|ask|watch|queue|dequeue|search|pin|unpin|archive|unarchive|rename|move|steer|cancel|plan|compact|undo|cost|clear|retry|diffs|diff|approve|deny> …",
      );
    } finally {
      if (action !== "watch") client.close();
    }
  }

  if (group === "git") {
    const client = await ensureClient();
    try {
      const timeout = action === "push" || action === "pr" ? 60_000 : 15_000;
      if (action === "status") {
        const res = await client.request({ type: "workspace.git.status" }, timeout);
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as { snapshot?: GitSnapshot };
        const snap = data.snapshot;
        console.log(snap ? formatGitSnapshot(snap) : JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "diff") {
        const res = await client.request({ type: "workspace.git.diff" }, timeout);
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as { diff?: GitHeadDiff };
        const diff = data.diff;
        if (diff) {
          if (diff.stat) console.log(diff.stat);
          console.log(diff.unified || diff.message || "");
        } else {
          console.log(JSON.stringify(res.data, null, 2));
        }
        return;
      }
      if (action === "commit") {
        let message = "";
        const paths: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "-m") {
            message = rest[++i] || "";
            continue;
          }
          if (rest[i] === "--") {
            paths.push(...rest.slice(i + 1));
            break;
          }
          paths.push(rest[i]!);
        }
        if (!message.trim()) {
          throw new Error('Uso: chavez headless git commit -m "<msg>" [--] [paths…]');
        }
        const res = await client.request(
          {
            type: "workspace.git.commit",
            message,
            ...(paths.length ? { paths } : {}),
          },
          timeout,
        );
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as { snapshot?: GitSnapshot };
        if (data.snapshot) console.log(formatGitSnapshot(data.snapshot));
        else console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "branch") {
        const name = rest[0];
        if (!name) throw new Error("Uso: chavez headless git branch <name>");
        const res = await client.request(
          { type: "workspace.git.branch", name },
          timeout,
        );
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as { snapshot?: GitSnapshot };
        if (data.snapshot) console.log(formatGitSnapshot(data.snapshot));
        else console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "push") {
        const res = await client.request({ type: "workspace.git.push" }, timeout);
        if (!res.ok) throw new Error(res.error);
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      if (action === "pr") {
        let title = "";
        let body = "";
        let base: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--title") {
            title = rest[++i] || "";
            continue;
          }
          if (rest[i] === "--body") {
            body = rest[++i] || "";
            continue;
          }
          if (rest[i] === "--base") {
            base = rest[++i];
            continue;
          }
        }
        if (!title.trim()) {
          throw new Error(
            'Uso: chavez headless git pr --title "<t>" [--body "<b>"] [--base main]',
          );
        }
        const res = await client.request(
          {
            type: "workspace.git.pr",
            title,
            ...(body ? { body } : {}),
            ...(base ? { base } : {}),
          },
          timeout,
        );
        if (!res.ok) throw new Error(res.error);
        const data = (res.data || {}) as { pr?: GitPrResult };
        if (data.pr?.url) console.log(data.pr.url);
        else console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      throw new Error(
        "Uso: chavez headless git status|diff|commit|push|pr|branch",
      );
    } finally {
      client.close();
    }
  }

  if (group === "rules") {
    const cwd = cwdPath();
    if (action === "project") {
      const rows = loadProjectRules(cwd).map(toRuleRef);
      console.log(JSON.stringify({ project: rows }, null, 2));
      return;
    }
    if (action === "local") {
      const sub = rest[0] || "get";
      if (sub === "get") {
        const rows = loadLocalRules(cwd).map(toRuleRef);
        const machine = localMachineRulesPath(cwd);
        const content = existsSync(machine) ? readFileSync(machine, "utf8") : "";
        console.log(JSON.stringify({ local: rows, content }, null, 2));
        return;
      }
      if (sub === "set") {
        const content = rest.slice(1).join(" ") || await Bun.stdin.text();
        writeLocalMachineRules(cwd, content);
        ensureLocalRulesGitExcluded(cwd);
        console.log("local rules written");
        return;
      }
      throw new Error("Uso: chavez headless rules local get|set [content]");
    }
    if (action === "workspace") {
      const flag = rest[0];
      const st = readWorkspaceState(cwd);
      if (!st?.workspaceId) {
        throw new Error("Workspace no abierto. chavez headless workspace open");
      }
      if (flag !== "on" && flag !== "off") {
        throw new Error("Uso: chavez headless rules workspace on|off");
      }
      const data = await apiFetch(
        `/workspaces/${st.workspaceId}/preferences`,
        {
          method: "PUT",
          body: JSON.stringify({ userRulesEnabled: flag === "on" }),
        },
        requireAuth(),
      );
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    throw new Error("Uso: chavez headless rules project|local|workspace");
  }

  throw new Error(`Grupo desconocido: ${group}`);
}
