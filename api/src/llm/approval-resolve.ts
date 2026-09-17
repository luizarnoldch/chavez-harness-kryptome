import {
  ALREADY_RESOLVED_APPROVED,
  ALREADY_RESOLVED_DENIED,
  ALREADY_RESOLVED_ERROR,
  ALREADY_RESOLVED_TIMEOUT,
  NO_APPROVAL_ERROR,
} from "./approval-constants";

export type ApprovalResolution = "approve" | "deny" | "timeout";

export function alreadyResolvedMessage(
  resolution?: ApprovalResolution | string | null,
): string {
  if (resolution === "approve") return ALREADY_RESOLVED_APPROVED;
  if (resolution === "deny") return ALREADY_RESOLVED_DENIED;
  if (resolution === "timeout") return ALREADY_RESOLVED_TIMEOUT;
  return ALREADY_RESOLVED_ERROR;
}

export function isAlreadyResolvedError(msg: string): boolean {
  return msg.includes(ALREADY_RESOLVED_ERROR);
}

/**
 * API CAS decision. `resolving` is a process-local Set of `${chatId}:${toolCallId}`.
 * Winner = awaiting + no resolution + not in-flight.
 */
export function decideResolveGate(input: {
  status: string;
  resolution?: string | null;
  inflight: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (input.inflight) {
    return { ok: false, error: ALREADY_RESOLVED_ERROR };
  }
  if (input.resolution) {
    return { ok: false, error: alreadyResolvedMessage(input.resolution) };
  }
  if (input.status !== "awaiting_approval") {
    return { ok: false, error: NO_APPROVAL_ERROR };
  }
  return { ok: true };
}
