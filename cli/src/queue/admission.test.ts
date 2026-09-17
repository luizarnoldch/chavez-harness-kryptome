import { describe, expect, test } from "bun:test";
import {
  NO_DAEMON_ERROR,
  QUEUE_CI_BUSY,
  QUEUE_CI_MAX_WAIT_MS,
  QUEUE_FULL_ERROR,
  TURN_BUSY_ERROR,
} from "./constants";
import {
  admitTurn,
  capWaitTimeout,
  isNonInteractive,
  resolveAskPolicy,
} from "./admission";

describe("admitTurn", () => {
  test("no daemon → reject NO_DAEMON_ERROR", () => {
    expect(
      admitTurn({ hasDaemon: false, busy: false, queueLength: 0, enqueue: true }),
    ).toEqual({ action: "reject", error: NO_DAEMON_ERROR });
  });

  test("daemon idle → dispatch even when enqueue false", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: false,
        queueLength: 0,
        enqueue: false,
      }),
    ).toEqual({ action: "dispatch" });
  });

  test("busy + enqueue true + length 0 → enqueue", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: true,
        queueLength: 0,
        enqueue: true,
      }),
    ).toEqual({ action: "enqueue" });
  });

  test("busy + enqueue false → reject QUEUE_CI_BUSY", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: true,
        queueLength: 0,
        enqueue: false,
      }),
    ).toEqual({ action: "reject", error: QUEUE_CI_BUSY });
  });

  test("busy + length 20 → QUEUE_FULL_ERROR", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: true,
        queueLength: 20,
        enqueue: true,
      }),
    ).toEqual({ action: "reject", error: QUEUE_FULL_ERROR });
  });
});

describe("isNonInteractive", () => {
  test("CI=true / CHAVEZ_CI=1 / isTTY false → true; TTY without CI → false", () => {
    expect(isNonInteractive({ CI: "true" }, { isTTY: true })).toBe(true);
    expect(isNonInteractive({ CHAVEZ_CI: "1" }, { isTTY: true })).toBe(true);
    expect(isNonInteractive({}, { isTTY: false })).toBe(true);
    expect(isNonInteractive({}, { isTTY: true })).toBe(false);
  });
});

describe("resolveAskPolicy", () => {
  test("interactive default → enqueue true, waitTimeoutMs 0", () => {
    expect(
      resolveAskPolicy({ nonInteractive: false, noQueue: false }),
    ).toEqual({
      enqueue: true,
      waitTimeoutMs: 0,
      busyError: TURN_BUSY_ERROR,
    });
  });

  test("non-interactive default → enqueue false", () => {
    expect(
      resolveAskPolicy({ nonInteractive: true, noQueue: false }),
    ).toEqual({
      enqueue: false,
      waitTimeoutMs: 0,
      busyError: QUEUE_CI_BUSY,
    });
  });

  test("--wait-timeout 5000 in CI → enqueue true, waitTimeoutMs 5000", () => {
    expect(
      resolveAskPolicy({
        nonInteractive: true,
        noQueue: false,
        waitTimeoutMs: 5000,
      }),
    ).toEqual({
      enqueue: true,
      waitTimeoutMs: 5000,
      busyError: QUEUE_CI_BUSY,
    });
  });

  test("--wait-timeout huge → cap 600_000", () => {
    expect(
      resolveAskPolicy({
        nonInteractive: true,
        noQueue: false,
        waitTimeoutMs: 999_999_999,
      }),
    ).toEqual({
      enqueue: true,
      waitTimeoutMs: QUEUE_CI_MAX_WAIT_MS,
      busyError: QUEUE_CI_BUSY,
    });
    expect(capWaitTimeout(999_999_999)).toBe(QUEUE_CI_MAX_WAIT_MS);
  });

  test("--no-queue wins over --wait-timeout", () => {
    expect(
      resolveAskPolicy({
        nonInteractive: true,
        noQueue: true,
        waitTimeoutMs: 5000,
      }),
    ).toEqual({
      enqueue: false,
      waitTimeoutMs: 0,
      busyError: QUEUE_CI_BUSY,
    });
  });
});
