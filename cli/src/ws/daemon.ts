#!/usr/bin/env bun
/**
 * Long-lived WS keeper + agent runner for headless workspace open.
 * Usage: bun run src/ws/daemon.ts <absolutePath>
 */
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { loadConfig } from "../config";
import { env } from "../lib/config";
import { parseExecutionMode } from "../llm/execution-mode";
import { completeWorkspace } from "../llm/fs-complete";
import { handleToolResolutionPush } from "../llm/handle-tool-resolution";
import { publishAgentTurn } from "../llm/publish-turn";
import { ChavezWsClient, type WsPushMessage } from "./client";
import { writeWorkspaceState } from "../workspace";

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

const workspace = (bound.data as { workspace?: { id: string } })?.workspace;
writeWorkspaceState({
  path,
  pid: process.pid,
  openedAt: new Date().toISOString(),
  workspaceId: workspace?.id,
});
log(`bound daemon workspaceId=${workspace?.id} pid=${process.pid}`);

console.error(`workspace open daemon pid=${process.pid} path=${path}`);

let turnBusy = false;

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
  if (handleToolResolutionPush(msg)) {
    const data = (msg.data || {}) as { toolCallId?: string };
    log(`${msg.type} toolCallId=${data.toolCallId ?? "?"}`);
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    mentions?: string[];
    executionMode?: string;
  };
  if (!data.chatId || !data.prompt) {
    log("dispatch missing chatId/prompt");
    return;
  }
  if (turnBusy) {
    log("turn already running — rejecting dispatch");
    try {
      await client.request({
        type: "chat.stream.error",
        chatId: data.chatId,
        streamId: crypto.randomUUID(),
        content: "Turn already running on this daemon",
      });
    } catch {
      // ignore
    }
    return;
  }
  turnBusy = true;
  log(`turn start chat=${data.chatId}`);
  try {
    await publishAgentTurn({
      client,
      chatId: data.chatId,
      prompt: data.prompt,
      cwd: data.path || path,
      token: config.accessToken!,
      mentions: data.mentions,
      executionMode: parseExecutionMode(data.executionMode),
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
