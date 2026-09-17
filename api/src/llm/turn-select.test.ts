import { describe, expect, test } from "bun:test";
import { canUndoLastTurn, selectLastTurn, type ChatRow } from "./turn-select";
import { gateUndo } from "./undo-decide";
import { UNDO_NOOP, UNDO_REQUIRES_GIT } from "./undo-constants";

function row(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
): ChatRow {
  return { id: crypto.randomUUID(), role, content, metadata: metadata ?? null };
}

const gitCp = (streamId: string, extra: Record<string, unknown> = {}) => ({
  kind: "git" as const,
  streamId,
  headSha: "aaa",
  commitSha: "ccc",
  treeSha: "ttt",
  branch: "main",
  paths: ["a.ts"],
  commitsCreated: [],
  hadBash: false,
  appliedMutations: true,
  createdAt: "2026-09-16T00:00:00.000Z",
  ...extra,
});

describe("selectLastTurn", () => {
  test("picks the newest turn, leaves the previous", () => {
    const messages = [
      row("user", "one", { streamId: "s1", checkpoint: gitCp("s1") }),
      row("assistant", "ok1", { streamId: "s1" }),
      row("user", "two", { streamId: "s2", checkpoint: gitCp("s2", { paths: ["b.ts"] }) }),
      row("assistant", "ok2", { streamId: "s2" }),
    ];
    const last = selectLastTurn(messages);
    expect(last?.streamId).toBe("s2");
    expect(last?.user.content).toBe("two");
    expect(selectLastTurn(messages.slice(0, 2))?.streamId).toBe("s1");
  });

  test("ignores tool rows when grouping", () => {
    const messages = [
      row("user", "edit", { streamId: "s1", checkpoint: gitCp("s1") }),
      row("tool", "write", { streamId: "s1", toolCallId: "t1" }),
      row("assistant", "done", { streamId: "s1" }),
    ];
    expect(selectLastTurn(messages)?.streamId).toBe("s1");
  });

  test("manual append without streamId is not a turn", () => {
    const messages = [
      row("user", "turn", { streamId: "s1", checkpoint: gitCp("s1") }),
      row("assistant", "ok", { streamId: "s1" }),
      row("user", "nota manual"),
    ];
    expect(selectLastTurn(messages)?.streamId).toBe("s1");
  });
});

describe("gateUndo", () => {
  test("requires git — no dispatch", () => {
    const last = selectLastTurn([
      row("user", "x", {
        streamId: "s1",
        checkpoint: {
          kind: "none",
          streamId: "s1",
          reason: "not_git",
          headSha: null,
          commitSha: null,
          treeSha: null,
          branch: null,
          paths: [],
          commitsCreated: [],
          hadBash: false,
          appliedMutations: false,
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      }),
    ]);
    const g = gateUndo({ last, turnBusy: false, inflight: false });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(UNDO_REQUIRES_GIT);
  });

  test("rejected ask is noop", () => {
    const last = selectLastTurn([
      row("user", "x", {
        streamId: "s1",
        checkpoint: gitCp("s1", { appliedMutations: false }),
      }),
    ]);
    const g = gateUndo({ last, turnBusy: false, inflight: false });
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.mode).toBe("noop");
      expect(g.message).toBe(UNDO_NOOP);
    }
  });
});

describe("canUndoLastTurn", () => {
  test("disabled without git", () => {
    const messages = [
      row("user", "x", {
        streamId: "s1",
        checkpoint: {
          kind: "none",
          streamId: "s1",
          reason: "not_git",
          headSha: null,
          commitSha: null,
          treeSha: null,
          branch: null,
          paths: [],
          commitsCreated: [],
          hadBash: false,
          appliedMutations: false,
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      }),
    ];
    const r = canUndoLastTurn(messages);
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("UNDO_REQUIRES_GIT");
  });
});
