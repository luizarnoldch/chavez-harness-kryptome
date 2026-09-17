import { describe, expect, test } from "bun:test";
import {
  applyStreamDelta,
  mergeTimeline,
  shouldShowLiveAssistant,
} from "./timeline";

describe("mergeTimeline", () => {
  test("does not duplicate the same id; incoming update wins content", () => {
    const merged = mergeTimeline(
      [{ id: "a", role: "user", content: "old" }],
      { id: "a", role: "user", content: "updated" },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe("updated");
  });

  test("orders by createdAt then id", () => {
    const merged = mergeTimeline(
      [
        { id: "b", role: "assistant", content: "b", createdAt: "2026-01-01T00:00:02Z" },
        { id: "a", role: "user", content: "a", createdAt: "2026-01-01T00:00:01Z" },
      ],
      [],
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("applyStreamDelta", () => {
  test("seq 2 then 1 concatenates ab not ba", () => {
    const state = { nextSeq: 1, buffer: new Map<number, string>() };
    let out = applyStreamDelta("", "b", 2, state);
    out = applyStreamDelta(out, "a", 1, state);
    expect(out).toBe("ab");
  });

  test("without seq concatenates in arrival order", () => {
    const state = { nextSeq: 1, buffer: new Map<number, string>() };
    let out = applyStreamDelta("", "b", undefined, state);
    out = applyStreamDelta(out, "a", undefined, state);
    expect(out).toBe("ba");
  });
});

describe("shouldShowLiveAssistant", () => {
  test("false when persisted assistant already has the streamId", () => {
    expect(
      shouldShowLiveAssistant(
        [
          {
            id: "m1",
            role: "assistant",
            content: "done",
            metadata: { streamId: "s1" },
          },
        ],
        "s1",
        true,
      ),
    ).toBe(false);
  });

  test("true while streaming without matching assistant", () => {
    expect(shouldShowLiveAssistant([], "s1", true)).toBe(true);
  });
});
