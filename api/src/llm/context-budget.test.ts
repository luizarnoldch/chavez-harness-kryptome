import { describe, expect, test } from "bun:test";
import {
  COMPACT_OVERFLOW_ERROR,
  contextLevel,
  estimateTokens,
  formatContextBanner,
  inputBudgetTokens,
  isContextOverflowError,
  measureContextUsage,
} from "./context-budget";

describe("estimateTokens", () => {
  test("empty is 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  test("4 chars → 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });
  test("5 chars → 2 tokens", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("inputBudgetTokens", () => {
  test("200k window reserves 8192", () => {
    expect(inputBudgetTokens(200_000)).toBe(200_000 - 8_192);
  });
  test("tiny window still ≥ 1024", () => {
    expect(inputBudgetTokens(100)).toBe(1024);
  });
});

describe("measureContextUsage", () => {
  test("ok under 70%", () => {
    const u = measureContextUsage({
      usedTokens: 10_000,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(u.level).toBe("ok");
    expect(formatContextBanner(u)).toBeNull();
  });
  test("warn at 70%", () => {
    const budget = inputBudgetTokens(200_000);
    const u = measureContextUsage({
      usedTokens: Math.ceil(budget * 0.7),
      windowTokens: 200_000,
      modelId: "m",
      providerId: "claude",
    });
    expect(u.level).toBe("warn");
    expect(formatContextBanner(u)).toMatch(/Contexto alto/);
    expect(formatContextBanner(u)).toMatch(/%/);
  });
  test("critical at 90%", () => {
    const budget = inputBudgetTokens(200_000);
    const u = measureContextUsage({
      usedTokens: Math.ceil(budget * 0.9),
      windowTokens: 200_000,
      modelId: "m",
      providerId: "claude",
    });
    expect(u.level).toBe("critical");
    expect(formatContextBanner(u)).toMatch(/casi lleno/);
  });
  test("level helper matches", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(0.69)).toBe("ok");
    expect(contextLevel(0.7)).toBe("warn");
    expect(contextLevel(0.9)).toBe("critical");
  });
});

describe("isContextOverflowError", () => {
  test("detects common SDK strings", () => {
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    expect(isContextOverflowError("context_length_exceeded")).toBe(true);
    expect(isContextOverflowError("max_tokens")).toBe(true);
    expect(isContextOverflowError("input is too long")).toBe(true);
    expect(isContextOverflowError(new Error("ECONNRESET"))).toBe(false);
    expect(isContextOverflowError(COMPACT_OVERFLOW_ERROR)).toBe(false);
  });
});
