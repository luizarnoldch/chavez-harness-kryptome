import { describe, expect, test } from "bun:test";
import { formatDiffStat, formatWatchLine } from "./watch-format";

describe("watch diffs", () => {
  const payload = {
    type: "chat.diff.upsert",
    data: {
      chatId: "c1",
      streamId: "s1",
      diff: {
        path: "src/a.ts",
        kind: "modified",
        status: "applied",
        additions: 12,
        deletions: 3,
        preview: "diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n",
      },
    },
  };

  test("default is one stat line, no unified dump", () => {
    const line = formatWatchLine(payload);
    expect(line).toBe("diff · modified · src/a.ts  +12 −3");
    expect(line).not.toContain("diff --git");
  });

  test("verbose includes truncated preview", () => {
    const line = formatWatchLine(payload, { verbose: true });
    expect(line).toContain("diff · modified · src/a.ts  +12 −3");
    expect(line).toContain("diff --git");
    expect(line).toContain("+new");
  });

  test("dropped proposed does not look applied", () => {
    expect(
      formatWatchLine({
        type: "chat.diff.upsert",
        data: { dropped: true, diff: { path: "src/a.ts", status: "rejected" } },
      }),
    ).toBe("diff · dropped · src/a.ts");
  });

  test("formatDiffStat created/deleted", () => {
    expect(formatDiffStat({ path: "n.ts", kind: "created", additions: 40, deletions: 0 })).toBe(
      "diff · created · n.ts  +40 −0",
    );
    expect(formatDiffStat({ path: "g.ts", kind: "deleted", additions: 0, deletions: 8 })).toBe(
      "diff · deleted · g.ts  +0 −8",
    );
  });
});
