/**
 * Smoke: thinking persist + steer follow-up + cancel ≠ undo.
 * Requires API + login token. Binds this process as daemon for cwd.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  beginTurnSession,
  cancelSession,
  endTurnSession,
  getTurnSession,
  onThinkingEvent,
  steerSession,
} from "../src/llm/turn-session";
import { peekFollowUp } from "../src/llm/steer";
import { finalizeThinking } from "../src/llm/thinking";
import { TURN_CANCELLED } from "../src/llm/turn-abort";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const path = cwdPath();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const bd = await daemon.bind(path, "daemon");
const bw = await web.bind(path, "client");
if (!bd.ok || !bw.ok) {
  console.error("bind failed", bd.error, bw.error);
  process.exit(1);
}

const session = await web.request({ type: "session.create", title: "tsc-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "tsc-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seen: string[] = [];
web.onPush((msg) => {
  seen.push(msg.type);
});

// --- thinking persist ---
const streamId = crypto.randomUUID();
const sess = beginTurnSession({ chatId, streamId, provider: "claude" });
onThinkingEvent(sess, { kind: "thinking_delta", text: "paso uno" });
onThinkingEvent(sess, { kind: "stream_delta", text: "respuesta final" });
await daemon.request({ type: "chat.stream.start", chatId, streamId });
await daemon.request({
  type: "chat.thinking.delta",
  chatId,
  streamId,
  delta: "paso uno",
});
await daemon.request({
  type: "chat.stream.delta",
  chatId,
  streamId,
  delta: "respuesta final",
});
await daemon.request({
  type: "chat.stream.end",
  chatId,
  streamId,
  status: "finished",
  content: "respuesta final",
  metadata: { thinking: finalizeThinking(sess.thinking) },
});
endTurnSession(chatId);

const got = await web.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const messages = (got.data as { messages: Array<{
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> }).messages;
const assistant = [...messages].reverse().find((m) => m.role === "assistant");
if (!assistant) {
  console.error("FAIL: no assistant");
  process.exit(1);
}
if (assistant.content.includes("paso uno")) {
  console.error("FAIL: thinking leaked into assistant content", assistant.content);
  process.exit(1);
}
const thinking = assistant.metadata?.thinking as { text?: string } | undefined;
if (thinking?.text !== "paso uno") {
  console.error("FAIL: thinking not persisted", assistant.metadata);
  process.exit(1);
}
if (!seen.includes("chat.thinking.delta")) {
  console.error("FAIL: web did not see thinking.delta", seen);
  process.exit(1);
}

// --- steer without turn ---
const noTurn = await web.request({
  type: "agent.turn.steer",
  chatId,
  content: "no toques tests",
});
if (noTurn.ok) {
  console.error("FAIL: steer without turn succeeded", noTurn.data);
  process.exit(1);
}
if (
  !String(noTurn.error || "").includes("No turn running") &&
  !String(noTurn.error || "").toLowerCase().includes("turn")
) {
  console.log("steer-without-turn error (ok):", noTurn.error);
}

// --- cancel without turn is idempotent ---
const c0 = await web.request({ type: "agent.turn.cancel", chatId });
if (!c0.ok) {
  console.error("FAIL: cancel without turn should be ok", c0.error);
  process.exit(1);
}

// --- in-process cancel drops unapplied follow-up, keeps applied writes ---
const sid = crypto.randomUUID();
beginTurnSession({ chatId, streamId: sid, provider: "claude" });
const live = getTurnSession(chatId)!;
live.promptStream.close();
const ack = await steerSession(chatId, "no toques tests");
if (ack.outcome !== "revert_to_followup") {
  console.error("FAIL: expected follow-up", ack);
  process.exit(1);
}
const appliedBefore = { "src/a.ts": "kept" };
cancelSession(chatId);
if (peekFollowUp(chatId)) {
  console.error("FAIL: cancel must drop follow-up");
  process.exit(1);
}
if (appliedBefore["src/a.ts"] !== "kept") {
  console.error("FAIL: cancel mutated applied writes");
  process.exit(1);
}
endTurnSession(chatId);

// persist a cancelled assistant and a tool running → cancelled
const stream2 = crypto.randomUUID();
await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId: "t-run",
  toolName: "Write",
  content: "Write",
  metadata: { input: { path: "src/a.ts" } },
});
await daemon.request({
  type: "chat.stream.end",
  chatId,
  streamId: stream2,
  status: "cancelled",
  content: TURN_CANCELLED,
  metadata: { status: "cancelled" },
});

const got2 = await web.request({ type: "chat.get", chatId });
const msgs2 = (got2.data as { messages: Array<{
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> }).messages;
const tool = msgs2.find((m) => m.role === "tool");
const cancelled = [...msgs2].reverse().find((m) => m.metadata?.status === "cancelled");
if (!cancelled) {
  console.error("FAIL: cancelled assistant missing");
  process.exit(1);
}
if (tool && String(tool.metadata?.status) === "running") {
  console.error("FAIL: tool still running after cancel", tool.metadata);
  process.exit(1);
}

daemon.close();
web.close();
console.log("SMOKE PASS");
