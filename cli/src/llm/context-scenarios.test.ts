import { describe, expect, test } from "bun:test";
import {
  formatContextBanner,
  isContextOverflowError,
  measureContextUsage,
  COMPACT_OVERFLOW_ERROR,
} from "./context-budget";
import {
  buildCompactSource,
  extractLastDiff,
  extractLastPlan,
  splitCompactWindow,
} from "./compact";
import { historyFromChatMessages, promptWithHistory } from "./history";

describe("Gherkin: aviso de contexto alto", () => {
  test("Web/TUI/CLI share the same banner strings", () => {
    const u = measureContextUsage({
      usedTokens: 160_000,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(u.level).toBe("warn");
    expect(formatContextBanner(u)).toMatch(/Contexto alto/);
    const c = measureContextUsage({
      usedTokens: 190_000,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(c.level).toBe("critical");
    expect(formatContextBanner(c)).toMatch(/casi lleno/);
  });
  test("overflow is classified — next turn cannot swallow it", () => {
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    expect(COMPACT_OVERFLOW_ERROR).toMatch(/compact manually/);
  });
});

describe("Gherkin: compact por comando", () => {
  test("history is summarized, old tools not resent whole, last diff+plan kept, marker label", () => {
    const hist = historyFromChatMessages(
      [
        { id: "1", role: "user", content: "haz X" },
        { id: "2", role: "tool", content: "GREP".repeat(10_000), metadata: { toolName: "grep" } },
        { id: "3", role: "assistant", content: "listo", metadata: { executionMode: "plan" } },
        {
          id: "m",
          role: "system",
          content: "contexto compactado",
          metadata: {
            kind: "compact_marker",
            summary: "Did X. Grep already ran on src/.",
            compactedUntilMessageId: "3",
            lastDiff: "foo.ts +1 −1",
            lastPlan: "1. apply",
          },
        },
      ],
      "sigue",
    );
    const blob = promptWithHistory("sigue", hist);
    expect(blob).toMatch(/Did X/);
    expect(blob).toMatch(/foo\.ts \+1/);
    expect(blob).toMatch(/1\. apply/);
    expect(blob).not.toMatch(/GREPGREPGREP/);
    expect(blob).toMatch(/Current user message:\nsigue/);
  });
});

describe("Gherkin: auto compact al desbordar", () => {
  test("retry policy constants", () => {
    expect(isContextOverflowError("context_length_exceeded")).toBe(true);
    expect(COMPACT_OVERFLOW_ERROR).toMatch(/\/compact/);
    expect(COMPACT_OVERFLOW_ERROR).toMatch(/chat compact/);
  });
  test("grep megabytes never enter compact source", () => {
    const w = splitCompactWindow(
      [
        { id: "1", role: "user", content: "a" },
        { id: "2", role: "tool", content: "z".repeat(2_000_000), metadata: { toolName: "grep" } },
        { id: "3", role: "assistant", content: "b" },
        { id: "4", role: "user", content: "c" },
        { id: "5", role: "assistant", content: "d" },
      ],
      { keepRecent: 2 },
    );
    const src = buildCompactSource(w.head);
    expect(src.length).toBeLessThan(20_000);
    expect(src).toMatch(/omitted after compact|TOOL grep/);
  });
});

describe("Gherkin: attaches del mensaje actual no se resumen", () => {
  test("current hydrated attach survives compact of the past", () => {
    const hist = historyFromChatMessages(
      [
        {
          id: "1",
          role: "user",
          content: "old @o.ts",
          metadata: { attachments: [{ path: "o.ts", kind: "text", hydratedText: "OLD" }] },
        },
        { id: "2", role: "assistant", content: "ok" },
        { id: "3", role: "user", content: "x" },
        { id: "4", role: "assistant", content: "y" },
        {
          id: "m",
          role: "system",
          content: "contexto compactado",
          metadata: {
            kind: "compact_marker",
            summary: "old work",
            compactedUntilMessageId: "4",
            lastDiff: null,
            lastPlan: null,
          },
        },
        {
          id: "5",
          role: "user",
          content: "lee @src/n.ts",
          metadata: {
            attachments: [{ path: "src/n.ts", kind: "text", hydratedText: "NEWFILE_FULL_BODY" }],
          },
        },
      ],
      "otro",
    );
    const blob = hist.map((h) => h.content).join("\n");
    expect(blob).toMatch(/NEWFILE_FULL_BODY/);
    expect(blob).not.toMatch(/\bOLD\b/);
  });
});

describe("Gherkin: tools históricas no se re-ejecutan", () => {
  test("compact source is text-only stubs", () => {
    const src = buildCompactSource([
      { id: "t", role: "tool", content: "hits", metadata: { toolName: "write" } },
    ]);
    expect(src).toMatch(/^TOOL write/);
    expect(src).not.toMatch(/canUseTool/);
  });
});

describe("Gherkin: ambos providers", () => {
  test("budget follows active model window, marker shape is provider-agnostic", () => {
    const claude = measureContextUsage({
      usedTokens: 10,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    const cursor = measureContextUsage({
      usedTokens: 10,
      windowTokens: 200_000,
      modelId: "composer-2.5",
      providerId: "cursor",
    });
    expect(claude.budgetTokens).toBe(cursor.budgetTokens);
    expect(extractLastDiff([])).toBeNull();
    expect(extractLastPlan([])).toBeNull();
  });
});
