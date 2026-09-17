import { describe, expect, test } from "bun:test";
import {
  NO_USAGE_TEXT,
  aggregateChatUsage,
  extractClaudeUsageRaw,
  extractCursorUsageRaw,
  formatChatUsage,
  formatTurnUsageLine,
  stripUsageSecrets,
} from "./usage-codec";

const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  result: "ok",
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 10,
  },
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      costUSD: 0.0123,
    },
  },
};

describe("extractClaudeUsageRaw", () => {
  test("keeps native keys and cost", () => {
    const raw = extractClaudeUsageRaw(CLAUDE_RESULT);
    expect(raw).toBeTruthy();
    expect((raw!.usage as { input_tokens: number }).input_tokens).toBe(100);
    expect(raw!.total_cost_usd).toBe(0.0123);
    expect(raw).not.toHaveProperty("result");
  });

  test("missing usage is null, not error", () => {
    expect(extractClaudeUsageRaw({ type: "result", subtype: "success", result: "ok" })).toBeNull();
    expect(extractClaudeUsageRaw(null)).toBeNull();
  });
});

describe("extractCursorUsageRaw", () => {
  test("native camelCase, optimize_for is not required", () => {
    const raw = extractCursorUsageRaw({
      status: "finished",
      result: "ok",
      usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 2 },
    });
    expect(raw).toEqual({ inputTokens: 3, outputTokens: 1, cacheReadTokens: 2 });
  });

  test("does not invent tokens", () => {
    expect(extractCursorUsageRaw({ status: "finished", result: "ok" })).toBeNull();
  });
});

describe("stripUsageSecrets", () => {
  test("drops api keys from blob", () => {
    const raw = stripUsageSecrets({
      input_tokens: 1,
      apiKey: "sk-ant-secret",
      nested: { authorization: "Bearer abc", output_tokens: 2 },
    });
    expect(JSON.stringify(raw)).not.toContain("sk-ant");
    expect(JSON.stringify(raw)).not.toContain("Bearer");
    expect(raw).toHaveProperty("input_tokens", 1);
  });
});

describe("formatChatUsage", () => {
  test("sin datos when provider reported nothing", () => {
    expect(formatChatUsage([])).toBe(NO_USAGE_TEXT);
    expect(
      formatChatUsage([{ role: "assistant", content: "hi", metadata: {} }]),
    ).toBe(NO_USAGE_TEXT);
  });

  test("Claude-shaped usage shows in/out/cache and usd", () => {
    const text = formatChatUsage([
      {
        role: "assistant",
        content: "ok",
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: CLAUDE_RESULT,
        },
      },
    ]);
    expect(text).toContain("in 100");
    expect(text).toContain("out 40");
    expect(text).toContain("cache 10");
    expect(text).toContain("$0.0123");
    expect(text).not.toBe(NO_USAGE_TEXT);
  });

  test("Cursor Router cost is not labeled effort", () => {
    const text = formatChatUsage([
      {
        role: "assistant",
        content: "ok",
        metadata: {
          kind: "turn_usage",
          provider: "cursor",
          modelId: "auto-smart",
          usage: {
            inputTokens: 3,
            outputTokens: 1,
            optimize_for: "cost",
          },
        },
      },
    ]);
    expect(text).toContain("in 3");
    expect(text.toLowerCase()).not.toContain("effort");
    expect(text).not.toMatch(/effort\s*=\s*cost/i);
  });

  test("chat aggregate sums turns per provider without flattening", () => {
    const view = aggregateChatUsage([
      {
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: { usage: { input_tokens: 10, output_tokens: 4 } },
        },
      },
      {
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: { usage: { input_tokens: 5, output_tokens: 1 } },
        },
      },
      {
        metadata: {
          kind: "turn_usage",
          provider: "cursor",
          modelId: "composer-2.5",
          usage: { inputTokens: 7, outputTokens: 2 },
        },
      },
    ]);
    expect(view.turnsWithUsage).toBe(3);
    expect(view.claude).toEqual({ input_tokens: 15, output_tokens: 5 });
    expect(view.cursor).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(view.display).toContain("chat claude:");
    expect(view.display).toContain("chat cursor:");
    expect(view.display).not.toContain("effort");
  });

  test("catalog estimate fills usd when provider omitted cost", () => {
    const text = formatChatUsage(
      [
        {
          metadata: {
            kind: "turn_usage",
            provider: "claude",
            modelId: "claude-sonnet-4-6",
            usage: { usage: { input_tokens: 1_000_000, output_tokens: 0 } },
          },
        },
      ],
      { claude: { inputPricePerMTok: 3, outputPricePerMTok: 15 } },
    );
    expect(text).toContain("$3.0000");
  });

  test("Cursor stub prices 0/0 do not print $0.00", () => {
    const text = formatChatUsage(
      [
        {
          metadata: {
            kind: "turn_usage",
            provider: "cursor",
            modelId: "composer-2.5",
            usage: { inputTokens: 9, outputTokens: 1 },
          },
        },
      ],
      { cursor: { inputPricePerMTok: 0, outputPricePerMTok: 0 } },
    );
    expect(text).toContain("in 9");
    expect(text).not.toContain("$0.00");
  });
});

describe("formatTurnUsageLine", () => {
  test("null when no blob", () => {
    expect(formatTurnUsageLine({})).toBeNull();
  });
});
