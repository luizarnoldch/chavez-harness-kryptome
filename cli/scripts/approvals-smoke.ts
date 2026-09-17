/**
 * Smoke: first-wins ya resuelto, timeout visible, headless no auto-approve,
 * prompt has path+diff, reads never await.
 * Needs: chavez login, API up. This process binds as daemon.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  ALREADY_RESOLVED_ERROR,
  ASK_APPROVAL_TIMEOUT_MS,
  HEADLESS_WAITING,
} from "../src/llm/approval-constants";
import { waitForApproval, resolveApproval } from "../src/llm/tool-approval";
import { buildApprovalPrompt } from "../src/llm/approval-prompt";
import { decideCanUseTool } from "../src/llm/can-use-tool";
import { handleToolResolutionPush } from "../src/llm/handle-tool-resolution";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

// --- reads never ask (local, no WS) ---
{
  const cwd = mkdtempSync(join(tmpdir(), "chavez-appr-"));
  writeFileSync(join(cwd, "in.txt"), "ok");
  let called = false;
  const r = await decideCanUseTool({
    cwd,
    toolName: "Read",
    toolInput: { file_path: join(cwd, "in.txt") },
    executionMode: "ask",
    ask: async () => {
      called = true;
      return "approve";
    },
  });
  if (r.behavior !== "allow" || called) fail("reads must not go through approval");
  if (buildApprovalPrompt("Read", { file_path: "in.txt" }) !== null) {
    fail("read prompt must be null");
  }
  const w = buildApprovalPrompt("Write", {
    file_path: "NOTES.md",
    content: "hi",
  });
  if (!w || w.kind !== "write" || !w.diff.includes("NOTES.md")) {
    fail("write prompt must show path + diff");
  }
  const b = buildApprovalPrompt("Bash", { command: "ls" });
  if (!b || b.kind !== "bash" || b.command !== "ls") {
    fail("bash prompt must show command");
  }
  console.log("ok reads-and-prompt");
}

// --- first-wins waiter (in-process) ---
{
  const p = waitForApproval("smoke-t1", "smoke-c", { timeoutMs: 5_000 });
  if (!resolveApproval("smoke-t1", "approve")) fail("first resolve must win");
  if ((await p) !== "approve") fail("waiter outcome");
  if (resolveApproval("smoke-t1", "deny")) fail("second resolve must lose");
  console.log("ok waiter-first-wins");
}

// --- timeout does not auto-approve ---
{
  const p = waitForApproval("smoke-t2", "smoke-c", { timeoutMs: 30 });
  const outcome = await p;
  if (outcome !== "timeout") fail(`expected timeout, got ${outcome}`);
  console.log("ok timeout-denies");
}

// --- WS: two clients, CAS ya resuelto ---
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
const watch = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
await watch.connect();
const bindPath = cwdPath();
const db = await daemon.bind(bindPath, "daemon");
if (!db.ok) fail(db.error || "daemon bind");
const wb = await web.bind(bindPath, "client");
if (!wb.ok) fail(wb.error || "web bind");
const wtb = await watch.bind(bindPath, "client");
if (!wtb.ok) fail(wtb.error || "watch bind");

const sessions = await web.request({ type: "session.list" });
if (!sessions.ok) fail(sessions.error || "session.list");
let sessionId = (sessions.data as { sessions?: { id: string }[] })?.sessions?.[0]
  ?.id;
if (!sessionId) {
  const created = await web.request({
    type: "session.create",
    title: "approvals-smoke",
  });
  if (!created.ok) fail(created.error || "session.create");
  sessionId = (created.data as { session: { id: string } }).session.id;
}
const chatRes = await web.request({
  type: "chat.create",
  sessionId,
  title: "approvals-smoke",
});
if (!chatRes.ok) fail(chatRes.error || "chat.create");
const chatId = (chatRes.data as { chat: { id: string } }).chat.id;

const toolCallId = crypto.randomUUID();
const start = await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId,
  toolName: "write",
  status: "awaiting_approval",
  metadata: {
    sdkName: "Write",
    status: "awaiting_approval",
    approvalDeadline: new Date(Date.now() + ASK_APPROVAL_TIMEOUT_MS).toISOString(),
    remainingMs: ASK_APPROVAL_TIMEOUT_MS,
    prompt: {
      kind: "write",
      path: "NOTES.md",
      diff: "+++ b/NOTES.md\n+hello",
      truncated: false,
    },
  },
});
if (!start.ok) {
  const upd = await daemon.request({
    type: "chat.tool.update",
    chatId,
    toolCallId,
    toolName: "write",
    status: "awaiting_approval",
    metadata: {
      sdkName: "Write",
      status: "awaiting_approval",
      approvalDeadline: new Date(
        Date.now() + ASK_APPROVAL_TIMEOUT_MS,
      ).toISOString(),
      prompt: {
        kind: "write",
        path: "NOTES.md",
        diff: "+++ b/NOTES.md\n+hello",
        truncated: false,
      },
    },
  });
  if (!upd.ok) fail(upd.error || "could not persist awaiting_approval");
}

const waiter = waitForApproval(toolCallId, chatId, { timeoutMs: 8_000 });
daemon.onPush((msg) => {
  handleToolResolutionPush(msg);
});

const first = await web.request({
  type: "agent.tool.approve",
  chatId,
  toolCallId,
});
if (!first.ok) fail(`first approve should win: ${first.error}`);

const second = await watch.request({
  type: "agent.tool.approve",
  chatId,
  toolCallId,
});
if (second.ok) fail("second approve must fail");
if (!String(second.error || "").includes(ALREADY_RESOLVED_ERROR)) {
  fail(`second error should include ya resuelto, got ${second.error}`);
}
const outcome = await waiter;
if (outcome !== "approve") fail(`daemon waiter got ${outcome}`);
console.log("ok first-wins-ya-resuelto");

console.error(HEADLESS_WAITING);
console.log("ok headless-waiting-log");

daemon.close();
web.close();
watch.close();
console.log("SMOKE PASS");
