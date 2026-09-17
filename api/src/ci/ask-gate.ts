/** keep-in-sync message: cli/src/ci/constants.ts ASK_CI_INVALID */
import { ASK_CI_INVALID } from "./constants";

export function ciAskGate(input: {
  ci: boolean;
  activeExecutionMode: string | null | undefined;
}): { ok: true } | { ok: false; error: typeof ASK_CI_INVALID } {
  if (input.ci && input.activeExecutionMode === "ask") {
    return { ok: false, error: ASK_CI_INVALID };
  }
  return { ok: true };
}
