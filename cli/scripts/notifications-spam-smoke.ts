/**
 * Gherkin: Sin spam + Turn done.
 * A publica start + 40 deltas + end. B reduce. Store = 1 turn_done.
 * Watch-like log length = 42. Cero OS.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import {
  emptyNotificationState,
  reduceNotification,
} from "../src/notifications/store";
import { shouldShowTuiBadge } from "../src/notifications/classify";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const a = new ChavezWsClient(token);
const b = new ChavezWsClient(token);
await a.connect();
await b.connect();

const session = await a.request({ type: "session.create", title: "notice-spam" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await a.request({ type: "chat.create", sessionId, title: "notice-spam-chat" });
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;
const streamId = crypto.randomUUID();

let s = emptyNotificationState();
const printed: string[] = [];
const done = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no stream.end within 8s")), 8000);
  b.onPush((msg) => {
    printed.push(JSON.stringify({ type: msg.type, data: msg.data }));
    s = reduceNotification(
      s,
      { type: msg.type, data: msg.data },
      { surface: "tui", activeChatId: "i-am-elsewhere", now: Date.now() },
    ).state;
    if (msg.type === "chat.stream.end") {
      clearTimeout(t);
      resolve();
    }
  });
});

await a.request({ type: "chat.stream.start", chatId, streamId });
for (let i = 0; i < 40; i++) {
  await a.request({ type: "chat.stream.delta", chatId, streamId, delta: "x" });
}
await a.request({ type: "chat.stream.end", chatId, streamId, content: "ok" });
await done;

if (s.items.length !== 1) throw new Error(`store size ${s.items.length} want 1`);
if (s.items[0].kind !== "turn_done") throw new Error(s.items[0].kind);
if (!shouldShowTuiBadge(s.items[0], "i-am-elsewhere")) {
  throw new Error("TUI must badge the other chat");
}
if (shouldShowTuiBadge(s.items[0], chatId)) {
  throw new Error("TUI must not badge the open chat");
}
const deltas = printed.filter((l) => l.includes("chat.stream.delta"));
if (deltas.length < 40) throw new Error(`watch-like log lost deltas: ${deltas.length}`);

a.close();
b.close();
console.log("SMOKE PASS notifications-spam (1 notice, 40 logged deltas)");
