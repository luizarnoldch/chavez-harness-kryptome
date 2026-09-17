import { TURN_BUSY_ERROR } from "./undo-constants";
import { runWorktreeAction } from "./worktree";
import type { WorktreeSnapshot } from "./worktree-model";

export async function handleWorktreeRpc(input: {
  bindPath: string;
  action: string;
  payload?: Record<string, unknown>;
  turnBusy: boolean;
}): Promise<{ ok: boolean; snapshot?: WorktreeSnapshot; error?: string }> {
  if (input.action !== "list" && input.action !== "add" && input.action !== "select") {
    return { ok: false, error: `Unknown worktree action: ${input.action}` };
  }
  if (input.turnBusy && input.action !== "list") {
    return { ok: false, error: TURN_BUSY_ERROR };
  }
  return runWorktreeAction({
    bindPath: input.bindPath,
    action: input.action,
    payload: input.payload,
  });
}
