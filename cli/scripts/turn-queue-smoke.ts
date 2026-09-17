/**
 * Smoke: turn-queue FIFO enqueue/promote/cancel + CI no-queue/timeout.
 * Fake daemon (no LLM). Needs: chavez login, API up.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { ChavezWsClient, type WsPushMessage } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  QUEUE_CI_BUSY,
  QUEUE_CI_TIMEOUT,
  QUEUE_KIND,
} from "../src/queue/constants";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login (chavez auth login)");
  process.exit(2);
}

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

const path = cwdPath();
const daemonId = randomUUID();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);

await daemon.connect();
await web.connect();

const db = await daemon.bind(path, "daemon", { daemonId });
if (!db.ok) fail(`daemon bind: ${db.error}`);
const vb = await web.bind(path, "client");
if (!vb.ok) fail(`web bind: ${vb.error}`);

const session = await web.request({
  type: "session.create",
  title: "turn-queue-smoke",
});
if (!session.ok) fail(`session.create: ${session.error}`);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "turn-queue-chat",
});
if (!chat.ok) fail(`chat.create: ${chat.error}`);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

type DispatchData = {
  chatId?: string;
  prompt?: string;
  queueId?: string;
  skipUserAppend?: boolean;
};

type HoldMode =
  | { kind: "sleep"; ms: number }
  | { kind: "latch"; wait: () => Promise<void> };

let holdMode: HoldMode = { kind: "sleep", ms: 1500 };
let dispatchChain: Promise<void> = Promise.resolve();
let toolWhileQueued = 0;
let watchingQueued = false;

async function completeTurn(data: DispatchData): Promise<void> {
  const streamId = randomUUID();
  const turnChatId = data.chatId || chatId;
  await daemon.request({
    type: "agent.turn.started",
    chatId: turnChatId,
    streamId,
    ...(data.queueId ? { queueId: data.queueId } : {}),
  });
  if (holdMode.kind === "sleep") {
    await Bun.sleep(holdMode.ms);
  } else {
    await holdMode.wait();
  }
  await daemon.request({
    type: "chat.stream.start",
    chatId: turnChatId,
    streamId,
  });
  await daemon.request({
    type: "chat.stream.end",
    chatId: turnChatId,
    streamId,
    status: "finished",
    content: `done:${data.prompt || ""}`,
  });
  await daemon.request({
    type: "agent.turn.ended",
    chatId: turnChatId,
    streamId,
    status: "finished",
    ...(data.queueId ? { queueId: data.queueId } : {}),
  });
}

daemon.onPush((msg) => {
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as DispatchData;
  dispatchChain = dispatchChain
    .then(() => completeTurn(data))
    .catch((err) => {
      // Ignore after intentional close; surface others.
      if (String(err?.message || err).includes("WebSocket closed")) return;
      console.error("daemon dispatch error", err);
    });
});

web.onPush((msg) => {
  if (!watchingQueued) return;
  if (msg.type === "chat.tool.update" || msg.type === "chat.tool.start") {
    const d = (msg.data || {}) as {
      status?: string;
      metadata?: { status?: string };
    };
    const status = String(d.metadata?.status || d.status || "");
    if (status === "awaiting_approval" || msg.type === "chat.tool.update") {
      toolWhileQueued += 1;
    }
  }
});

function waitForPush(
  pred: (msg: WsPushMessage) => boolean,
  label: string,
  ms = 12_000,
): Promise<WsPushMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${label}`)), ms);
    const off = web.onPush((msg) => {
      if (!pred(msg)) return;
      clearTimeout(t);
      off();
      resolve(msg);
    });
  });
}

function queueItems(
  msg: WsPushMessage,
): Array<{ position: number; queueId?: string }> {
  const d = (msg.data || {}) as {
    items?: Array<{ position: number; queueId?: string }>;
  };
  return Array.isArray(d.items) ? d.items : [];
}

// --- enqueue + promote FIFO ---
watchingQueued = true;
toolWhileQueued = 0;

const first = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "first",
});
if (!first.ok) fail(`first request: ${first.error}`);
const firstData = first.data as { queued?: boolean };
if (firstData.queued !== false) {
  fail(`first should not be queued: ${JSON.stringify(first.data)}`);
}

const queuedMsgP = waitForPush(
  (m) =>
    m.type === "message.appended" &&
    (() => {
      const d = (m.data || {}) as {
        message?: {
          role?: string;
          content?: string;
          metadata?: { kind?: string };
        };
      };
      return (
        d.message?.role === "user" &&
        d.message?.content === "second" &&
        d.message?.metadata?.kind === QUEUE_KIND
      );
    })(),
  "queued message.appended",
);

const queueUpdatedP = waitForPush(
  (m) =>
    m.type === "agent.queue.updated" &&
    (m.data as { reason?: string })?.reason === "enqueued" &&
    queueItems(m)[0]?.position === 1,
  "queue.updated position 1",
);

const second = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "second",
});
if (!second.ok) fail(`second request: ${second.error}`);
const secondData = second.data as {
  queued?: boolean;
  position?: number;
};
if (secondData.queued !== true) {
  fail(`second must be queued, got ${JSON.stringify(second.data)}`);
}
if (secondData.position !== 1) {
  fail(`second position must be 1, got ${secondData.position}`);
}

await queuedMsgP;
await queueUpdatedP;
console.log("ok enqueue-position");

const drainedP = waitForPush(
  (m) =>
    m.type === "agent.queue.updated" &&
    (m.data as { reason?: string })?.reason === "drained",
  "queue drained",
);

const promoteDispatchP = new Promise<DispatchData>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no promote dispatch")), 12_000);
  const off = daemon.onPush((msg) => {
    if (msg.type !== "agent.turn.dispatch") return;
    const data = (msg.data || {}) as DispatchData;
    if (data.prompt !== "second") return;
    clearTimeout(t);
    off();
    resolve(data);
  });
});

const promoteData = await promoteDispatchP;
if (promoteData.skipUserAppend !== true) {
  fail(`promote must skipUserAppend, got ${promoteData.skipUserAppend}`);
}
if (promoteData.prompt !== "second") fail(`promote prompt ${promoteData.prompt}`);

await dispatchChain;
await drainedP;
watchingQueued = false;
console.log("ok promote-fifo");

// --- cancel skipped ---
let releaseA: (() => void) | null = null;
const aHeld = new Promise<void>((resolve) => {
  releaseA = resolve;
});
holdMode = { kind: "latch", wait: () => aHeld };

const promptsAfterA: string[] = [];
const offPrompts = daemon.onPush((msg) => {
  if (msg.type !== "agent.turn.dispatch") return;
  const p = String((msg.data as DispatchData)?.prompt || "");
  if (p === "a") return;
  promptsAfterA.push(p);
});

const reqA = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "a",
});
if (!reqA.ok) fail(`request a: ${reqA.error}`);
if ((reqA.data as { queued?: boolean }).queued !== false) {
  fail("a should run immediately");
}

await Bun.sleep(150);

const reqB = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "b",
});
if (!reqB.ok) fail(`request b: ${reqB.error}`);
const bData = reqB.data as { queued?: boolean; queueId?: string };
if (!bData.queued || !bData.queueId) {
  fail(`b must enqueue: ${JSON.stringify(reqB.data)}`);
}

const reqC = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "c",
});
if (!reqC.ok) fail(`request c: ${reqC.error}`);
if ((reqC.data as { queued?: boolean }).queued !== true) {
  fail(`c must enqueue: ${JSON.stringify(reqC.data)}`);
}

const cancel = await web.request({
  type: "agent.queue.cancel",
  queueId: bData.queueId,
});
if (!cancel.ok) fail(`cancel b: ${cancel.error}`);

releaseA?.();
await dispatchChain;
offPrompts();

if (promptsAfterA.includes("b")) fail("cancelled b must never run");
if (!promptsAfterA.includes("c")) {
  fail(`expected c after a, got ${promptsAfterA.join(",")}`);
}
if (promptsAfterA[0] !== "c") {
  fail(`next after a must be c, got ${promptsAfterA[0]}`);
}
console.log("ok cancel-skipped");

// --- enqueue:false + busy → QUEUE_CI_BUSY ---
let releaseHold: (() => void) | null = null;
const holdP = new Promise<void>((r) => {
  releaseHold = r;
});
holdMode = { kind: "latch", wait: () => holdP };

const busyTurn = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "busy-holder",
});
if (!busyTurn.ok) fail(`busy-holder: ${busyTurn.error}`);
await Bun.sleep(150);

const noQueue = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ci-no-queue",
  enqueue: false,
});
if (noQueue.ok) fail("enqueue:false while busy must fail");
const err = String(noQueue.error || "");
if (!err.includes("not queued") && !err.includes(QUEUE_CI_BUSY)) {
  fail(`expected QUEUE_CI_BUSY / not queued, got ${err}`);
}
console.log("ok ci-no-queue");

// --- wait-timeout sim: enqueue + 30ms + cancel → QUEUE_CI_TIMEOUT ---
const timeoutEnqueue = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "ci-timeout",
});
if (!timeoutEnqueue.ok) fail(`ci-timeout enqueue: ${timeoutEnqueue.error}`);
const tData = timeoutEnqueue.data as { queued?: boolean; queueId?: string };
if (!tData.queued || !tData.queueId) {
  fail(`ci-timeout must enqueue: ${JSON.stringify(timeoutEnqueue.data)}`);
}
await Bun.sleep(30);
const cancelTimeout = await web.request({
  type: "agent.queue.cancel",
  queueId: tData.queueId,
});
if (!cancelTimeout.ok) fail(`timeout cancel: ${cancelTimeout.error}`);
// Client-side wait-timeout path surfaces this constant after cancel.
if (!QUEUE_CI_TIMEOUT.includes("Timed out")) {
  fail(`unexpected QUEUE_CI_TIMEOUT: ${QUEUE_CI_TIMEOUT}`);
}
console.log("ok ci-timeout-cancels");

if (toolWhileQueued !== 0) {
  fail(`expected zero tool/approval while queued, got ${toolWhileQueued}`);
}
console.log("ok no-approval-while-queued");

releaseHold?.();
holdMode = { kind: "sleep", ms: 0 };
await dispatchChain;
await Bun.sleep(200);

daemon.close();
web.close();
console.log("SMOKE PASS");
