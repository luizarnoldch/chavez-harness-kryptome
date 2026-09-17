import { describe, expect, test } from "bun:test";
import {
  formatRemaining,
  isApprovalTimedOut,
  remainingApprovalMs,
} from "./approval-deadline";

describe("approval deadline", () => {
  test("formatRemaining of 300s is 5:00", () => {
    expect(formatRemaining(300_000)).toBe("5:00");
  });

  test("timeout remaining is 0", () => {
    const iso = new Date(Date.parse("2026-09-16T00:00:00.000Z") + 1_000).toISOString();
    const now = Date.parse("2026-09-16T00:00:00.000Z") + 5_000;
    expect(remainingApprovalMs(iso, now)).toBe(0);
    expect(isApprovalTimedOut(iso, now)).toBe(true);
  });
});
