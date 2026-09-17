/**
 * Smoke: tool start/result persist + fan-out; no-daemon; busy; append does not emit tools.
 * Requires API + token (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { formatWatchLine } from "../src/llm/watch-format";

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

const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
if (!db.ok || !wb.ok) throw new Error(`bind fail ${db.error} ${wb.error}`);

const session = await web.request({ type: "session.create", title: "tools-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "tools-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seen: string[] = [];
const gotThree = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout seen=${seen.join(",")}`)), 8000);
  web.onPush((msg) => {
    const data = msg.data as { chatId?: string; message?: { role?: string } };
    if (data?.chatId && data.chatId !== chatId) return;
    const line = formatWatchLine({ type: msg.type, data: msg.data });
    if (line) seen.push(line.split("\n")[0]!);
    if (
      seen.some((l) => l.includes("tool · read · running")) &&
      seen.some((l) => l.includes("tool · read · done")) &&
      seen.some((l) => l.startsWith("assistant:"))
    ) {
      clearTimeout(t);
      resolve();
    }
  });
});

const toolCallId = crypto.randomUUID();
const streamId = crypto.randomUUID();

const start = await daemon.request({
  type: "chat.tool.start",
  chatId,
  streamId,
  toolCallId,
  toolName: "read",
  content: "tool · read · running  README.md",
  metadata: {
    sdkName: "Read",
    input: { file_path: "README.md" },
    streamId,
  },
});
if (!start.ok) throw new Error(start.error);

const result = await daemon.request({
  type: "chat.tool.result",
  chatId,
  streamId,
  toolCallId,
  toolName: "read",
  status: "done",
  content: "# hello from workspace file",
});
if (!result.ok) throw new Error(result.error);

const end = await daemon.request({
  type: "chat.stream.start",
  chatId,
  streamId,
});
if (!end.ok) throw new Error(end.error);
await daemon.request({
  type: "chat.stream.end",
  chatId,
  streamId,
  content: "El README presenta el repo.",
});

await gotThree;

const got = await web.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const messages = (got.data as { messages: Array<{ role: string; metadata?: Record<string, unknown> | null; content: string }> }).messages;
const tools = messages.filter((m) => m.role === "tool");
if (tools.length !== 1) throw new Error(`expected 1 tool row, got ${tools.length}`);
if (tools[0]!.metadata?.status !== "done") throw new Error("tool not done after reload payload");
if (tools[0]!.metadata?.toolName !== "read") throw new Error("canonical name missing");
if (!String(tools[0]!.metadata?.output || tools[0]!.content).includes("hello from workspace")) {
  throw new Error("tool output missing");
}
const last = messages[messages.length - 1]!;
if (last.role !== "assistant") throw new Error("assistant should follow tools");
console.log("persist sequence OK", messages.map((m) => m.role).join(" → "));

const awaitingId = crypto.randomUUID();
const updStart = await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId: awaitingId,
  toolName: "write",
  content: "tool · write · running  NOTES.md",
  metadata: { sdkName: "Write", input: { file_path: "NOTES.md" } },
});
if (!updStart.ok) throw new Error(updStart.error);
const upd = await daemon.request({
  type: "chat.tool.update",
  chatId,
  toolCallId: awaitingId,
  status: "awaiting_approval",
});
if (!upd.ok) throw new Error(upd.error);
const mid = await web.request({ type: "chat.get", chatId });
const awaiting = (mid.data as { messages: Array<{ metadata?: Record<string, unknown> | null }> }).messages.find(
  (m) => m.metadata?.toolCallId === awaitingId,
);
if (awaiting?.metadata?.status !== "awaiting_approval") {
  throw new Error("awaiting_approval not persisted");
}
console.log("awaiting_approval OK");

const huge = "H".repeat(20_000);
const grepId = crypto.randomUUID();
await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId: grepId,
  toolName: "grep",
  metadata: { sdkName: "Grep", input: { pattern: "device code" } },
});
await daemon.request({
  type: "chat.tool.result",
  chatId,
  toolCallId: grepId,
  toolName: "grep",
  status: "done",
  content: huge,
});
const afterHuge = await web.request({ type: "chat.get", chatId });
const grepRow = (afterHuge.data as { messages: Array<{ metadata?: Record<string, unknown> | null; content: string }> }).messages.find(
  (m) => m.metadata?.toolCallId === grepId,
);
if (!grepRow) throw new Error("grep row missing");
if (grepRow.content.length >= 20_000) throw new Error("output was not truncated at API");
if (!grepRow.content.includes("[truncated:")) throw new Error("truncation marker missing");
console.log("truncate OK", grepRow.content.length);

const append = await web.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "nota humana, no tools",
});
if (!append.ok) throw new Error(append.error);
const afterAppend = await web.request({ type: "chat.get", chatId });
const roles = (afterAppend.data as { messages: Array<{ role: string; content: string }> }).messages;
const lastMsg = roles[roles.length - 1]!;
if (lastMsg.role !== "user" || lastMsg.content !== "nota humana, no tools") {
  throw new Error("append should be user, not a tool");
}
console.log("append does not emit tools OK");

const failId = crypto.randomUUID();
const failStream = crypto.randomUUID();
await daemon.request({
  type: "chat.tool.start",
  chatId,
  streamId: failStream,
  toolCallId: failId,
  toolName: "bash",
  metadata: { sdkName: "Bash", input: { command: "false" }, streamId: failStream },
});
await daemon.request({
  type: "chat.stream.error",
  chatId,
  streamId: failStream,
  content: "provider cut",
});
const afterFail = await web.request({ type: "chat.get", chatId });
const failed = (afterFail.data as { messages: Array<{ metadata?: Record<string, unknown> | null }> }).messages.find(
  (m) => m.metadata?.toolCallId === failId,
);
if (failed?.metadata?.status !== "error") {
  throw new Error("running tool should fail when stream errors");
}
console.log("fail in-flight OK");

daemon.close();
web.close();

const orphan = new ChavezWsClient(token);
await orphan.connect();
await orphan.bind(path, "client");
const noDaemon = await orphan.request({
  type: "agent.turn.request",
  chatId,
  prompt: "lee el README",
});
if (noDaemon.ok) throw new Error("expected no-daemon fail");
if (noDaemon.error !== "No daemon bound for this workspace. Run: chavez headless workspace open") {
  throw new Error(`unexpected no-daemon error: ${noDaemon.error}`);
}
const afterNo = await orphan.request({ type: "chat.get", chatId });
const extraTools = (afterNo.data as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === "tool");
if (extraTools.length !== 4) {
  throw new Error(`no-daemon must not create tool rows, got ${extraTools.length}`);
}
orphan.close();
console.log("no daemon OK");

console.log("TOOLS SMOKE PASS");
