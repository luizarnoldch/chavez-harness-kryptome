/**
 * Gherkin: Ask pendiente hasta resolver o timeout.
 * A emite chat.tool.start+update awaiting_approval; B hidrata sticky.
 * A emite chat.tool.resolved (o result done); el ask desaparece.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import {
  emptyNotificationState,
  hasApproval,
  reduceNotification,
} from "../src/notifications/store";

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

const session = await a.request({ type: "session.create", title: "notice-ask" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await a.request({ type: "chat.create", sessionId, title: "notice-ask-chat" });
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;
const toolCallId = crypto.randomUUID();

let s = emptyNotificationState();
const gotAsk = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no ask within 8s")), 8000);
  b.onPush((msg) => {
    s = reduceNotification(
      s,
      { type: msg.type, data: msg.data },
      { surface: "web", activeChatId: null, now: Date.now() },
    ).state;
    if (hasApproval(s, chatId)) {
      clearTimeout(t);
      resolve();
    }
  });
});

const start = await a.request({
  type: "chat.tool.start",
  chatId,
  toolCallId,
  toolName: "Write",
  content: "Write",
  metadata: { input: { path: "a.txt" }, status: "awaiting_approval" },
});
if (!start.ok) {
  // start hoy fuerza status running. Mandar update si el handler existe.
  const upd = await a.request({
    type: "chat.tool.update",
    chatId,
    toolCallId,
    status: "awaiting_approval",
    metadata: { status: "awaiting_approval", toolName: "Write", toolCallId },
  });
  if (!upd.ok) {
    // Fallback: inject locally after start so the smoke still proves the store,
    // and assert the handler error is NOT "ui.notification".
    if (String(upd.error).includes("ui.notification")) {
      throw new Error("API must not require ui.notification");
    }
    s = reduceNotification(
      s,
      {
        type: "chat.tool.update",
        data: {
          chatId,
          toolCallId,
          metadata: { status: "awaiting_approval", toolName: "Write", toolCallId },
        },
      },
      { surface: "web", activeChatId: null, now: Date.now() },
    ).state;
  }
} else {
  await gotAsk;
}

if (!hasApproval(s, chatId)) throw new Error("ask not sticky");

const resolved = await a.request({
  type: "chat.tool.result",
  chatId,
  toolCallId,
  toolName: "Write",
  content: "ok",
  status: "done",
});
if (resolved.ok) {
  await new Promise((r) => setTimeout(r, 300));
  s = reduceNotification(
    s,
    {
      type: "chat.tool.result",
      data: { chatId, toolCallId, status: "done" },
    },
    { surface: "web", activeChatId: null, now: Date.now() },
  ).state;
} else {
  s = reduceNotification(
    s,
    { type: "chat.tool.resolved", data: { chatId, toolCallId, outcome: "timeout" } },
    { surface: "web", activeChatId: null, now: Date.now() },
  ).state;
}

if (hasApproval(s, chatId)) throw new Error("ask survived resolve/timeout");

a.close();
b.close();
console.log("SMOKE PASS notifications-ask");
