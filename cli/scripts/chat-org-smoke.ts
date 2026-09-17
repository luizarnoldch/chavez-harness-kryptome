/**
 * Smoke: autotitle, pin sync, archive filter, search skips tool output, move same workspace.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  CHAT_UPDATED_EVENT,
  DEFAULT_CHAT_TITLE,
  displayChatTitle,
} from "../src/chats/org";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

const path = cwdPath();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
if (!db.ok || !wb.ok) throw new Error(`bind fail ${db.error} ${wb.error}`);

function waitPush(client: ChavezWsClient, type: string, timeout = 8000) {
  return new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type}`)), timeout);
    const off = client.onPush((msg) => {
      if (msg.type === type) {
        clearTimeout(t);
        off();
        resolve(msg.data);
      }
    });
  });
}

const session = await web.request({ type: "session.create", title: "org-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;

const otherSession = await web.request({
  type: "session.create",
  title: "org-smoke-2",
});
if (!otherSession.ok) throw new Error(otherSession.error);
const sessionId2 = (otherSession.data as { session: { id: string } }).session.id;

const chatRes = await web.request({ type: "chat.create", sessionId });
if (!chatRes.ok) throw new Error(chatRes.error);
const chat = (chatRes.data as { chat: { id: string; title: string; titleSource: string } }).chat;
if (chat.title !== DEFAULT_CHAT_TITLE) throw new Error(`expected default title, got ${chat.title}`);
if (chat.titleSource !== "default") throw new Error("titleSource default");

// Autotitle: primer user + primer assistant via stream.end
const append = await web.request({
  type: "chat.append",
  chatId: chat.id,
  role: "user",
  content: "Rewrite the login form validation",
});
if (!append.ok) throw new Error(append.error);

const titled = waitPush(daemon, CHAT_UPDATED_EVENT);
const end = await web.request({
  type: "chat.stream.end",
  chatId: chat.id,
  streamId: crypto.randomUUID(),
  content: "Done with the login form.",
});
if (!end.ok) throw new Error(end.error);
const updated = (await titled) as { chat: { title: string; titleSource: string; id: string } };
if (updated.chat.id !== chat.id) throw new Error("autotitle wrong chat");
if (updated.chat.titleSource !== "auto") throw new Error("expected auto");
if (updated.chat.title === chat.id || updated.chat.title === DEFAULT_CHAT_TITLE) {
  throw new Error(`title still placeholder: ${updated.chat.title}`);
}
if (!/login form/i.test(updated.chat.title)) {
  throw new Error(`autotitle missed prompt: ${updated.chat.title}`);
}
console.log("autotitle OK", displayChatTitle(updated.chat));

// Pin on web → daemon sees chat.updated
const pinPush = waitPush(daemon, CHAT_UPDATED_EVENT);
const pin = await web.request({
  type: "chat.update",
  chatId: chat.id,
  pinned: true,
});
if (!pin.ok) throw new Error(pin.error);
const pinned = (await pinPush) as { chat: { pinnedAt: string | null } };
if (!pinned.chat.pinnedAt) throw new Error("pin not synced to daemon socket");
const listed = await daemon.request({ type: "chat.list", sessionId });
const chats = (listed.data as { chats: Array<{ id: string; pinnedAt: string | null }> }).chats;
if (chats[0]?.id !== chat.id || !chats[0]?.pinnedAt) throw new Error("pin did not rise");
console.log("pin sync OK");

// Archive hides
await web.request({ type: "chat.update", chatId: chat.id, archived: true });
const hidden = await daemon.request({ type: "chat.list", sessionId });
const visible = (hidden.data as { chats: Array<{ id: string }> }).chats;
if (visible.some((c) => c.id === chat.id)) throw new Error("archived still listed");
const onlyArch = await daemon.request({
  type: "chat.list",
  sessionId,
  archivedOnly: true,
});
const archRows = (onlyArch.data as { chats: Array<{ id: string }> }).chats;
if (!archRows.some((c) => c.id === chat.id)) throw new Error("archivedOnly missed chat");
await web.request({ type: "chat.update", chatId: chat.id, archived: false });
console.log("archive filter OK");

// Search: title/message hit; tool output secret not indexed
const secretChat = await web.request({
  type: "chat.create",
  sessionId,
  title: "unrelated",
});
const secretId = (secretChat.data as { chat: { id: string } }).chat.id;
await web.request({
  type: "chat.append",
  chatId: secretId,
  role: "tool",
  content: "sk-ant-secret-token-value",
  metadata: { toolName: "Grep", output: "sk-ant-secret-token-value", secret: true },
});
const miss = await daemon.request({
  type: "chat.search",
  query: "sk-ant-secret-token-value",
});
const missChats = (miss.data as { chats: Array<{ id: string }> }).chats ?? [];
if (missChats.some((c) => c.id === secretId)) {
  throw new Error("search indexed secret tool output");
}
const hit = await daemon.request({
  type: "chat.search",
  query: "login form",
});
const hitChats = (hit.data as { chats: Array<{ id: string }> }).chats ?? [];
if (!hitChats.some((c) => c.id === chat.id)) throw new Error("search missed title/message");
console.log("search skip tool secrets OK");

// Move stays in workspace
const moved = await web.request({
  type: "chat.update",
  chatId: chat.id,
  sessionId: sessionId2,
});
if (!moved.ok) throw new Error(moved.error);
const movedChat = (moved.data as { chat: { sessionId: string } }).chat;
if (movedChat.sessionId !== sessionId2) throw new Error("move failed");
console.log("move same workspace OK");

daemon.close();
web.close();
console.log("chat-org-smoke OK");
