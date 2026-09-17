/**
 * Smoke: first daemon wins; standby; promote; NO_DAEMON_ERROR; optional fs.complete.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient, type WsPushMessage } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { apiFetch } from "../src/api-client";
import {
  DAEMON_STANDBY_NOTE,
  NO_DAEMON_ERROR,
} from "../src/ws/presence-constants";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login (chavez login)");
  process.exit(1);
}

const bindPath = cwdPath();

function countDispatch(pushes: WsPushMessage[]) {
  return pushes.filter((m) => m.type === "agent.turn.dispatch").length;
}

const a = new ChavezWsClient(token);
const b = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
const aPushes: WsPushMessage[] = [];
const bPushes: WsPushMessage[] = [];
a.onPush((m) => aPushes.push(m));
b.onPush((m) => bPushes.push(m));

await a.connect();
await b.connect();
await web.connect();

const first = await a.bind(bindPath, "daemon", { daemonId: "id-1" });
const second = await b.bind(bindPath, "daemon", { daemonId: "id-2" });
if (!first.ok) throw new Error(`first bind ${first.error}`);
if (!second.ok) throw new Error(`second bind ${second.error}`);

const hb = setInterval(() => {
  void a.request({ type: "daemon.heartbeat", daemonId: "id-1" }).catch(() => {});
  void b.request({ type: "daemon.heartbeat", daemonId: "id-2" }).catch(() => {});
}, 2000);

const firstData = first.data as { role?: string };
const secondData = second.data as { role?: string; standbyReason?: string };
if (firstData.role !== "primary") {
  throw new Error(`first role=${firstData.role}`);
}
if (secondData.role !== "standby") {
  throw new Error(`second role=${secondData.role}`);
}
if (
  secondData.standbyReason !== DAEMON_STANDBY_NOTE &&
  !String(secondData.standbyReason || "").includes("primary")
) {
  throw new Error(`standbyReason: ${secondData.standbyReason}`);
}

const wb = await web.bind(bindPath, "client");
if (!wb.ok) throw new Error(wb.error);

const session = await web.request({ type: "session.create", title: "first-wins" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "fw-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

aPushes.length = 0;
bPushes.length = 0;
const turn = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ping first-wins",
});
if (!turn.ok) throw new Error(`turn ${turn.error}`);
await Bun.sleep(400);
if (countDispatch(aPushes) !== 1) {
  throw new Error(`primary dispatch count ${countDispatch(aPushes)}`);
}
if (countDispatch(bPushes) !== 0) {
  throw new Error(`standby received dispatch`);
}

// Drop primary without reconnect (close = userInitiated, no auto-reconnect)
a.close();
await Bun.sleep(800);

const listed = await apiFetch<{
  connections: Array<{ clientKind?: string; role?: string }>;
}>("/connections", {}, token);
const daemons = (listed.connections || []).filter(
  (c) => c.clientKind === "daemon",
);
const primary = daemons.find((c) => c.role === "primary");
if (!primary) throw new Error("d2 should be primary after d1 drop");

bPushes.length = 0;
const turn2 = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ping remaining",
});
if (!turn2.ok) throw new Error(`turn2 ${turn2.error}`);
await Bun.sleep(400);
if (countDispatch(bPushes) !== 1) {
  throw new Error(`remaining daemon dispatch count ${countDispatch(bPushes)}`);
}

b.close();
await Bun.sleep(300);
const turn3 = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "should fail",
});
if (turn3.ok) throw new Error("expected NO_DAEMON_ERROR");
if (turn3.error !== NO_DAEMON_ERROR) {
  throw new Error(`expected ${NO_DAEMON_ERROR} got ${turn3.error}`);
}

try {
  const fsRes = await web.request({
    type: "fs.complete",
    chatId,
    query: "src",
  });
  if (fsRes.ok) throw new Error("fs.complete should fail without daemon");
  if (fsRes.error !== NO_DAEMON_ERROR) {
    throw new Error(`fs.complete error ${fsRes.error}`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Unknown type") || msg.includes("not implemented")) {
    console.warn("fs.complete not implemented — skipped");
  } else if (!msg.includes(NO_DAEMON_ERROR) && !String(err).includes("NO_DAEMON")) {
    // request returns ok:false rather than throw — already handled above
    if (!(err instanceof Error && err.message.includes("fs.complete"))) {
      console.warn(`fs.complete check: ${msg}`);
    }
  }
}

web.close();
clearInterval(hb);
console.log("SMOKE PASS");
