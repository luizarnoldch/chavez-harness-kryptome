export const EXECUTION_MODES = ["plan", "auto", "ask"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "ask";
export const MODE_CYCLE: ExecutionMode[] = ["ask", "auto", "plan"];

export const INVALID_MODE_ERROR =
  "executionMode must be plan, auto, or ask";

export const PLAN_MUTATION_DENIED =
  "Plan mode: write/edit/bash are disabled. Switch to ask or auto to apply changes.";

export const ASK_DENIED = "User denied this tool";
export const ASK_TIMEOUT_DENIED =
  "Approval timed out after 300s — tool denied";
export const ASK_APPROVAL_TIMEOUT_MS = 300_000;

export const PLAN_MODE_PREAMBLE =
  "You are in plan mode. You may read, grep, and glob the workspace. Do not write, edit, or run shell that mutates the system. Propose a concrete plan the user can apply after switching to ask or auto.";

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return v === "plan" || v === "auto" || v === "ask";
}

/** Null/undefined/"" → default ask. Anything else invalid → throw. */
export function parseExecutionMode(
  v: unknown,
  opts: { defaultOnEmpty?: boolean } = { defaultOnEmpty: true },
): ExecutionMode {
  if (v == null || v === "") {
    if (opts.defaultOnEmpty === false) {
      throw new Error(INVALID_MODE_ERROR);
    }
    return DEFAULT_EXECUTION_MODE;
  }
  if (isExecutionMode(v)) return v;
  throw new Error(INVALID_MODE_ERROR);
}

export function cycleExecutionMode(
  current: ExecutionMode,
  dir: 1 | -1 = 1,
): ExecutionMode {
  const idx = MODE_CYCLE.indexOf(current);
  const i = idx < 0 ? 0 : idx;
  return MODE_CYCLE[(i + dir + MODE_CYCLE.length) % MODE_CYCLE.length];
}

export function sdkPermissionModeFor(
  _mode: ExecutionMode,
): "default" {
  return "default";
}
