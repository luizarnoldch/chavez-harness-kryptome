import { describe, expect, test } from "bun:test";
import { CURSOR_NOT_RUNNABLE, CURSOR_UNLINKED } from "./cursor-errors";
import { selectRunner } from "./select-runner";

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
