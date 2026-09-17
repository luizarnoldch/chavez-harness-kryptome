export const EXECUTION_MODES = ["plan", "auto", "ask"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "ask";

export const INVALID_MODE_ERROR =
  "executionMode must be plan, auto, or ask";

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
