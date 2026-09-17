#!/usr/bin/env bun
/**
 * Long-lived WS keeper + agent runner for headless workspace open.
 * Usage: bun run src/ws/daemon.ts <absolutePath>
 */
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { env } from "../lib/config";
import { parseExecutionMode } from "../llm/execution-mode";
import { completeWorkspace } from "../llm/fs-complete";
import { listWorkspaceDir } from "../llm/fs-tree";
import { runGitAction, type GitRpcAction } from "../llm/handle-git-rpc";
import { handleToolResolutionPush } from "../llm/handle-tool-resolution";
import { publishAgentTurn } from "../llm/publish-turn";
import { handleUndoDispatch } from "../llm/run-undo";
import { abortTurn, beginTurnAbort } from "../llm/turn-abort";
import { TURN_BUSY_ERROR } from "../llm/undo-constants";
import { ChavezWsClient, type WsPushMessage } from "./client";
import { writeWorkspaceState } from "../workspace";
import { ensureLocalRulesGitExcluded } from "../llm/rules-git-exclude";
import type { DispatchUserRule } from "../llm/rules-inject";

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
await client.connect();
log("connected");
const bound = await client.bind(path, "daemon");
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
};
const workspace = boundData.workspace;
writeWorkspaceState({
  path,
  pid: process.pid,
  openedAt: new Date().toISOString(),
  workspaceId: workspace?.id,
});
log(
  `bound daemon workspaceId=${workspace?.id} pid=${process.pid} role=${boundData.role} hostname=${boundData.hostname}`,
);
try {
  ensureLocalRulesGitExcluded(path);
} catch {
  // exclude is best-effort
}

if (boundData.role === "standby") {
  console.error(
    "Another daemon is already primary for this workspace; this connection is standby",
  );
}

console.error(`workspace open daemon pid=${process.pid} path=${path}`);

let turnBusy = false;
let undoBusy = false;

client.onPush(async (msg: WsPushMessage) => {
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
      await client.request({
        type: "fs.tree.result",
        requestId: data.requestId,
        hostname: hostname(),
        path,
        metadata: {
          cwd: tree.cwd,
          path: tree.path,
          entries: tree.entries,
          truncated: tree.truncated,
        },
      });
    } catch (err) {
      await client.request({
        type: "fs.tree.result",
        requestId: data.requestId,
        hostname: hostname(),
        path,
        metadata: {
          cwd: path,
          path: data.path || ".",
          entries: [],
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        },
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
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    mentions?: string[];
    attachments?: unknown[];
    retryOfStreamId?: string;
    executionMode?: string;
    daemonConnectionId?: string;
    userRules?: DispatchUserRule[];
    userRulesEnabled?: boolean;
  };
  if (!data.chatId || !data.prompt) {
    log("dispatch missing chatId/prompt");
    return;
  }
  if (boundData.role === "standby") {
    log("standby — ignoring dispatch");
    return;
  }
  if (
    data.daemonConnectionId &&
    boundData.primaryConnectionId &&
    data.daemonConnectionId !== boundData.primaryConnectionId
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

setInterval(async () => {
  try {
    await client.request({ type: "ping" });
  } catch {
    shutdown();
  }
}, 20000);

await new Promise(() => {});
