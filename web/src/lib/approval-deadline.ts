export function remainingApprovalMs(
  deadlineIso: string,
  nowMs = Date.now(),
): number {
  const t = Date.parse(deadlineIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - nowMs);
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function isApprovalTimedOut(
  deadlineIso: string,
  nowMs = Date.now(),
): boolean {
  return remainingApprovalMs(deadlineIso, nowMs) <= 0;
}
