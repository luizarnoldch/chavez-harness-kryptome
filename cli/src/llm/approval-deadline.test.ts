import { describe, expect, test } from "bun:test";
import {
  approvalDeadlineIso,
  formatRemaining,
  isApprovalTimedOut,
  remainingApprovalMs,
} from "./approval-deadline";
import { ASK_APPROVAL_TIMEOUT_MS } from "./approval-constants";

describe("approval deadline", () => {
  test("remaining at t0 is the full timeout", () => {
    const now = Date.parse("2026-09-16T00:00:00.000Z");
    const iso = approvalDeadlineIso(now, ASK_APPROVAL_TIMEOUT_MS);
    expect(remainingApprovalMs(iso, now)).toBe(ASK_APPROVAL_TIMEOUT_MS);
    expect(formatRemaining(ASK_APPROVAL_TIMEOUT_MS)).toBe("5:00");
  });

  test("visible countdown formats mm:ss", () => {
    expect(formatRemaining(62_000)).toBe("1:02");
    expect(formatRemaining(0)).toBe("0:00");
  });

  test("after timeout remaining is 0 and isApprovalTimedOut", () => {
    const now = Date.parse("2026-09-16T00:00:00.000Z");
    const iso = approvalDeadlineIso(now, 1_000);
    expect(isApprovalTimedOut(iso, now + 1_000)).toBe(true);
    expect(remainingApprovalMs(iso, now + 5_000)).toBe(0);
  });
});
