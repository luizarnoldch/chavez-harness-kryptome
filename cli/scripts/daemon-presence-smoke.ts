/**
 * Smoke: presence fields on GET /connections and /workspaces; unbound after close.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { apiFetch } from "../src/api-client";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login (chavez auth login)");
  process.exit(1);
}

const path = cwdPath();
const daemonId = randomUUID();
const host = hostname();

const daemon = new ChavezWsClient(token);
await daemon.connect();
const bound = await daemon.bind(path, "daemon", { daemonId });
if (!bound.ok) throw new Error(`bind: ${bound.error}`);

const hb = setInterval(() => {
  void daemon.request({ type: "daemon.heartbeat", daemonId }).catch(() => {});
}, 2000);
await Bun.sleep(500);

const conns = await apiFetch<{
  connections: Array<{
    clientKind?: string;
    hostname?: string | null;
    path?: string | null;
    lastSeen?: string;
    role?: string;
  }>;
}>("/connections", {}, token);
const daemons = (conns.connections || []).filter(
  (c) => c.clientKind === "daemon",
);
if (daemons.length === 0) throw new Error("no daemon in connections");
const d = daemons[0]!;
if (d.hostname !== host) throw new Error(`hostname ${d.hostname} != ${host}`);
if (d.path !== path) throw new Error(`path ${d.path} != ${path}`);
if (!d.lastSeen || !Number.isFinite(Date.parse(d.lastSeen))) {
  throw new Error(`bad lastSeen ${d.lastSeen}`);
}
if (d.role !== "primary") throw new Error(`role ${d.role}`);

const workspaces = await apiFetch<{
  workspaces: Array<{
    path?: string;
    daemonBound?: boolean;
    daemonHostname?: string | null;
    daemonPath?: string;
    daemonLastSeen?: string | null;
  }>;
}>("/workspaces", {}, token);
const mine = workspaces.workspaces.find((w) => w.path === path);
if (!mine?.daemonBound) throw new Error("daemonBound false");
if (mine.daemonHostname !== host) throw new Error("daemonHostname mismatch");
if (mine.daemonPath !== path) throw new Error("daemonPath mismatch");
if (!mine.daemonLastSeen) throw new Error("daemonLastSeen missing");

console.log(`daemons: length=${daemons.length}`);

clearInterval(hb);
daemon.close();

let unbound = false;
for (let i = 0; i < 14; i++) {
  await Bun.sleep(500);
  const ws = await apiFetch<{
    workspaces: Array<{ path?: string; daemonBound?: boolean }>;
  }>("/workspaces", {}, token);
  const row = ws.workspaces.find((w) => w.path === path);
  if (row && row.daemonBound === false) {
    unbound = true;
    break;
  }
}
if (!unbound) throw new Error("daemonBound still true after close ≤6s");

console.log("SMOKE PASS");
