#!/usr/bin/env bun
/**
 * Long-lived WS keeper + agent runner for headless workspace open.
 * Usage: bun run src/ws/daemon.ts <absolutePath>
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { env } from "../lib/config";
import { parseExecutionMode } from "../llm/execution-mode";
import { completeWorkspace } from "../llm/fs-complete";
import { listWorkspaceDir } from "../llm/fs-tree";
import { searchWorkspace } from "../llm/fs-search";
import { previewFile } from "../llm/fs-preview";
import { runGitAction, type GitRpcAction } from "../llm/handle-git-rpc";
import { handleToolResolutionPush } from "../llm/handle-tool-resolution";
import { handleCompactDispatch } from "../llm/compact-dispatch";
import { publishAgentTurn } from "../llm/publish-turn";
import { handleUndoDispatch } from "../llm/run-undo";
import { abortAllTurns, abortTurn, beginTurnAbort } from "../llm/turn-abort";
import { TURN_BUSY_ERROR } from "../llm/undo-constants";
import { ChavezWsClient, type WsPushMessage } from "./client";
import { writeWorkspaceState } from "../workspace";
import { ensureLocalRulesGitExcluded } from "../llm/rules-git-exclude";
import type { DispatchUserRule } from "../llm/rules-inject";
import {
  loadLocalRules,
  loadProjectRules,
  localMachineRulesPath,
  writeLocalMachineRules,
} from "../llm/rules-load";
import { toRuleRef } from "../llm/rules-merge";
import { workspaceHash } from "../workspace";
import {
  DAEMON_STANDBY_NOTE,
  HEARTBEAT_INTERVAL_MS,
} from "./presence-constants";

function log(line: string) {
  const file = env.server.wsDaemonLog;
  if (file) {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // ignore
    }
  }
  console.error(line);
}

const pathArg = process.argv[2];
if (!pathArg) {
  console.error("path required");
  process.exit(1);
}

const path = pathArg.replace(/\\/g, "/").replace(/\/+$/, "");
const config = loadConfig();
if (!config.accessToken) {
  console.error("Not logged in");
  process.exit(1);
}

log(`starting path=${path}`);
const client = new ChavezWsClient(config.accessToken);
const daemonId = randomUUID();
let daemonRole: string | undefined;
let ourConnectionId: string | undefined;
let turnBusy = false;
let undoBusy = false;

client.enableAutoReconnect({
  path,
  clientKind: "daemon",
  hostname: hostname(),
  daemonId,
});

client.onClose(({ userInitiated }) => {
  if (userInitiated) return;
  abortAllTurns();
  turnBusy = false;
  log("socket dropped — in-flight turn interrupted, will reconnect");
});

client.onStatus((status) => {
  if (status === "bound") {
    log(`reconnected daemonId=${daemonId}`);
  }
});

client.onRebind((res) => {
  const data = (res.data || {}) as {
    role?: string;
    primaryConnectionId?: string;
  };
  if (typeof data.role === "string") daemonRole = data.role;
  if (typeof data.primaryConnectionId === "string") {
    ourConnectionId = data.primaryConnectionId;
  }
});

await client.connect();
log("connected");
const bound = await client.bind(path, "daemon", { daemonId });
if (!bound.ok) {
  log(`bind failed: ${bound.error}`);
  console.error(bound.error || "bind failed");
  process.exit(1);
}

const boundData = (bound.data || {}) as {
  workspace?: { id: string };
  role?: string;
  hostname?: string;
  primaryConnectionId?: string;
  daemonId?: string;
};
daemonRole = boundData.role;
ourConnectionId = boundData.primaryConnectionId;
const workspace = boundData.workspace;
writeWorkspaceState({
  path,
  pid: process.pid,
  openedAt: new Date().toISOString(),
  workspaceId: workspace?.id,
  daemonId,
});
log(
  `bound daemon workspaceId=${workspace?.id} pid=${process.pid} role=${boundData.role} hostname=${boundData.hostname} daemonId=${daemonId}`,
);
try {
  ensureLocalRulesGitExcluded(path);
} catch {
  // exclude is best-effort
}

if (boundData.role === "standby") {
  console.error(DAEMON_STANDBY_NOTE);
}

console.error(`workspace open daemon pid=${process.pid} path=${path}`);

client.onPush(async (msg: WsPushMessage) => {
  async function replyFs(
    type: "fs.tree.result" | "fs.search.result" | "fs.preview.result",
    requestId: string,
    metadata: Record<string, unknown>,
  ) {
    await client.request({
      type,
      requestId,
      hostname: hostname(),
      path,
      metadata,
    });
  }

  if (msg.type === "fs.complete.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      query?: string;
      path?: string;
    };
    if (!data.requestId) return;
    const candidates = completeWorkspace(data.path || path, data.query || "", 10);
    await client.request({
      type: "fs.complete.result",
      requestId: data.requestId,
      hostname: hostname(),
      path,
      metadata: { cwd: data.path || path, candidates },
    });
    return;
  }
  if (msg.type === "fs.tree.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      path?: string;
      workspacePath?: string;
    };
    if (!data.requestId) return;
    try {
      const tree = listWorkspaceDir(data.workspacePath || path, data.path || ".");
      await replyFs("fs.tree.result", data.requestId, {
        cwd: tree.cwd,
        path: tree.path,
        entries: tree.entries,
        truncated: tree.truncated,
      });
    } catch (err) {
      await replyFs("fs.tree.result", data.requestId, {
        cwd: path,
        path: data.path || ".",
        entries: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === "fs.search.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      query?: string;
      workspacePath?: string;
    };
    if (!data.requestId) return;
    try {
      const found = searchWorkspace(data.workspacePath || path, data.query || "");
      await replyFs("fs.search.result", data.requestId, {
        cwd: found.cwd,
        query: found.query,
        matches: found.matches,
        truncated: found.truncated,
      });
    } catch (err) {
      await replyFs("fs.search.result", data.requestId, {
        cwd: path,
        query: String(data.query || ""),
        matches: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === "fs.preview.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      path?: string;
      workspacePath?: string;
    };
    if (!data.requestId) return;
    try {
      const prev = previewFile(data.workspacePath || path, data.path || "");
      await replyFs("fs.preview.result", data.requestId, { ...prev });
    } catch (err) {
      await replyFs("fs.preview.result", data.requestId, {
        cwd: path,
        path: data.path || "",
        kind: "binary",
        status: "forbidden",
        byteSize: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (handleToolResolutionPush(msg)) {
    const data = (msg.data || {}) as { toolCallId?: string };
    log(`${msg.type} toolCallId=${data.toolCallId ?? "?"}`);
    return;
  }
  if (msg.type === "agent.turn.cancel") {
    const cancelData = (msg.data || {}) as { chatId?: string };
    const okCancel = cancelData.chatId ? abortTurn(cancelData.chatId) : false;
    log(`cancel chat=${cancelData.chatId} ok=${okCancel}`);
    return;
  }
  if (msg.type === "agent.turn.undo.dispatch") {
    if (turnBusy || undoBusy) {
      const data = (msg.data || {}) as { requestId?: string; chatId?: string };
      if (data.requestId) {
        await client.request({
          type: "agent.turn.undo.result",
          requestId: data.requestId,
          chatId: data.chatId,
          status: "error",
          metadata: { error: TURN_BUSY_ERROR, chatId: data.chatId },
        });
      }
      return;
    }
    undoBusy = true;
    try {
      await handleUndoDispatch({
        client,
        cwd: path,
        data: (msg.data || {}) as Parameters<typeof handleUndoDispatch>[0]["data"],
      });
    } finally {
      undoBusy = false;
    }
    return;
  }
  if (msg.type === "workspace.rules.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      payload?: { content?: string };
      workspaceId?: string;
    };
    const cwd = data.path || path;
    try {
      ensureLocalRulesGitExcluded(cwd);
      if (data.action === "local.set") {
        writeLocalMachineRules(cwd, String(data.payload?.content ?? ""));
      }
      const project = loadProjectRules(cwd).map(toRuleRef);
      const local = loadLocalRules(cwd).map(toRuleRef);
      const machine = localMachineRulesPath(cwd);
      let localContent = "";
      try {
        localContent = existsSync(machine) ? readFileSync(machine, "utf8") : "";
      } catch {
        localContent = "";
      }
      const snapshot = {
        project,
        local,
        localContent,
        localPath: `~/.chavez/workspaces/${workspaceHash(cwd)}/rules.local.md`,
      };
      await client.request({
        type: "workspace.rules.result",
        requestId: data.requestId,
        metadata: {
          requestId: data.requestId,
          snapshot,
        },
      });
    } catch (err) {
      await client.request({
        type: "workspace.rules.result",
        requestId: data.requestId,
        status: "error",
        metadata: {
          requestId: data.requestId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return;
  }
  if (msg.type === "workspace.git.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      payload?: Record<string, unknown>;
    };
    if (!data.requestId) return;
    const result = await runGitAction({
      cwd: data.path || path,
      action: data.action as GitRpcAction,
      payload: data.payload || {},
      getGitHubToken: async () => {
        try {
          const creds = await apiFetch<{ secret: string }>(
            "/providers/github/credentials",
            {},
            config.accessToken,
          );
          return creds.secret;
        } catch {
          return null;
        }
      },
    });
    await client.request({
      type: "workspace.git.result",
      requestId: data.requestId,
      metadata: result as unknown as Record<string, unknown>,
      status: result.ok ? "done" : "error",
    });
    return;
  }
  if (msg.type === "chat.compact.dispatch") {
    await handleCompactDispatch({
      client: client as never,
      data: (msg.data || {}) as {
        chatId?: string;
        requestId?: string;
        path?: string;
        trigger?: "manual" | "overflow";
      },
      cwd: path,
      token: config.accessToken,
      isBusy: () => turnBusy,
      setBusy: (v) => {
        turnBusy = v;
      },
    });
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    planBrief?: string;
    executionMode?: string;
    mentions?: string[];
    attachments?: unknown[];
    retryOfStreamId?: string;
    daemonConnectionId?: string;
    userRules?: DispatchUserRule[];
    userRulesEnabled?: boolean;
  };
  if (!data.chatId || !data.prompt) {
    log("dispatch missing chatId/prompt");
    return;
  }
  if (daemonRole === "standby") {
    log("standby — ignoring dispatch");
    return;
  }
  if (
    data.daemonConnectionId &&
    ourConnectionId &&
    data.daemonConnectionId !== ourConnectionId
  ) {
    log("dispatch for another daemon — ignoring");
    return;
  }
  if (turnBusy) {
    log("turn already running — ignoring dispatch");
    return;
  }
  turnBusy = true;
  const ac = beginTurnAbort(data.chatId);
  log(`turn start chat=${data.chatId}`);
  try {
    await publishAgentTurn({
      client,
      chatId: data.chatId,
      prompt: data.prompt,
      cwd: data.path || path,
      token: config.accessToken!,
      mentions: data.mentions,
      attachments: data.attachments,
      retryOfStreamId: data.retryOfStreamId,
      executionMode: parseExecutionMode(data.executionMode),
      planBrief: data.planBrief,
      abortController: ac,
      userRules: data.userRules,
      userRulesEnabled: data.userRulesEnabled,
    });
    log(`turn ok chat=${data.chatId}`);
  } catch (err) {
    log(`turn fail: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    turnBusy = false;
  }
});

const shutdown = () => {
  try {
    client.close();
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {
  void client
    .request({ type: "daemon.heartbeat", daemonId })
    .then((res) => {
      if (res.ok && res.data && typeof res.data === "object") {
        const data = res.data as { role?: string };
        if (typeof data.role === "string") daemonRole = data.role;
      }
    })
    .catch((err) => {
      log(`heartbeat fail: ${err instanceof Error ? err.message : String(err)}`);
    });
}, HEARTBEAT_INTERVAL_MS);

await new Promise(() => {});
