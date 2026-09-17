/**
 * Smoke: persist usage metadata via chat.append stand-in, chat.get aggregate,
 * /me/usage shape, no secrets. Live Claude result is optional.
 *
 * Needs: chavez login, API up. Does not require a provider turn.
 */
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { apiFetch } from "../src/api-client";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  NO_USAGE_TEXT,
  USAGE_META_KIND,
  formatChatUsage,
  assertNoSecrets,
} from "../src/llm/usage-codec";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(cwdPath(), "client");
if (!bound.ok) throw new Error(bound.error || "bind failed");

const sessionRes = await client.request({
  type: "session.create",
  title: `usage-smoke ${Date.now()}`,
});
if (!sessionRes.ok) throw new Error(sessionRes.error);
const sessionId = (sessionRes.data as { session: { id: string } }).session.id;
const chatRes = await client.request({
  type: "chat.create",
  sessionId,
  title: "usage-smoke",
});
if (!chatRes.ok) throw new Error(chatRes.error);
const chatId = (chatRes.data as { chat: { id: string } }).chat.id;

const empty = await client.request({ type: "chat.get", chatId });
if (!empty.ok) throw new Error(empty.error);
const emptyUsage = (empty.data as { usage?: { display?: string } }).usage;
const emptyDisplay =
  emptyUsage?.display ??
  formatChatUsage(
    (empty.data as { messages?: Array<{ metadata?: unknown }> }).messages ?? [],
  );
assert.equal(emptyDisplay, NO_USAGE_TEXT);

const append = await client.request({
  type: "chat.append",
  chatId,
  role: "assistant",
  content: "ok-from-smoke",
  metadata: {
    kind: USAGE_META_KIND,
    provider: "claude",
    modelId: "claude-sonnet-4-6",
    usage: {
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 1 },
      total_cost_usd: 0.0012,
      apiKey: "sk-ant-SHOULD-BE-STRIPPED-IF-HANDLER-STRIPS-APPEND",
    },
  },
});
if (!append.ok) throw new Error(append.error);

const got = await client.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const data = got.data as {
  messages: Array<{ content?: string; metadata?: unknown }>;
  usage?: { display?: string; hasData?: boolean };
};
assert.ok(data.messages.some((m) => m.content === "ok-from-smoke"));
const display = data.usage?.display ?? formatChatUsage(data.messages);
assert.match(display, /in 12/);
assert.match(display, /out 4/);
assert.notEqual(display, NO_USAGE_TEXT);
assertNoSecrets(display);
if (/sk-ant-SHOULD/.test(JSON.stringify(data))) {
  console.warn(
    "note: chat.append did not strip apiKey (expected; stream.end strips)",
  );
}

const http = await apiFetch<{
  messages: typeof data.messages;
  usage?: { display?: string };
}>(`/chats/${chatId}`, {}, token);
assert.equal(http.usage?.display ?? formatChatUsage(http.messages), display);

const meUsage = await apiFetch<{ recent?: Array<{ display: string }> }>(
  "/me/usage",
  {},
  token,
);
assertNoSecrets(JSON.stringify(meUsage));
console.log("whoami-shaped", meUsage.recent?.[0]?.display ?? NO_USAGE_TEXT);

client.close();
console.log("SMOKE PASS");
