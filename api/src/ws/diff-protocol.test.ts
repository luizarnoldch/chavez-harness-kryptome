import { describe, expect, test } from "bun:test";
import { parseDiffUpsert, visibleStatus } from "./diff-protocol";

describe("parseDiffUpsert", () => {
  test("accepts relative path", () => {
    const d = parseDiffUpsert({
      path: "src/a.ts",
      kind: "modified",
      status: "applied",
      additions: 2,
      deletions: 1,
      preview: "diff --git",
    });
    expect("error" in d).toBe(false);
    if ("error" in d) return;
    expect(d.path).toBe("src/a.ts");
    expect(d.kind).toBe("modified");
  });

  test("rejects traversal and absolute", () => {
    expect("error" in parseDiffUpsert({ path: "../etc/passwd", kind: "modified", status: "applied" })).toBe(true);
    expect("error" in parseDiffUpsert({ path: "/etc/passwd", kind: "created", status: "applied" })).toBe(true);
  });

  test("rejects bad kind/status", () => {
    expect("error" in parseDiffUpsert({ path: "a.ts", kind: "patched", status: "applied" })).toBe(true);
    expect("error" in parseDiffUpsert({ path: "a.ts", kind: "created", status: "done" })).toBe(true);
  });
});

describe("visibleStatus", () => {
  test("hides rejected from the panel", () => {
    expect(visibleStatus("applied")).toBe(true);
    expect(visibleStatus("proposed")).toBe(true);
    expect(visibleStatus("rejected")).toBe(false);
  });
});
