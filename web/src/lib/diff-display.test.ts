import { describe, expect, test } from "bun:test";
import { diffsForStream, isVisibleDiff } from "./diff-display";

describe("diffsForStream", () => {
  const rows = [
    { id: "1", streamId: "s1", path: "a.ts", kind: "modified", status: "applied", additions: 1, deletions: 1, preview: "" },
    { id: "2", streamId: "s2", path: "b.ts", kind: "created", status: "applied", additions: 3, deletions: 0, preview: "" },
    { id: "3", streamId: "s1", path: "c.ts", kind: "deleted", status: "rejected", additions: 0, deletions: 2, preview: "" },
  ];
  test("does not mix turns and hides rejected", () => {
    const s1 = diffsForStream(rows, "s1");
    expect(s1.map((d) => d.path)).toEqual(["a.ts"]);
    expect(isVisibleDiff(rows[2]!)).toBe(false);
  });
  test("missing stream → no fake zero panel data", () => {
    expect(diffsForStream(rows, undefined)).toEqual([]);
  });
});
