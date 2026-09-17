/**
 * Smoke: plan artifact create / edit / current / apply (no git commit).
 * Requires: logged in CLI, Claude linked, API up, empty-enough daemon.
 * Usage: bun run cli/scripts/plan-artifact-smoke.ts
 */
import { spawnSync } from "node:child_process";
import { apiFetch } from "../src/api-client";
import { loadConfig } from "../src/config";
import { parseExecutionMode } from "../src/llm/execution-mode";
import { publishAgentTurn } from "../src/llm/publish-turn";
import { ChavezWsClient, type WsPushMessage } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const bindPath = cwdPath();

type Prefs = {
  activeExecutionMode?: string | null;
  lastRunnableExecutionMode?: string | null;
  providers?: Record<string, { linked?: boolean; runnable?: boolean }>;
};

const providers = await apiFetch<Prefs>("/providers", {}, token);
if (!providers.providers?.claude?.linked) {
  console.log("SKIP: claude not linked");
  process.exit(0);
}

const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();

const db = await daemon.bind(bindPath, "daemon");
const wb = await web.bind(bindPath, "client");
if (!db.ok || !wb.ok) {
  console.error(`bind fail ${db.error} ${wb.error}`);
  process.exit(1);
}

daemon.onPush((msg) => {
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    planBrief?: string;
    executionMode?: string;
  };
  if (!data.chatId || !data.prompt) return;
  void publishAgentTurn({
    client: daemon,
    chatId: data.chatId,
    prompt: data.prompt,
    cwd: data.path || bindPath,
    token,
    planBrief: data.planBrief,
    executionMode: parseExecutionMode(data.executionMode),
  }).catch((err) => {
    console.error("turn fail", err instanceof Error ? err.message : err);
  });
});

function waitPush(
  client: ChavezWsClient,
  type: string,
  timeoutMs: number,
): Promise<WsPushMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting ${type}`)),
      timeoutMs,
    );
    const off = client.onPush((msg) => {
      if (msg.type !== type) return;
      clearTimeout(t);
      off();
      resolve(msg);
    });
  });
}

function gitHead(): string {
  const p = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: bindPath,
    encoding: "utf8",
  });
  if (p.status !== 0) return "NOT_A_REPO";
  return (p.stdout || "").trim() || "NOT_A_REPO";
}

const beforePrefs = await apiFetch<Prefs>("/providers", {}, token);

await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "auto" }) },
  token,
);
await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "plan" }) },
  token,
);

const session = await web.request({
  type: "session.create",
  title: "plan-artifact-smoke",
});
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "plan-smoke",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

function failOnStreamError(client: ChavezWsClient, chatId: string) {
  client.onPush((msg) => {
    if (msg.type !== "chat.stream.error") return;
    const data = (msg.data || {}) as { chatId?: string; error?: string; content?: string };
    if (data.chatId && data.chatId !== chatId) return;
    const err = data.error || data.content || "stream error";
    console.error(err);
    if (/weekly limit/i.test(err)) {
      console.log("SKIP: claude weekly limit");
      process.exit(0);
    }
    if (/not linked/i.test(err)) {
      console.log("SKIP: claude not linked");
      process.exit(0);
    }
    process.exit(1);
  });
}

const createdP = waitPush(web, "chat.plan.created", 180_000);
const appendedP = waitPush(web, "message.appended", 180_000);
failOnStreamError(web, chatId);

const turn1 = await web.request(
  {
    type: "agent.turn.request",
    chatId,
    prompt:
      "Escribe un plan corto con un heading y dos bullets para añadir un README de smoke.",
  },
  30_000,
);
if (!turn1.ok) {
  console.error(turn1.error || "agent.turn.request failed");
  process.exit(1);
}

const created = await createdP;
await appendedP;
const createdData = (created.data || {}) as {
  message?: { id: string; content: string; metadata?: Record<string, unknown> };
  currentPlanArtifactId?: string;
};
const first = createdData.message;
if (!first || first.metadata?.kind !== "plan_artifact") {
  throw new Error("created message is not plan_artifact");
}
if (first.metadata.status !== "current") {
  throw new Error("first plan is not current");
}
console.log("created", first.id);

const updatedP = waitPush(web, "chat.plan.updated", 15_000);
const upd = await web.request({
  type: "chat.plan.update",
  chatId,
  artifactId: first.id,
  markdown: "# Edited plan\n\n- step one\n",
});
if (!upd.ok) throw new Error(upd.error);
await updatedP;
const got = await web.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const gotData = got.data as {
  messages?: Array<{ id: string; content: string }>;
  currentPlanArtifactId?: string | null;
};
const edited = gotData.messages?.find((m) => m.id === first.id);
if (!edited?.content.includes("# Edited plan")) {
  throw new Error("chat.get did not return edited markdown");
}

const created2P = waitPush(web, "chat.plan.created", 180_000);
const turn2 = await web.request(
  { type: "agent.turn.request", chatId, prompt: "Otro plan distinto" },
  30_000,
);
if (!turn2.ok) {
  console.error(turn2.error || "second turn failed");
  process.exit(1);
}
const created2 = await created2P;
const second = (created2.data as { message?: { id: string } }).message;
if (!second?.id) throw new Error("second plan missing");

const listed = await web.request({ type: "chat.plan.list", chatId });
if (!listed.ok) throw new Error(listed.error);
const listData = listed.data as {
  currentPlanArtifactId?: string;
  plans?: Array<{ id: string; metadata?: { status?: string } }>;
};
if ((listData.plans?.length ?? 0) < 2) {
  throw new Error("expected 2 plans");
}
if (listData.currentPlanArtifactId !== second.id) {
  throw new Error("second plan should be current");
}
const firstAfter = listData.plans?.find((p) => p.id === first.id);
if (firstAfter?.metadata?.status !== "history") {
  throw new Error("edited first plan should be history");
}

const currentP = waitPush(web, "chat.plan.current", 15_000);
const setCur = await web.request({
  type: "chat.plan.setCurrent",
  chatId,
  artifactId: first.id,
});
if (!setCur.ok) throw new Error(setCur.error);
await currentP;
const listed2 = await web.request({ type: "chat.plan.list", chatId });
const list2 = listed2.data as { currentPlanArtifactId?: string };
if (list2.currentPlanArtifactId !== first.id) {
  throw new Error("setCurrent did not restore first");
}

const headBefore = gitHead();
const appliedP = waitPush(web, "chat.plan.applied", 15_000);
const apply = await web.request({ type: "chat.plan.apply", chatId });
if (!apply.ok) throw new Error(apply.error);
await appliedP;
const applyData = apply.data as {
  executionMode?: string;
  gitCommit?: boolean;
};
if (applyData.executionMode !== "auto") {
  throw new Error(`expected apply mode auto, got ${applyData.executionMode}`);
}
if (applyData.gitCommit) {
  throw new Error("apply must not commit");
}
const afterPrefs = await apiFetch<Prefs>("/providers", {}, token);
if (afterPrefs.activeExecutionMode !== "auto") {
  throw new Error(
    `expected activeExecutionMode auto, got ${afterPrefs.activeExecutionMode}`,
  );
}
const headAfter = gitHead();
if (headAfter !== headBefore) {
  throw new Error("git HEAD changed after apply");
}

const consumedTurn = await web.request(
  { type: "agent.turn.request", chatId, prompt: "go" },
  30_000,
);
if (!consumedTurn.ok) {
  console.error(consumedTurn.error || "apply turn failed");
  process.exit(1);
}

const deadline = Date.now() + 180_000;
let pending = true;
while (Date.now() < deadline) {
  const g = await web.request({ type: "chat.get", chatId });
  if (g.ok) {
    const msgs = (g.data as { messages?: Array<{ metadata?: { pendingApply?: boolean; status?: string } }> })
      .messages ?? [];
    const cur = msgs.find((m) => m.metadata?.status === "current");
    pending = cur?.metadata?.pendingApply === true;
    if (!pending) break;
  }
  await Bun.sleep(1000);
}
if (pending) throw new Error("pendingApply still true after apply turn");

await apiFetch(
  "/providers/preferences",
  {
    method: "PUT",
    body: JSON.stringify({
      activeExecutionMode: beforePrefs.activeExecutionMode ?? "ask",
    }),
  },
  token,
);

daemon.close();
web.close();
console.log("SMOKE PASS");
