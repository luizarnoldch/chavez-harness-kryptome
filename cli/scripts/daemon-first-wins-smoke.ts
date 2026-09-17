/**
 * Smoke: first daemon bind wins; standby does not receive dispatch;
 * close primary promotes remaining; close last → NO_DAEMON_ERROR.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient, type WsPushMessage } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login (chavez login)");
  process.exit(1);
}

const bindPath = cwdPath();
const api = config.apiUrl.replace(/\/$/, "");

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

const first = await a.bind(bindPath, "daemon");
const second = await b.bind(bindPath, "daemon");
if (!first.ok) throw new Error(`first bind ${first.error}`);
if (!second.ok) throw new Error(`second bind ${second.error}`);

const firstData = first.data as { role?: string };
const secondData = second.data as { role?: string; standbyReason?: string };
if (firstData.role !== "primary") {
  throw new Error(`first role=${firstData.role}`);
}
if (secondData.role !== "standby") {
  throw new Error(`second role=${secondData.role}`);
}
if (!String(secondData.standbyReason || "").includes("primary")) {
  throw new Error(`standbyReason missing primary: ${secondData.standbyReason}`);
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

a.close();
await Bun.sleep(400);

const listed = await fetch(`${api}/connections`, {
  headers: { Authorization: `Bearer ${token}` },
});
const listedJson = (await listed.json()) as {
  connections?: Array<{ clientKind?: string; connectionId?: string }>;
};
const daemons = (listedJson.connections || []).filter(
  (c) => c.clientKind === "daemon",
);
if (daemons.length < 1) throw new Error("remaining daemon missing after primary close");

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

web.close();
console.log("DAEMON FIRST-WINS PASS");
