import { describe, expect, test } from "bun:test";
import { pickLastTurnDiffs } from "./review-pick";

describe("pickLastTurnDiffs", () => {
  test("picks last streamId with applied files", () => {
    const diffs = [
      { streamId: "s1", path: "a.ts", status: "applied" },
      { streamId: "s2", path: "b.ts", status: "applied" },
      { streamId: "s2", path: "c.ts", status: "applied" },
    ];
    const picked = pickLastTurnDiffs(diffs);
    expect(picked).toEqual({
      streamId: "s2",
      files: [
        { streamId: "s2", path: "b.ts", status: "applied" },
        { streamId: "s2", path: "c.ts", status: "applied" },
      ],
    });
  });

  test("only rejected returns null", () => {
    expect(
      pickLastTurnDiffs([{ streamId: "s1", path: "a.ts", status: "rejected" }]),
    ).toBeNull();
  });

  test("proposed counts as visible", () => {
    const picked = pickLastTurnDiffs([
      { streamId: "s1", path: "a.ts", status: "proposed" },
    ]);
    expect(picked).toEqual({
      streamId: "s1",
      files: [{ streamId: "s1", path: "a.ts", status: "proposed" }],
    });
  });

  test("empty or undefined returns null", () => {
    expect(pickLastTurnDiffs([])).toBeNull();
    expect(pickLastTurnDiffs(undefined)).toBeNull();
  });
});
