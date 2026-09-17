import { describe, expect, test } from "bun:test";
import { CURSOR_NOT_RUNNABLE, CURSOR_UNLINKED } from "./cursor-errors";
import { selectRunner } from "./select-runner";
import { streamEndPayload } from "./publish-turn";
import { USAGE_META_KIND } from "./usage-codec";

test("stream.end includes usage metadata when present", () => {
  const p = streamEndPayload({
    chatId: "c1",
    streamId: "s1",
    content: "hello",
    usageMeta: {
      kind: USAGE_META_KIND,
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      usage: { usage: { input_tokens: 1 } },
    },
  });
  expect(p.content).toBe("hello");
  expect(p.metadata).toMatchObject({ kind: USAGE_META_KIND, provider: "claude" });
});

test("stream.end without usage still has assistant content", () => {
  const p = streamEndPayload({
    chatId: "c1",
    streamId: "s1",
    content: "hello",
    usageMeta: null,
  });
  expect(p.content).toBe("hello");
  expect(p).not.toHaveProperty("metadata");
});

describe("selectRunner", () => {
  test("claude active does not consume Cursor even if Cursor is linked", () => {
    const r = selectRunner({
      activeProvider: "claude",
      providers: {
        claude: { linked: true, runnable: true },
        cursor: { linked: true, runnable: true },
      },
    });
    expect(r.kind).toBe("claude");
  });

  test("cursor not linked → CURSOR_UNLINKED", () => {
    expect(() =>
      selectRunner({
        activeProvider: "cursor",
        providers: {
          claude: { linked: true },
          cursor: { linked: false },
        },
      }),
    ).toThrow(CURSOR_UNLINKED);
    try {
      selectRunner({
        activeProvider: "cursor",
        providers: { cursor: { linked: false } },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("chavez provider link cursor");
      expect(msg).toContain("Web");
    }
  });

  test("cursor linked but not runnable → CURSOR_NOT_RUNNABLE", () => {
    expect(() =>
      selectRunner({
        activeProvider: "cursor",
        providers: {
          cursor: { linked: true, runnable: false },
        },
      }),
    ).toThrow(CURSOR_NOT_RUNNABLE);
  });

  test("cursor linked and runnable → kind cursor", () => {
    const r = selectRunner({
      activeProvider: "cursor",
      providers: {
        cursor: { linked: true, runnable: true },
      },
    });
    expect(r.kind).toBe("cursor");
  });
});
