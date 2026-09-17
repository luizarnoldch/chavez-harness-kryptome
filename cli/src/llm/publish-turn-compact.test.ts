import { describe, expect, mock, test } from "bun:test";

mock.module("./compact-run", () => ({
  summarizeForCompact: async (input: { messages?: unknown[] }) => {
    const n = Array.isArray(input.messages) ? input.messages.length : 0;
    if (n < 4) {
      return {
        summary: "",
        lastDiff: null,
        lastPlan: null,
        compactedUntilMessageId: "",
        compactedMessageCount: 0,
        tooShort: true,
        method: "extractive",
      };
    }
    return {
      summary: "sum",
      lastDiff: "d",
      lastPlan: "p",
      compactedUntilMessageId: "3",
      compactedMessageCount: 3,
      tooShort: false,
      method: "extractive",
    };
  },
}));

import { applyCompact, usageFromPrompt } from "./compact-apply";
import { COMPACT_NO_HISTORY } from "./context-budget";

describe("applyCompact", () => {
  test("appends compact_marker and does not call tools", async () => {
    const calls: string[] = [];
    const messages = [
      { id: "1", role: "user", content: "a" },
      { id: "2", role: "assistant", content: "b" },
      { id: "3", role: "user", content: "c" },
      { id: "4", role: "assistant", content: "d" },
    ];
    const client = {
      request: async (msg: Record<string, unknown>) => {
        calls.push(String(msg.type));
        if (msg.type === "chat.get") return { ok: true, data: { messages } };
        if (msg.type === "chat.append") {
          messages.push({
            id: "c1",
            role: "system",
            content: String(msg.content),
            metadata: msg.metadata as never,
          });
          return { ok: true, data: { message: messages[messages.length - 1] } };
        }
        return { ok: true, data: {} };
      },
    };
    const out = await applyCompact({
      client,
      chatId: "chat",
      cwd: "/tmp",
      trigger: "manual",
      model: "claude-sonnet-4-6",
      providerId: "claude",
      auth: null,
      llmEnabled: false,
    });
    expect(out.skipped).toBe(false);
    expect(calls).toContain("chat.append");
    expect(calls.every((t) => t === "chat.get" || t === "chat.append")).toBe(true);
    expect(String((messages.at(-1) as { content?: string }).content)).toBe(
      "contexto compactado",
    );
  });

  test("tooShort → skipped", async () => {
    const messages = [
      { id: "1", role: "user", content: "a" },
      { id: "2", role: "assistant", content: "b" },
    ];
    const client = {
      request: async (msg: Record<string, unknown>) => {
        if (msg.type === "chat.get") return { ok: true, data: { messages } };
        return { ok: true, data: {} };
      },
    };
    const out = await applyCompact({
      client,
      chatId: "chat",
      cwd: "/tmp",
      trigger: "manual",
      model: "claude-sonnet-4-6",
      providerId: "claude",
      auth: null,
      llmEnabled: false,
    });
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe(COMPACT_NO_HISTORY);
  });
});

describe("usageFromPrompt", () => {
  test("grows with history", () => {
    const small = usageFromPrompt({
      prompt: "hi",
      messages: [],
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    const big = usageFromPrompt({
      prompt: "hi",
      messages: [
        { role: "user", content: "x".repeat(20_000) },
        { role: "assistant", content: "y".repeat(20_000) },
      ],
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(big.usage.usedTokens).toBeGreaterThan(small.usage.usedTokens);
  });
});
