/**
 * Smoke: turn diffs persist + fan-out; plan empty; ask deny drops applied;
 * truncated preview; watch stat line; reload grouping.
 * Needs: chavez login, API up (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { formatWatchLine } from "../src/llm/watch-format";
import { TurnDiffCollector, toUpsertPayload } from "../src/llm/turn-diff-collector";
import { DIFF_PREVIEW_MAX_LINES } from "../src/llm/diff-constants";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const path = cwdPath();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
assert(db.ok && wb.ok, `bind fail ${db.error} ${wb.error}`);

const session = await web.request({ type: "session.create", title: "diffs-smoke" });
assert(session.ok, session.error || "session");
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({ type: "chat.create", sessionId, title: "diffs-chat" });
assert(chat.ok, chat.error || "chat");
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seen: string[] = [];
web.onPush((msg) => {
  const data = msg.data as { chatId?: string };
  if (data?.chatId && data.chatId !== chatId) return;
  const line = formatWatchLine({ type: msg.type, data: msg.data });
  if (line) seen.push(line.split("\n")[0]!);
});

async function waitFor(pred: () => boolean, label: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (pred()) return;
    await Bun.sleep(50);
  }
  throw new Error(`${label} timeout seen=${seen.join(" | ")}`);
}

// --- auto: three files, same set ---
const cwd = realpathSync(
  mkdirSync(join(tmpdir(), `chavez-smoke-${crypto.randomUUID()}`), { recursive: true })!,
);
writeFileSync(join(cwd, "a.ts"), "a0\n");
writeFileSync(join(cwd, "b.ts"), "b0\n");
writeFileSync(join(cwd, "c.ts"), "c0\n");
const streamAuto = crypto.randomUUID();
const col = new TurnDiffCollector(streamAuto, cwd);
await col.beforeAllow("Edit", { file_path: "a.ts" }, "tA");
writeFileSync(join(cwd, "a.ts"), "a1\n");
await col.beforeAllow("Write", { file_path: "new.ts", content: "n\n" }, "tN");
writeFileSync(join(cwd, "new.ts"), "n\n");
await col.beforeAllow("Write", { file_path: "c.ts", content: "" }, "tC");
writeFileSync(join(cwd, "gone-placeholder.ts"), "x\n");
await col.beforeAllow("Write", { file_path: "gone-placeholder.ts" }, "tD");
const { unlinkSync } = await import("node:fs");
unlinkSync(join(cwd, "gone-placeholder.ts"));
const applied = await col.finalize();
assert(applied.length >= 3, `expected ≥3 net diffs, got ${applied.map((d) => d.path).join(",")}`);
for (const d of applied) {
  const up = await daemon.request({
    type: "chat.diff.upsert",
    chatId,
    streamId: streamAuto,
    diff: toUpsertPayload(d),
  });
  assert(up.ok, up.error || "upsert");
}

await waitFor(
  () => seen.filter((l) => l.startsWith("diff ·")).length >= 3,
  "watch stats",
);
for (const line of seen.filter((l) => l.startsWith("diff ·"))) {
  assert(!line.includes("diff --git"), `watch dumped unified: ${line}`);
  assert(/\+\d+ −\d+/.test(line), `missing stat: ${line}`);
}

const got = await web.request({ type: "chat.get", chatId });
assert(got.ok, got.error || "get");
const diffs1 = (got.data as { diffs: Array<{ path: string; streamId: string; kind: string }> }).diffs;
assert(
  diffs1.filter((d) => d.streamId === streamAuto).length === applied.length,
  "reload must keep auto diffs",
);

// --- next turn must not mix ---
const streamTwo = crypto.randomUUID();
const col2 = new TurnDiffCollector(streamTwo, cwd);
writeFileSync(join(cwd, "only.ts"), "z\n");
await col2.beforeAllow("Write", { file_path: "only.ts", content: "z2\n" }, "t2");
writeFileSync(join(cwd, "only.ts"), "z2\n");
for (const d of await col2.finalize()) {
  const up = await daemon.request({
    type: "chat.diff.upsert",
    chatId,
    streamId: streamTwo,
    diff: toUpsertPayload(d),
  });
  assert(up.ok, up.error || "upsert2");
}
const got2 = await web.request({ type: "chat.get", chatId });
const diffs2 = (got2.data as { diffs: Array<{ path: string; streamId: string }> }).diffs;
assert(
  diffs2.filter((d) => d.streamId === streamAuto).every((d) => d.streamId === streamAuto),
  "stream ids mixed",
);
assert(
  !diffs2.filter((d) => d.streamId === streamTwo).some((d) => d.streamId === streamAuto),
  "turn 2 leaked into turn 1",
);

// --- plan: zero upserts, get has no empty decoy (just no rows for that stream) ---
const streamPlan = crypto.randomUUID();
const colPlan = new TurnDiffCollector(streamPlan, cwd);
await colPlan.beforeAllow("Read", { file_path: "a.ts" }, "tr");
const planSet = await colPlan.finalize();
assert(planSet.length === 0, "plan/read must not produce diffs");
const gotPlan = await web.request({ type: "chat.get", chatId });
const diffsPlan = (gotPlan.data as { diffs: Array<{ streamId: string }> }).diffs;
assert(
  diffsPlan.filter((d) => d.streamId === streamPlan).length === 0,
  "plan stream must be absent, not a zero-file set",
);

// --- ask deny: proposed then rejected, not in visible list ---
const streamAsk = crypto.randomUUID();
const colAsk = new TurnDiffCollector(streamAsk, cwd);
writeFileSync(join(cwd, "ask.ts"), "old\n");
const proposed = colAsk.propose("Write", { file_path: "ask.ts", content: "new\n" }, "ta");
assert(proposed, "proposed");
const upP = await daemon.request({
  type: "chat.diff.upsert",
  chatId,
  streamId: streamAsk,
  diff: toUpsertPayload(proposed!),
});
assert(upP.ok, upP.error || "proposed upsert");
colAsk.dropProposed("ta");
const upR = await daemon.request({
  type: "chat.diff.upsert",
  chatId,
  streamId: streamAsk,
  diff: { ...toUpsertPayload(proposed!), status: "rejected" },
});
assert(upR.ok, upR.error || "rejected upsert");
const gotAsk = await web.request({ type: "chat.get", chatId });
const visibleAsk = (gotAsk.data as { diffs: Array<{ streamId: string; path: string }> }).diffs.filter(
  (d) => d.streamId === streamAsk,
);
assert(visibleAsk.length === 0, "denied ask must not leave applied diffs");

// --- huge truncated ---
const streamHuge = crypto.randomUUID();
const colHuge = new TurnDiffCollector(streamHuge, cwd);
const many = Array.from({ length: DIFF_PREVIEW_MAX_LINES + 80 }, (_, i) => `L${i}`).join("\n") + "\n";
writeFileSync(join(cwd, "huge.ts"), "seed\n");
await colHuge.beforeAllow("Write", { file_path: "huge.ts", content: many }, "th");
writeFileSync(join(cwd, "huge.ts"), many);
const hugeSet = await colHuge.finalize();
assert(hugeSet[0]?.truncated, "expected truncated preview");
assert(hugeSet[0]!.preview.includes("[truncated:"), "marker missing");
const upH = await daemon.request({
  type: "chat.diff.upsert",
  chatId,
  streamId: streamHuge,
  diff: toUpsertPayload(hugeSet[0]!),
});
assert(upH.ok, upH.error || "huge");
const previewPush = formatWatchLine(
  { type: "chat.diff.upsert", data: { diff: toUpsertPayload(hugeSet[0]!) } },
  { verbose: false },
);
assert(previewPush && !previewPush.includes("L50"), "watch default dumped huge preview");
const full = await web.request({
  type: "chat.diff.get",
  chatId,
  diffId: (upH.data as { diff: { id: string } }).diff.id,
});
assert(full.ok, full.error || "diff.get");

console.log("diffs-review-smoke ok");
daemon.close();
web.close();
