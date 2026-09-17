/**
 * Live attach smoke.
 * Requires: API up, CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json, Claude linked.
 * This script binds as daemon so fs.complete and turns run in-process.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { completeWorkspace } from "../src/llm/fs-complete";
import { historyFromChatMessages } from "../src/llm/history";
import { publishAgentTurn } from "../src/llm/publish-turn";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const bindPath = cwdPath();
const daemon = new ChavezWsClient(token);
const client = new ChavezWsClient(token);
await daemon.connect();
await client.connect();
const bound = await daemon.bind(bindPath, "daemon");
if (!bound.ok) throw new Error(bound.error || "daemon bind failed");
const clientBind = await client.bind(bindPath, "client");
if (!clientBind.ok) throw new Error(clientBind.error || "client bind failed");

daemon.onPush(async (msg) => {
  if (msg.type !== "fs.complete.dispatch") return;
  const data = (msg.data || {}) as {
    requestId?: string;
    query?: string;
    path?: string;
  };
  if (!data.requestId) return;
  const candidates = completeWorkspace(
    data.path || bindPath,
    data.query || "",
    10,
  );
  await daemon.request({
    type: "fs.complete.result",
    requestId: data.requestId,
    hostname: hostname(),
    path: bindPath,
    metadata: { cwd: data.path || bindPath, candidates },
  });
});

const session = await client.request({ type: "session.create", title: "attach-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await client.request({
  type: "chat.create",
  sessionId,
  title: "attach-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const complete = await client.request({
  type: "fs.complete",
  chatId,
  query: "package",
});
if (!complete.ok) throw new Error(complete.error || "fs.complete failed");
const data = complete.data as {
  hostname?: string;
  cwd?: string;
  candidates?: Array<{ path: string; isDir: boolean }>;
};
assert.ok(data.hostname && data.hostname.length > 0, "hostname");
assert.ok((data.candidates || []).length <= 10, "max 10");
assert.ok(
  (data.candidates || []).every((c) => !c.path.includes("..")),
  "no escapes",
);
console.log("fs.complete OK", data.hostname, data.candidates?.slice(0, 3));

await publishAgentTurn({
  client: daemon,
  chatId,
  prompt: "Responde solo pong. Contexto: @package.json",
  cwd: bindPath,
  token,
});
const afterOk = await client.request({ type: "chat.get", chatId });
const msgs = (
  afterOk.data as {
    messages: Array<{
      role: string;
      content: string;
      metadata?: { attachments?: Array<{ path: string; kind: string; status: string }> };
    }>;
  }
).messages;
const userOk = [...msgs].reverse().find((m) => m.role === "user");
assert.ok(userOk?.content.includes("@package.json"));
assert.equal(userOk?.metadata?.attachments?.[0]?.path, "package.json");
assert.equal(userOk?.metadata?.attachments?.[0]?.status, "ok");
console.log("hydrate text attach OK");

let missingErr = "";
try {
  await publishAgentTurn({
    client: daemon,
    chatId,
    prompt: "lee @no-existe-xyz.ts",
    cwd: bindPath,
    token,
  });
} catch (e) {
  missingErr = e instanceof Error ? e.message : String(e);
}
assert.match(missingErr, /not found|no-existe/i);
const afterMiss = await client.request({ type: "chat.get", chatId });
const missUser = (
  afterMiss.data as {
    messages: Array<{ role: string; metadata?: { attachments?: Array<{ status: string }> } }>;
  }
).messages
  .filter((m) => m.role === "user")
  .pop();
assert.equal(missUser?.metadata?.attachments?.[0]?.status, "missing");
console.log("missing path OK");

let escapeErr = "";
try {
  await publishAgentTurn({
    client: daemon,
    chatId,
    prompt: "lee @../../.ssh/id_rsa",
    cwd: bindPath,
    token,
  });
} catch (e) {
  escapeErr = e instanceof Error ? e.message : String(e);
}
assert.match(escapeErr, /outside workspace|forbidden/i);
console.log("path escape OK");

await publishAgentTurn({
  client: daemon,
  chatId,
  prompt: "hola user@example.com no es un attach",
  cwd: bindPath,
  token,
});
const afterMail = await client.request({ type: "chat.get", chatId });
const mailUser = (
  afterMail.data as {
    messages: Array<{
      role: string;
      content: string;
      metadata?: { attachments?: unknown[] };
    }>;
  }
).messages
  .filter((m) => m.role === "user")
  .pop();
assert.ok(mailUser?.content.includes("user@example.com"));
assert.ok(!mailUser?.metadata?.attachments?.length);
console.log("email not attach OK");

const markerDir = join(bindPath, ".chavez-attach-smoke");
mkdirSync(markerDir, { recursive: true });
const markerFile = join(markerDir, "MARK.txt");
writeFileSync(markerFile, "MARKER=attach-smoke-42\n");
await publishAgentTurn({
  client: daemon,
  chatId,
  prompt: "memoriza el attach @.chavez-attach-smoke/MARK.txt",
  cwd: bindPath,
  token,
});
writeFileSync(markerFile, "MARKER=CHANGED-ON-DISK\n");
const snap = await client.request({ type: "chat.get", chatId });
const hist = historyFromChatMessages(
  (
    snap.data as {
      messages: Array<{
        role?: string;
        content?: string;
        metadata?: Record<string, unknown> | null;
      }>;
    }
  ).messages,
  "follow-up",
);
assert.match(hist.map((h) => h.content).join("\n"), /attach-smoke-42/);
assert.doesNotMatch(hist.map((h) => h.content).join("\n"), /CHANGED-ON-DISK/);
console.log("snapshot not re-read OK");

daemon.close();
client.close();
console.log("ATTACH SMOKE PASS");
