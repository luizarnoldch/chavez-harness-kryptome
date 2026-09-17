import {
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_IN_FLIGHT,
  UNDO_NO_CHECKPOINT,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "./undo-constants";
import type { LastTurn } from "./turn-select";

export type UndoGate =
  | { ok: false; error: string }
  | { ok: true; mode: "noop"; message: string; last: LastTurn }
  | { ok: true; mode: "dispatch"; last: LastTurn };

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
