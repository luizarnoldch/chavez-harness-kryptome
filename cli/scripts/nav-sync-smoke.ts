/**
 * Smoke: remote session.created / chat.created reach a daemon-bound client
 * (same path the TUI uses for list sync).
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
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

const gotSession = new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no session.created")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "session.created") {
      clearTimeout(t);
      const id = (msg.data as { session?: { id: string } })?.session?.id;
      if (!id) reject(new Error("session.created without id"));
      else resolve(id);
    }
  });
});

const session = await web.request({
  type: "session.create",
  title: "nav-sync-session",
});
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const pushedSessionId = await gotSession;
if (pushedSessionId !== sessionId) {
  throw new Error("session id mismatch");
}
console.log("session.created OK", sessionId.slice(0, 8));

const gotChat = new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no chat.created")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "chat.created") {
      clearTimeout(t);
      const chat = (msg.data as { chat?: { id: string; sessionId: string } })
        ?.chat;
      if (!chat) reject(new Error("chat.created without chat"));
      else resolve(chat.id);
    }
  });
});

const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "nav-sync-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;
const pushedChatId = await gotChat;
if (pushedChatId !== chatId) throw new Error("chat id mismatch");
console.log("chat.created OK", chatId.slice(0, 8));

const list = await daemon.request({ type: "session.list" });
if (!list.ok) throw new Error(list.error);
const sessions =
  (list.data as { sessions?: Array<{ id: string }> })?.sessions ?? [];
if (!sessions.some((s) => s.id === sessionId)) {
  throw new Error("session.list missing new session");
}

const chats = await daemon.request({ type: "chat.list", sessionId });
if (!chats.ok) throw new Error(chats.error);
const chatRows =
  (chats.data as { chats?: Array<{ id: string }> })?.chats ?? [];
if (!chatRows.some((c) => c.id === chatId)) {
  throw new Error("chat.list missing new chat");
}

daemon.close();
web.close();
console.log("NAV SYNC SMOKE PASS");
