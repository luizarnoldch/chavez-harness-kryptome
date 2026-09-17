/**
 * Smoke: two WS clients — append on A, push received on B.
 * Requires API + logged-in token in ~/.chavez/config.json or CHAVEZ_ACCESS_TOKEN.
 */
import { loadConfig } from "../src/config";
import { NO_DAEMON_ERROR } from "../src/ws/presence-constants";
import { ChavezWsClient } from "../src/ws/client";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const path = process.cwd().replace(/\\/g, "/");

const a = new ChavezWsClient(token);
const b = new ChavezWsClient(token);
await a.connect();
await b.connect();
const ba = await a.bind(path, "client");
const bb = await b.bind(path, "client");
if (!ba.ok || !bb.ok) throw new Error("bind failed");

const got = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no push within 5s")), 5000);
  b.onPush((msg) => {
    if (msg.type === "message.appended") {
      clearTimeout(t);
      console.log("B received", msg.type, msg.data);
      resolve();
    }
  });
});

const session = await a.request({ type: "session.create", title: "smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await a.request({
  type: "chat.create",
  sessionId,
  title: "smoke-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const append = await a.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "hello sync",
});
if (!append.ok) throw new Error(append.error);

await got;

const turn = await a.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ping",
});
console.log(
  "agent.turn.request (expect fail without daemon):",
  turn.ok ? turn.data : turn.error,
);

const reviewTurn = await a.request({
  type: "agent.turn.request",
  chatId,
  prompt: "review",
  metadata: { kind: "code_review" },
});
if (reviewTurn.ok || reviewTurn.error !== NO_DAEMON_ERROR) {
  throw new Error(
    `code review expected ${NO_DAEMON_ERROR}, got ${
      reviewTurn.ok ? JSON.stringify(reviewTurn.data) : reviewTurn.error
    }`,
  );
}

a.close();
b.close();
console.log("SMOKE PASS (broadcast ok)");
