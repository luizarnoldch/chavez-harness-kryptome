import { describe, expect, test } from "bun:test";
import {
  DIFF_PREVIEW_MAX_LINES,
  DIFF_SNAPSHOT_MAX_BYTES,
  diffTruncatedMarker,
} from "./diff-constants";
import {
  computeUnifiedDiff,
  diffLines,
  emptySnapshot,
  textSnapshot,
  truncateUnified,
} from "./unified-diff";

describe("diffLines", () => {
  test("insert", () => {
    const ops = diffLines(["a"], ["a", "b"]);
    expect(ops.filter((o) => o.type === "add").map((o) => o.line)).toEqual(["b"]);
  });
  test("delete", () => {
    const ops = diffLines(["a", "b"], ["a"]);
    expect(ops.filter((o) => o.type === "del").map((o) => o.line)).toEqual(["b"]);
  });
});

describe("computeUnifiedDiff", () => {
  test("created shows new content, kind created", () => {
    const d = computeUnifiedDiff({
      path: "src/new.ts",
      before: emptySnapshot(),
      after: textSnapshot("hello\nworld\n"),
    });
    expect(d.kind).toBe("created");
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(0);
    expect(d.preview).toContain("+hello");
    expect(d.preview).toContain("+world");
    expect(d.preview).toContain("+++ b/src/new.ts");
  });

  test("modified unified", () => {
    const d = computeUnifiedDiff({
      path: "a.ts",
      before: textSnapshot("one\ntwo\n"),
      after: textSnapshot("one\nTHREE\n"),
    });
    expect(d.kind).toBe("modified");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.preview).toContain("-two");
    expect(d.preview).toContain("+THREE");
  });

  test("deleted does not require huge blob", () => {
    const huge = "x".repeat(DIFF_SNAPSHOT_MAX_BYTES + 50);
    const d = computeUnifiedDiff({
      path: "gone.bin.txt",
      before: {
        existed: true,
        text: huge.slice(0, 100),
        binary: false,
        tooBig: true,
        byteSize: huge.length,
      },
      after: emptySnapshot(),
    });
    expect(d.kind).toBe("deleted");
    expect(d.omitted).toBe(true);
    expect(d.body).toBeNull();
    expect(d.preview).toContain("omitted: file was");
  });

  test("binary marker, no hunk dump", () => {
    const d = computeUnifiedDiff({
      path: "img.png",
      before: { existed: true, text: null, binary: true, tooBig: false, byteSize: 12 },
      after: { existed: true, text: null, binary: true, tooBig: false, byteSize: 40 },
    });
    expect(d.binary).toBe(true);
    expect(d.kind).toBe("modified");
    expect(d.preview).toContain("[binary file]");
    expect(d.additions).toBe(0);
  });
});

describe("truncateUnified", () => {
  test("marks overflow with explicit shown/total", () => {
    const lines = Array.from({ length: DIFF_PREVIEW_MAX_LINES + 20 }, (_, i) => `L${i}`);
    const { preview, truncated, totalLines } = truncateUnified(lines.join("\n") + "\n");
    expect(truncated).toBe(true);
    expect(totalLines).toBeGreaterThan(DIFF_PREVIEW_MAX_LINES);
    expect(preview).toContain(diffTruncatedMarker(DIFF_PREVIEW_MAX_LINES, totalLines));
  });
});
