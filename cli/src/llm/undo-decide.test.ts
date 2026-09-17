import { describe, expect, test } from "bun:test";
import {
  decideCommitAction,
  gateUndo,
  isSafeRelPath,
  planFileActions,
} from "./undo-decide";
import {
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "./undo-constants";
import type { LastTurn } from "./turn-select";

function turn(partial: Partial<LastTurn> & { kind?: "git" | "none"; applied?: boolean; undone?: boolean }): LastTurn {
  const kind = partial.kind ?? "git";
  const streamId = "s1";
  const user = {
    id: "u1",
    role: "user",
    content: "edit",
    metadata: { streamId },
  };
  return {
    streamId,
    user,
    assistant: null,
    undone: partial.undone ?? false,
    checkpoint: {
      kind,
      streamId,
      reason: kind === "none" ? "not_git" : undefined,
      headSha: kind === "git" ? "aaa" : null,
      commitSha: kind === "git" ? "ccc" : null,
      treeSha: kind === "git" ? "ttt" : null,
      branch: kind === "git" ? "main" : null,
      paths: ["a.ts"],
      commitsCreated: [],
      hadBash: false,
      appliedMutations: partial.applied ?? true,
      createdAt: "2026-09-16T00:00:00.000Z",
    },
    ...partial,
  };
}

describe("gateUndo", () => {
  test("busy", () => {
    const g = gateUndo({ last: turn({}), turnBusy: true, inflight: false });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(TURN_BUSY_ERROR);
  });

  test("requires git — no dispatch", () => {
    const g = gateUndo({ last: turn({ kind: "none" }), turnBusy: false, inflight: false });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(UNDO_REQUIRES_GIT);
  });

  test("rejected ask is noop", () => {
    const g = gateUndo({
      last: turn({ applied: false }),
      turnBusy: false,
      inflight: false,
    });
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.mode).toBe("noop");
      expect(g.message).toBe(UNDO_NOOP);
    }
  });

  test("already undone", () => {
    const g = gateUndo({
      last: turn({ undone: true }),
      turnBusy: false,
      inflight: false,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(UNDO_ALREADY);
  });

  test("dispatch when git + mutations", () => {
    const g = gateUndo({ last: turn({}), turnBusy: false, inflight: false });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.mode).toBe("dispatch");
  });
});

describe("planFileActions", () => {
  test("restore if in tree, delete if created after checkpoint", () => {
    const actions = planFileActions(
      ["src/a.ts", "src/new.ts", "../etc/passwd", "src/a.ts"],
      new Set(["src/a.ts"]),
    );
    expect(actions).toEqual([
      { op: "restore", path: "src/a.ts" },
      { op: "delete", path: "src/new.ts" },
    ]);
  });

  test("rejects traversal", () => {
    expect(isSafeRelPath("../x")).toBe(false);
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("src/a.ts")).toBe(true);
  });
});

describe("decideCommitAction", () => {
  test("revert newest first when still in history", () => {
    const d = decideCommitAction({
      headBefore: "aaa",
      commitsCreated: ["c1", "c2"],
      stillInHistory: ["c1", "c2"],
    });
    expect(d.action).toBe("revert");
    expect(d.shas).toEqual(["c2", "c1"]);
  });

  test("warn when turn created first commit (unborn HEAD)", () => {
    const d = decideCommitAction({
      headBefore: null,
      commitsCreated: ["c1"],
      stillInHistory: ["c1"],
    });
    expect(d.action).toBe("warn");
    expect(d.shas).toEqual([]);
  });

  test("none when commits already gone", () => {
    const d = decideCommitAction({
      headBefore: "aaa",
      commitsCreated: ["c1"],
      stillInHistory: [],
    });
    expect(d.action).toBe("none");
  });
});
