/**
 * Smoke: slash parse, prefs via /mode, mismatched model, no turn on /help.
 * Needs: chavez login, API up. Daemon bound only for compact/undo paths
 * (those are skipped if chat.compact is unknown).
 */
import { loadConfig } from "../src/config";
import { apiFetch, ApiError } from "../src/api-client";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  composerTrigger,
  isSlashInput,
  parseSlash,
  slashPickerItems,
  UNKNOWN_SLASH,
} from "../src/llm/slash";
import { liveSlashIo } from "../src/llm/slash-io-live";
import { runSlash } from "../src/llm/slash-run";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

if (composerTrigger("/")?.kind !== "slash") {
  throw new Error("typing / must open slash, not files");
}
if (composerTrigger("@src")?.kind !== "mention") {
  throw new Error("@ must stay a mention trigger");
}
if (slashPickerItems("").some((i) => i.insert.includes("src/"))) {
  throw new Error("slash picker listed a file path");
}
if (!isSlashInput("/mode auto") || parseSlash("cd src/lib").ok) {
  throw new Error("parseSlash confusion");
}

type Prefs = {
  activeProvider?: string | null;
  activeModel?: string | null;
  activeExecutionMode?: string | null;
};

const before = await apiFetch<Prefs>("/providers", {}, token);
console.log("before", before);

const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(cwdPath(), "client");
if (!bound.ok) throw new Error(bound.error || "bind failed");

const sessionRes = await client.request({
  type: "session.create",
  title: `slash-smoke ${Date.now()}`,
});
if (!sessionRes.ok) throw new Error(sessionRes.error);
const sessionId = (sessionRes.data as { session: { id: string } }).session.id;
const chatRes = await client.request({
  type: "chat.create",
  sessionId,
  title: "slash-smoke",
});
if (!chatRes.ok) throw new Error(chatRes.error);
const chatId = (chatRes.data as { chat: { id: string } }).chat.id;

const io = liveSlashIo({ client, token });
const ctx = { chatId, sessionId };

const modeRes = await runSlash("/mode auto", io, ctx);
if (!modeRes.ok || !modeRes.text.includes("auto")) {
  throw new Error(` /mode auto failed: ${modeRes.text}`);
}
const afterMode = await apiFetch<Prefs>("/providers", {}, token);
if (afterMode.activeExecutionMode && afterMode.activeExecutionMode !== "auto") {
  throw new Error(`prefs mode=${afterMode.activeExecutionMode}`);
}

const helpRes = await runSlash("/not-a-cmd", io, ctx);
if (helpRes.text !== UNKNOWN_SLASH) {
  throw new Error(`unknown: ${helpRes.text}`);
}

let dispatched = false;
const off = client.onPush((msg) => {
  if (msg.type === "agent.turn.dispatch") dispatched = true;
});
await runSlash("/help", io, ctx);
await Bun.sleep(400);
off();
if (dispatched) throw new Error("/help dispatched a turn");

await runSlash("/provider cursor", io, ctx);
const bad = await runSlash("/model claude-sonnet-4-6", io, ctx);
if (bad.ok) throw new Error("claude model on cursor should fail");
if (!bad.text.includes("claude-sonnet-4-6") || !bad.text.includes("cursor")) {
  throw new Error(`mismatch message: ${bad.text}`);
}

const cost = await runSlash("/cost", io, ctx);
if (!cost.text) throw new Error("cost empty");
console.log("cost", cost.text);

const clear = await runSlash("/clear", io, ctx);
if (!clear.navigatedChatId) throw new Error("clear did not create a chat");
console.log("clear", clear.navigatedChatId);

try {
  await apiFetch(
    "/providers/preferences",
    {
      method: "PUT",
      body: JSON.stringify({
        activeExecutionMode: before.activeExecutionMode ?? "ask",
        activeProvider: before.activeProvider ?? "claude",
        activeModel: before.activeModel ?? null,
      }),
    },
    token,
  );
} catch (e) {
  if (e instanceof ApiError) console.warn("restore prefs", e.message);
}

client.close();
console.log("SMOKE PASS");
