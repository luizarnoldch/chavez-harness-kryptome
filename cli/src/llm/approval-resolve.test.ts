import { describe, expect, test } from "bun:test";
import {
  ALREADY_RESOLVED_APPROVED,
  ALREADY_RESOLVED_ERROR,
  NO_APPROVAL_ERROR,
} from "./approval-constants";
import {
  alreadyResolvedMessage,
  decideResolveGate,
  isAlreadyResolvedError,
} from "./approval-resolve";

describe("decideResolveGate", () => {
  test("first waiter wins", () => {
    expect(
      decideResolveGate({
        status: "awaiting_approval",
        resolution: null,
        inflight: false,
      }),
    ).toEqual({ ok: true });
  });

  test("second sees ya resuelto when resolution is set", () => {
    const r = decideResolveGate({
      status: "awaiting_approval",
      resolution: "approve",
      inflight: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(ALREADY_RESOLVED_APPROVED);
      expect(isAlreadyResolvedError(r.error)).toBe(true);
    }
  });

  test("second inflight request is ya resuelto", () => {
    const r = decideResolveGate({
      status: "awaiting_approval",
      inflight: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ALREADY_RESOLVED_ERROR);
  });

  test("done tool is not awaiting", () => {
    const r = decideResolveGate({
      status: "done",
      inflight: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(NO_APPROVAL_ERROR);
  });
});

describe("alreadyResolvedMessage", () => {
  test("bare ya resuelto is the default", () => {
    expect(alreadyResolvedMessage(null)).toBe("ya resuelto");
    expect(alreadyResolvedMessage("approve")).toBe("ya resuelto (approved)");
  });
});
