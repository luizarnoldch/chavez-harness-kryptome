#!/usr/bin/env bun
/**
 * Long-lived WS keeper for headless workspace open.
 * Usage: bun run src/ws/daemon.ts <absolutePath>
 */
import { appendFileSync } from "node:fs";
import { loadConfig } from "../config";
import { ChavezWsClient } from "./client";
import { writeWorkspaceState } from "../workspace";

function log(line: string) {
  const file = process.env.CHAVEZ_WS_DAEMON_LOG;
  if (file) {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // ignore
    }
  }
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
const bound = await client.bind(path);
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
log(`bound workspaceId=${workspace?.id} pid=${process.pid}`);

console.error(`workspace open pid=${process.pid} path=${path}`);

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
