import { describe, expect, test } from "bun:test";
import {
  NO_USAGE_TEXT,
  extractClaudeUsageRaw,
  extractCursorUsageRaw,
  formatChatUsage,
  aggregateChatUsage,
} from "./usage-codec";
import { streamEndPayload } from "./publish-turn";

test("Gherkin: turn reporta usage Claude y Cursor; missing is sin datos", () => {
  const claude = extractClaudeUsageRaw({
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
    total_cost_usd: 0.01,
  });
  expect(claude).toBeTruthy();
  expect(
    formatChatUsage([
      {
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "x",
          usage: claude,
        },
      },
    ]),
  ).toContain("in 1");

  const cursor = extractCursorUsageRaw({
    usage: { inputTokens: 4, outputTokens: 5 },
  });
  expect(
    formatChatUsage([
      {
        metadata: {
          kind: "turn_usage",
          provider: "cursor",
          modelId: "y",
          usage: cursor,
        },
      },
    ]),
  ).toContain("in 4");

  expect(extractClaudeUsageRaw({ result: "ok" })).toBeNull();
  expect(
    formatChatUsage([{ role: "assistant", content: "ok", metadata: {} }]),
  ).toBe(NO_USAGE_TEXT);
});

test("Gherkin: agregado del chat suma turns; /cost == panel", () => {
  const messages = [
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "m",
        usage: { usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "m",
        usage: { usage: { input_tokens: 7, output_tokens: 2 } },
      },
    },
  ];
  const a = formatChatUsage(messages);
  const b = aggregateChatUsage(messages).display;
  expect(a).toBe(b);
  expect(a).toContain("in 17");
});

test("Gherkin: Cursor vs Claude — no same schema, Router cost is not effort", () => {
  const view = aggregateChatUsage([
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "m",
        usage: { usage: { input_tokens: 10 } },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "cursor",
        modelId: "auto-smart",
        usage: { inputTokens: 3, optimize_for: "cost" },
      },
    },
  ]);
  expect(view.claude).toHaveProperty("input_tokens", 10);
  expect(view.cursor).toHaveProperty("inputTokens", 3);
  expect(view.claude).not.toHaveProperty("inputTokens");
  expect(view.display.toLowerCase()).not.toContain("effort");
});

test("Gherkin: usage missing does not drop assistant content", () => {
  const p = streamEndPayload({
    chatId: "c",
    streamId: "s",
    content: "assistant lives",
    usageMeta: null,
  });
  expect(p.content).toBe("assistant lives");
  expect(p).not.toHaveProperty("metadata");
});
