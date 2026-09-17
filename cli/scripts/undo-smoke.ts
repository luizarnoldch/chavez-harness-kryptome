/**
 * Smoke: undo restores allowlisted files; no-git does not touch disk;
 * rejected-ask noop; second client sees chat.checkpoint.undone.
 * Requires API + token (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 */
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { createTurnCheckpoint, finalizeCheckpoint } from "../src/llm/git-checkpoint";
import { restoreTurn } from "../src/llm/git-restore";
import { runGit } from "../src/llm/git-exec";
import { handleUndoDispatch } from "../src/llm/run-undo";
import {
  SHELL_SIDE_EFFECT_WARNING,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "../src/llm/undo-constants";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-smoke-"));
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
  await runGit(cwd, ["config", "user.name", "Undo Bot"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  writeFileSync(join(cwd, "c.ts"), "c\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

// --- local git (no API) ---
{
  const cwd = await initRepo();
  const cp = await createTurnCheckpoint(cwd, "s-local");
  if (cp.kind !== "git") fail("expected git checkpoint");
  writeFileSync(join(cwd, "a.ts"), "two\n");
  writeFileSync(join(cwd, "b.ts"), "new\n");
  const fin = await finalizeCheckpoint(cwd, cp, { paths: ["a.ts", "b.ts"], hadBash: true });
  const out = await restoreTurn({ cwd, chatId: "c1", checkpoint: fin });
  if (readFileSync(join(cwd, "a.ts"), "utf8") !== "one\n") fail("a.ts not restored");
  if (existsSync(join(cwd, "b.ts"))) fail("b.ts should be deleted");
  if (readFileSync(join(cwd, "c.ts"), "utf8") !== "c\n") fail("c.ts should stay");
  if (!out.warning || !out.warning.includes("Unversioned shell")) {
    fail(`expected shell warning, got ${out.warning}`);
  }
  if (!out.warning.includes(SHELL_SIDE_EFFECT_WARNING.slice(0, 20))) {
    fail(`expected ${SHELL_SIDE_EFFECT_WARNING}, got ${out.warning}`);
  }
  console.log("ok local-restore-allowlist");
}

{
  const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-smoke-"));
  writeFileSync(join(cwd, "a.ts"), "hello\n");
  const out = await restoreTurn({
    cwd,
    chatId: "c1",
    checkpoint: {
      kind: "none",
      streamId: "s",
      reason: "not_git",
      headSha: null,
      commitSha: null,
      treeSha: null,
      branch: null,
      paths: ["a.ts"],
      commitsCreated: [],
      hadBash: false,
      appliedMutations: true,
      createdAt: new Date().toISOString(),
    },
  });
  if (out.message !== UNDO_REQUIRES_GIT) fail(out.message);
  if (out.diskTouched) fail("disk was touched without git");
  if (readFileSync(join(cwd, "a.ts"), "utf8") !== "hello\n") fail("nongit sentinel");
  console.log("ok no-git-disk-untouched");
}

// --- live WS: two clients, undo fan-out ---
const path = await initRepo();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
if (!db.ok || !wb.ok) fail(`bind fail ${db.error} ${wb.error}`);

daemon.onPush(async (msg) => {
  if (msg.type !== "agent.turn.undo.dispatch") return;
  await handleUndoDispatch({
    client: daemon,
    cwd: path,
    data: (msg.data || {}) as Parameters<typeof handleUndoDispatch>[0]["data"],
  });
});

const session = await web.request({ type: "session.create", title: "undo-smoke" });
if (!session.ok) fail(String(session.error));
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "undo-chat",
});
if (!chat.ok) fail(String(chat.error));
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seenUndone = new Promise<Record<string, unknown>>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no chat.checkpoint.undone")), 20_000);
  web.onPush((msg) => {
    if (msg.type !== "chat.checkpoint.undone") return;
    const data = (msg.data || {}) as { chatId?: string };
    if (data.chatId && data.chatId !== chatId) return;
    clearTimeout(t);
    resolve((msg.data || {}) as Record<string, unknown>);
  });
});

const streamId = crypto.randomUUID();
let cp = await createTurnCheckpoint(path, streamId);
writeFileSync(join(path, "a.ts"), "mutated\n");
writeFileSync(join(path, "b.ts"), "created-by-turn\n");
cp = await finalizeCheckpoint(path, cp, { paths: ["a.ts", "b.ts"], hadBash: false });

const append = await daemon.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "edit two files",
  metadata: { streamId, checkpoint: cp },
});
if (!append.ok) fail(String(append.error));
await daemon.request({
  type: "chat.checkpoint.finalized",
  chatId,
  streamId,
  checkpoint: cp,
});

const undo = await web.request({ type: "agent.turn.undo", chatId }, 30_000);
if (!undo.ok) fail(`undo rpc ${undo.error}`);
const undoneEv = await seenUndone;
if (readFileSync(join(path, "a.ts"), "utf8") !== "one\n") fail("live a.ts");
if (existsSync(join(path, "b.ts"))) fail("live b.ts");
console.log("ok web-undo-tui-sees-undone", undoneEv.streamId || streamId);

// noop: mark appliedMutations false on a second turn
const s2 = crypto.randomUUID();
let cp2 = await createTurnCheckpoint(path, s2);
cp2 = await finalizeCheckpoint(path, cp2, { paths: [], hadBash: false });
await daemon.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "solo lecturas",
  metadata: { streamId: s2, checkpoint: { ...cp2, appliedMutations: false } },
});
await daemon.request({
  type: "chat.checkpoint.finalized",
  chatId,
  streamId: s2,
  checkpoint: { ...cp2, appliedMutations: false, paths: [] },
});
const sentinel = readFileSync(join(path, "a.ts"), "utf8");
const noop = await web.request({ type: "agent.turn.undo", chatId }, 30_000);
if (!noop.ok) fail(`noop undo ${noop.error}`);
const nd = (noop.data || {}) as { noop?: boolean; message?: string };
if (!nd.noop) fail("expected noop for rejected/read-only turn");
if (!String(nd.message || "").includes("no applied changes")) fail(String(nd.message));
if (readFileSync(join(path, "a.ts"), "utf8") !== sentinel) fail("noop touched disk");
if (nd.message !== UNDO_NOOP && !String(nd.message).includes("no applied changes")) {
  fail(String(nd.message));
}
console.log("ok ask-rejected-noop");

// retry does not require tools
const retry = await web.request({ type: "agent.turn.retry", chatId }, 30_000);
if (!retry.ok) fail(`retry ${retry.error}`);
const rd = (retry.data || {}) as { accepted?: boolean; prompt?: string };
if (!rd.accepted) fail("retry not accepted");
if (!rd.prompt) fail("retry missing prompt");
console.log("ok retry-new-turn");

daemon.close();
web.close();
console.log("SMOKE PASS");
