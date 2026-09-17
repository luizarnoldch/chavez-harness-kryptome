import {
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_IN_FLIGHT,
  UNDO_NO_CHECKPOINT,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
  type Checkpoint,
  type UndoCommitAction,
} from "./undo-constants";
import type { LastTurn } from "./turn-select";

export type FileAction = { op: "restore" | "delete"; path: string };

export type UndoGate =
  | { ok: false; error: string }
  | { ok: true; mode: "noop"; message: string; last: LastTurn }
  | { ok: true; mode: "dispatch"; last: LastTurn };

export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isSafeRelPath(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  const rel = toPosixRel(p);
  if (!rel || rel === "." || rel === "..") return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  if (rel.split("/").some((s) => s === "..")) return false;
  return true;
}

export function gateUndo(input: {
  last: LastTurn | null;
  turnBusy: boolean;
  inflight: boolean;
}): UndoGate {
  if (input.turnBusy) return { ok: false, error: TURN_BUSY_ERROR };
  if (input.inflight) return { ok: false, error: UNDO_IN_FLIGHT };
  if (!input.last) return { ok: false, error: UNDO_NO_CHECKPOINT };
  if (input.last.undone) return { ok: false, error: UNDO_ALREADY };
  const cp = input.last.checkpoint;
  if (!cp) return { ok: false, error: UNDO_NO_CHECKPOINT };
  if (cp.kind !== "git" || !cp.commitSha) {
    return { ok: false, error: UNDO_REQUIRES_GIT };
  }
  if (!cp.appliedMutations) {
    return { ok: true, mode: "noop", message: UNDO_NOOP, last: input.last };
  }
  return { ok: true, mode: "dispatch", last: input.last };
}

/** Allowlist only. Unknown status → restore (safer than skip). */
export function planFileActions(
  paths: string[],
  inCheckpointTree: Set<string>,
): FileAction[] {
  const out: FileAction[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (!isSafeRelPath(raw)) continue;
    const path = toPosixRel(raw);
    if (!isSafeRelPath(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({
      op: inCheckpointTree.has(path) ? "restore" : "delete",
      path,
    });
  }
  return out;
}

export function decideCommitAction(input: {
  headBefore: string | null;
  commitsCreated: string[];
  stillInHistory: string[];
}): { action: UndoCommitAction; shas: string[] } {
  if (!input.headBefore) {
    return input.commitsCreated.length
      ? { action: "warn", shas: [] }
      : { action: "none", shas: [] };
  }
  const shas = input.commitsCreated.filter((s) =>
    input.stillInHistory.includes(s),
  );
  if (!shas.length) return { action: "none", shas: [] };
  return { action: "revert", shas: [...shas].reverse() };
}

export function emptyCheckpoint(
  streamId: string,
  reason: NonNullable<Checkpoint["reason"]>,
): Checkpoint {
  return {
    kind: "none",
    streamId,
    reason,
    headSha: null,
    commitSha: null,
    treeSha: null,
    branch: null,
    paths: [],
    commitsCreated: [],
    hadBash: false,
    appliedMutations: false,
    createdAt: new Date().toISOString(),
  };
}
