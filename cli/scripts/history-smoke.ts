/**
 * Smoke: history helper + two-turn memory via publishAgentTurn.
 */
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import {
  historyFromChatMessages,
  promptWithHistory,
} from "../src/llm/history";
import { publishAgentTurn } from "../src/llm/publish-turn";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

// --- unit ---
{
  const hist = historyFromChatMessages(
    [
      { role: "user", content: "secret token is ZEBRA-42" },
      { role: "assistant", content: "ok noted" },
      { role: "tool", content: "noise" },
      { role: "user", content: "what was the token?" },
    ],
    "what was the token?",
  );
  assert.equal(hist.length, 2);
  assert.equal(hist[0]!.content, "secret token is ZEBRA-42");
  assert.equal(hist[1]!.role, "assistant");

  const composed = promptWithHistory("what was the token?", hist);
  assert.match(composed, /ZEBRA-42/);
  assert.match(composed, /Current user message:\nwhat was the token\?/);
  console.log("history helper OK");
}

{
  const hist = historyFromChatMessages(
    [
      {
        role: "user",
        content: "explica @src/auth.ts",
        metadata: {
          attachments: [
            {
              path: "src/auth.ts",
              kind: "text",
              status: "ok",
              hydratedText: "export const TOKEN = 'SNAP-1';",
            },
          ],
        },
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "¿cuál era el token del attach?" },
    ],
    "¿cuál era el token del attach?",
  );
  assert.match(hist[0]!.content, /SNAP-1/);
  assert.match(hist[0]!.content, /not re-read from disk/);
  console.log("history attach snapshot OK");
}

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login for live smoke");
  process.exit(1);
}

const bindPath = cwdPath();
const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(bindPath, "daemon");
if (!bound.ok) throw new Error(bound.error || "bind failed");

const session = await client.request({
  type: "session.create",
  title: "history-smoke",
});
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await client.request({
  type: "chat.create",
  sessionId,
  title: "history-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const marker = `HISTORYMARKER-${crypto.randomUUID().slice(0, 8)}`;
console.log("turn 1 with marker", marker);
await publishAgentTurn({
  client,
  chatId,
  prompt: `Memoriza exactamente este código secreto y responde solo "ok": ${marker}`,
  cwd: bindPath,
  token,
});

console.log("turn 2 asking for marker");
const reply = await publishAgentTurn({
  client,
  chatId,
  prompt:
    "¿Cuál es el código secreto exacto que te di en el mensaje anterior? Responde solo con el código.",
  cwd: bindPath,
  token,
});

console.log("assistant reply:", reply.slice(0, 400));
if (!reply.includes(marker)) {
  throw new Error(`expected reply to include ${marker}`);
}

client.close();
console.log("HISTORY SMOKE PASS");
