/**
 * Smoke: daemon-bound client receives message.appended; agent.turn.request finds daemon.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login (chavez auth login)");
  process.exit(1);
}

const bindPath = cwdPath();

const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();

const db = await daemon.bind(bindPath, "daemon");
const wb = await web.bind(bindPath, "client");
if (!db.ok || !wb.ok) throw new Error(`bind fail ${db.error} ${wb.error}`);
console.log("daemon bound", (db.data as { clientKind?: string }).clientKind);
const dbData = db.data as { hostname?: string; role?: string };
if (!dbData.hostname) throw new Error("bind hostname missing");
if (dbData.role !== "primary") {
  throw new Error(`expected primary role, got ${dbData.role}`);
}

const gotAppend = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no message.appended")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "message.appended") {
      clearTimeout(t);
      console.log("daemon got push", msg.type);
      resolve();
    }
  });
});

const session = await web.request({
  type: "session.create",
  title: "sync-smoke",
});
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "sync-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const append = await web.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "hello from web",
});
if (!append.ok) throw new Error(append.error);
await gotAppend;

const gotDispatch = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no agent.turn.dispatch")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "agent.turn.dispatch") {
      clearTimeout(t);
      console.log(
        "daemon got dispatch",
        (msg.data as { prompt?: string }).prompt,
      );
      resolve();
    }
  });
});

const turn = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ping turn",
});
if (!turn.ok) throw new Error(`turn failed: ${turn.error}`);
console.log("turn accepted", turn.data);
await gotDispatch;

daemon.close();
web.close();
console.log("SMOKE PASS");
