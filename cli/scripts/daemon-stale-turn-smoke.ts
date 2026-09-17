/**
 * Smoke: stale daemon with in-flight turn → TURN_INTERRUPTED; no auto-resume.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { apiFetch } from "../src/api-client";
import {
  NO_DAEMON_ERROR,
  TURN_INTERRUPTED,
} from "../src/ws/presence-constants";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login (chavez auth login)");
  process.exit(1);
}

const path = cwdPath();
const daemonId = randomUUID();

const viewer = new ChavezWsClient(token);
const daemon = new ChavezWsClient(token);

await viewer.connect();
await daemon.connect();

const db = await daemon.bind(path, "daemon", { daemonId });
if (!db.ok) throw new Error(`bind: ${db.error}`);
const vb = await viewer.bind(path, "client");
if (!vb.ok) throw new Error(`viewer bind: ${vb.error}`);

const session = await viewer.request({
  type: "session.create",
  title: "stale-turn-smoke",
});
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await viewer.request({
  type: "chat.create",
  sessionId,
  title: "stale-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

let hangAbort: AbortController | null = null;
const hangPromise = new Promise<void>((resolve) => {
  daemon.onPush((msg) => {
    if (msg.type !== "agent.turn.dispatch") return;
    hangAbort = new AbortController();
    // never finishes unless aborted
    hangAbort.signal.addEventListener("abort", () => resolve());
    void new Promise(() => {});
  });
});

daemon.onClose(({ userInitiated }) => {
  if (!userInitiated) hangAbort?.abort();
});

const interrupted = new Promise<{ error?: string; type: string }>(
  (resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("no TURN_INTERRUPTED within stale window")),
      12_000,
    );
    const seen = new Set<string>();
    viewer.onPush((msg) => {
      if (msg.type === "chat.stream.error") {
        const err = (msg.data as { error?: string })?.error;
        if (err === TURN_INTERRUPTED) seen.add("error");
      }
      if (msg.type === "agent.turn.ended") {
        const err = (msg.data as { error?: string })?.error;
        if (err === TURN_INTERRUPTED || seen.has("error")) {
          seen.add("ended");
        }
      }
      if (seen.has("error") && seen.has("ended")) {
        clearTimeout(t);
        resolve({ type: "ok", error: TURN_INTERRUPTED });
      }
    });
  },
);

const turn = await viewer.request({
  type: "agent.turn.request",
  chatId,
  prompt: "hang forever",
});
if (!turn.ok) throw new Error(`turn: ${turn.error}`);

// No heartbeats — wait for stale sweep (~5s + 1s + buffer)
await Bun.sleep(7500);
await interrupted;
await hangPromise.catch(() => {});

const failTurn = await viewer.request({
  type: "agent.turn.request",
  chatId,
  prompt: "should fail no daemon",
});
if (failTurn.ok) throw new Error("expected NO_DAEMON_ERROR before reconnect");
if (failTurn.error !== NO_DAEMON_ERROR) {
  throw new Error(`got ${failTurn.error}`);
}

// Reclaim with same daemonId
daemon.enableAutoReconnect({
  path,
  clientKind: "daemon",
  hostname: hostname(),
  daemonId,
});
await daemon.connect();
const rebound = await daemon.bind(path, "daemon", { daemonId });
if (!rebound.ok) throw new Error(`rebind: ${rebound.error}`);

const hb = setInterval(() => {
  void daemon.request({ type: "daemon.heartbeat", daemonId }).catch(() => {});
}, 2000);

let dispatchCount = 0;
daemon.onPush((msg) => {
  if (msg.type === "agent.turn.dispatch") {
    dispatchCount += 1;
    const data = (msg.data || {}) as { chatId?: string };
    void daemon.request({
      type: "agent.turn.ended",
      chatId: data.chatId || chatId,
    });
  }
});

const turn2 = await viewer.request({
  type: "agent.turn.request",
  chatId,
  prompt: "new turn after reclaim",
});
if (!turn2.ok) throw new Error(`turn2: ${turn2.error}`);
await Bun.sleep(800);
if (dispatchCount !== 1) {
  throw new Error(`expected 1 dispatch got ${dispatchCount}`);
}

const conns = await apiFetch<{
  connections: Array<{
    clientKind?: string;
    turnBusy?: boolean;
    daemonId?: string | null;
  }>;
}>("/connections", {}, token);
const d = conns.connections.find((c) => c.clientKind === "daemon");
if (!d) throw new Error("daemon missing after reclaim");
if (d.turnBusy) throw new Error("turnBusy still true");

clearInterval(hb);
daemon.close();
viewer.close();
console.log("SMOKE PASS");
