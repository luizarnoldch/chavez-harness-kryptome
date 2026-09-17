import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assembleTurnReplay,
  formatTurnReplay,
  redactReplayJson,
  TOOL_OUTPUT_MAX_CHARS,
} from "./turn-replay";
import { buildChatReplay } from "./turn-replay-load";

const chatId = "c1";
const sid = "s-finished";

function fixture() {
  return [
    {
      id: "u1",
      role: "user",
      content: "arregla sk-ant-api03-AAAAAAAAAAAAAAAA",
      createdAt: new Date("2026-09-16T10:00:00.000Z"),
      metadata: {
        streamId: sid,
        executionMode: "auto",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
      },
    },
    {
      id: "a1",
      role: "assistant",
      content: "listo",
      createdAt: new Date("2026-09-16T10:00:02.000Z"),
      metadata: {
        streamId: sid,
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    },
  ];
}

describe("turn-replay-load", () => {
  test("loadReplayDiffs source never selects body", () => {
    const src = readFileSync(new URL("./turn-replay-load.ts", import.meta.url), "utf8");
    expect(src).toContain("turnFileDiffs");
    expect(src).toContain("body intentionally omitted");
    expect(src).not.toMatch(/body:\s*turnFileDiffs\.body/);
  });

  test("buildChatReplay with in-memory diffs belts secrets", async () => {
    const result = await buildChatReplay({
      chatId,
      messages: fixture(),
      streamId: sid,
      diffs: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAA");
    expect(result.text).toContain("***");
    expect(result.text).toContain("mode: auto");
  });

  test("belt redacts nested keys on assembled replay", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: [
        {
          role: "user",
          content: "hi",
          metadata: { streamId: "s", api_key: "sk-ant-api03-ABCDEFGHIJKLMNOP" },
        },
        {
          role: "assistant",
          content: "ok sk-ant-api03-ABCDEFGHIJKLMNOP",
          metadata: { streamId: "s" },
        },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const belted = redactReplayJson(assembled.replay) as typeof assembled.replay;
    const text = formatTurnReplay({
      ...belted,
      prompt: String(belted.prompt),
      assistant: String(belted.assistant),
    });
    expect(text).not.toContain("sk-ant-api03-ABCDEFGHIJKLMNOP");
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(8000);
  });
});
