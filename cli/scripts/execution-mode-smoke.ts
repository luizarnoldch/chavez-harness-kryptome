/**
 * Smoke: prefs round-trip, invalid mode, dispatch stamp, approve without waiter.
 * Needs: chavez login, API up, daemon bound (headless workspace open or this process).
 */
import { loadConfig } from "../src/config";
import { apiFetch, ApiError } from "../src/api-client";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { INVALID_MODE_ERROR } from "../src/llm/execution-mode";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

type Prefs = {
  activeExecutionMode?: string | null;
  activeProvider?: string | null;
};

const before = await apiFetch<Prefs>("/providers", {}, token);
console.log("before", before.activeExecutionMode);

try {
  await apiFetch(
    "/providers/preferences",
    {
      method: "PUT",
      body: JSON.stringify({ activeExecutionMode: "yolo" }),
    },
    token,
  );
  console.error("FAIL: yolo was accepted");
  process.exit(1);
} catch (err) {
  if (!(err instanceof ApiError) || err.status !== 400) {
    console.error("FAIL: expected 400 for yolo", err);
    process.exit(1);
  }
  const body = err.body as { error?: string } | undefined;
  const msg = body?.error || err.message;
  if (!String(msg).includes("plan, auto, or ask")) {
    console.error("FAIL: wrong error", msg, "expected", INVALID_MODE_ERROR);
    process.exit(1);
  }
}

const still = await apiFetch<Prefs>("/providers", {}, token);
if (
  parseFrozen(still.activeExecutionMode) !==
  parseFrozen(before.activeExecutionMode)
) {
  console.error("FAIL: invalid PUT mutated mode", still.activeExecutionMode);
  process.exit(1);
}

await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "auto" }) },
  token,
);
const afterAuto = await apiFetch<Prefs>("/providers", {}, token);
if (afterAuto.activeExecutionMode !== "auto") {
  console.error("FAIL: did not persist auto");
  process.exit(1);
}

await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "ask" }) },
  token,
);

function parseFrozen(v: unknown): string {
  return v === "plan" || v === "auto" || v === "ask" ? v : "ask";
}

const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const bindPath = cwdPath();
const db = await daemon.bind(bindPath, "daemon");
const wb = await web.bind(bindPath, "client");
if (!db.ok || !wb.ok) throw new Error(`bind fail ${db.error} ${wb.error}`);

const gotPrefs = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no prefs.updated")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "prefs.updated") {
      clearTimeout(t);
      const mode = (msg.data as { activeExecutionMode?: string })
        .activeExecutionMode;
      if (mode !== "plan") {
        reject(new Error(`prefs.updated mode=${mode}`));
        return;
      }
      resolve();
    }
  });
});
await apiFetch(
  "/providers/preferences",
  { method: "PUT", body: JSON.stringify({ activeExecutionMode: "plan" }) },
  token,
);
await gotPrefs;

const session = await web.request({ type: "session.create", title: "mode-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "mode-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const gotDispatch = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no dispatch")), 8000);
  daemon.onPush((msg) => {
    if (msg.type === "agent.turn.dispatch") {
      clearTimeout(t);
      const mode = (msg.data as { executionMode?: string }).executionMode;
      if (mode !== "plan") {
        reject(new Error(`dispatch executionMode=${mode}`));
        return;
      }
      resolve();
    }
  });
});

const turn = await web.request({
  type: "agent.turn.request",
  chatId,
  prompt: "mode-smoke ping",
});
if (!turn.ok) throw new Error(`turn failed: ${turn.error}`);
await gotDispatch;

const deny = await web.request({
  type: "agent.tool.deny",
  chatId,
  toolCallId: "does-not-exist",
});
if (deny.ok) {
  console.error("FAIL: deny without awaiting tool succeeded");
  process.exit(1);
}
if (!String(deny.error || "").includes("No tool awaiting") &&
    !String(deny.error || "").toLowerCase().includes("not found")) {
  console.error("FAIL: unexpected deny error", deny.error);
  process.exit(1);
}

daemon.close();
web.close();

await apiFetch(
  "/providers/preferences",
  {
    method: "PUT",
    body: JSON.stringify({
      activeExecutionMode: parseFrozen(before.activeExecutionMode),
    }),
  },
  token,
);

console.log("SMOKE PASS");
