/**
 * Smoke: daemon reconnect after short drop; presence + turn dispatch again.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { ChavezWsClient, type WsPushMessage } from "../src/ws/client";
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

function waitPresence(
  client: ChavezWsClient,
  bound: boolean,
  timeoutMs = 5000,
): Promise<WsPushMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`no daemon.presence bound=${bound}`)),
      timeoutMs,
    );
    const off = client.onPush((msg) => {
      if (msg.type !== "daemon.presence") return;
      const data = msg.data as { bound?: boolean; daemonId?: string };
      if (data.bound === bound) {
        clearTimeout(t);
        off();
        resolve(msg);
      }
    });
  });
}

const viewer = new ChavezWsClient(token);
const daemon = new ChavezWsClient(token);

daemon.enableAutoReconnect({
  path,
  clientKind: "daemon",
  hostname: hostname(),
  daemonId,
});

await viewer.connect();
await daemon.connect();

const presenceBound = waitPresence(viewer, true, 8000);
const db = await daemon.bind(path, "daemon", { daemonId });
if (!db.ok) throw new Error(`daemon bind: ${db.error}`);
const vb = await viewer.bind(path, "client");
if (!vb.ok) throw new Error(`viewer bind: ${vb.error}`);
await presenceBound;

const workspaces = await apiFetch<{
  workspaces: Array<{
    path?: string;
    daemonBound?: boolean;
    daemonHostname?: string | null;
  }>;
}>("/workspaces", {}, token);
const mine = workspaces.workspaces.find((w) => w.path === path);
if (!mine?.daemonBound) throw new Error("daemonBound false after bind");
if (!mine.daemonHostname) throw new Error("daemonHostname empty");

const presenceLost = waitPresence(viewer, false, 8000);
daemon.dropForTest();
await Promise.race([
  presenceLost,
  (async () => {
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(500);
      const ws = await apiFetch<{
        workspaces: Array<{ path?: string; daemonBound?: boolean }>;
      }>("/workspaces", {}, token);
      const row = ws.workspaces.find((w) => w.path === path);
      if (row && row.daemonBound === false) return;
    }
    throw new Error("daemonBound still true after drop");
  })(),
]);

const presenceBack = waitPresence(viewer, true, 12000);
await presenceBack;

const gotDispatch = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no dispatch after reconnect")), 10000);
  daemon.onPush((msg) => {
    if (msg.type === "agent.turn.dispatch") {
      clearTimeout(t);
      resolve();
    }
  });
});

const session = await viewer.request({
  type: "session.create",
  title: "reconnect-smoke",
});
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await viewer.request({
  type: "chat.create",
  sessionId,
  title: "reconnect-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const turn = await viewer.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ping after reconnect",
});
if (!turn.ok) throw new Error(`turn failed: ${turn.error}`);
const accepted = (turn.data as { accepted?: boolean })?.accepted;
if (!accepted) throw new Error("expected accepted true");
await gotDispatch;

daemon.close();
viewer.close();
console.log("SMOKE PASS");
