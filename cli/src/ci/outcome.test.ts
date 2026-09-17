import { describe, expect, test } from "bun:test";
import {
  ASK_CI_INVALID,
  CI_BUSY,
  CI_EXIT_ASK,
  CI_EXIT_FAIL,
  CI_EXIT_OK,
  CI_TIMEOUT,
} from "./constants";
import {
  ciExitCode,
  ciFailReason,
  emptyOutcome,
  foldCiEvents,
} from "./outcome";

describe("ciExitCode + ciFailReason", () => {
  test("stream_end sin verification → exit 0, reason vacío", () => {
    const out = foldCiEvents([{ kind: "stream_end" }]);
    expect(ciExitCode(out)).toBe(CI_EXIT_OK);
    expect(ciFailReason(out)).toBe("");
  });

  test("stream_error → exit 1, reason incluye el string", () => {
    const err = "Claude no está vinculado — chavez provider link claude";
    const out = foldCiEvents([{ kind: "stream_error", error: err }]);
    expect(ciExitCode(out)).toBe(CI_EXIT_FAIL);
    expect(ciFailReason(out)).toContain(err);
  });

  test('stream_end + verificationStatus "failed" → exit 1', () => {
    const out = foldCiEvents([
      { kind: "stream_end", verificationStatus: "failed" },
    ]);
    expect(ciExitCode(out)).toBe(CI_EXIT_FAIL);
    expect(ciFailReason(out)).toBe("verification failed");
  });

  test('stream_end + verificationStatus "timeout" → exit 1', () => {
    const out = foldCiEvents([
      { kind: "stream_end", verificationStatus: "timeout" },
    ]);
    expect(ciExitCode(out)).toBe(CI_EXIT_FAIL);
    expect(ciFailReason(out)).toBe("verification timed out");
  });

  test('stream_end + verificationStatus "skipped" → exit 0', () => {
    const out = foldCiEvents([
      { kind: "stream_end", verificationStatus: "skipped" },
    ]);
    expect(ciExitCode(out)).toBe(CI_EXIT_OK);
  });

  test("tool error sin stream_error con stream_end → exit 0", () => {
    const out = foldCiEvents([
      { kind: "tool", name: "bash", status: "error" },
      { kind: "stream_end" },
    ]);
    expect(ciExitCode(out)).toBe(CI_EXIT_OK);
  });

  test("timeout → exit 1, CI_TIMEOUT", () => {
    const out = foldCiEvents([{ kind: "timeout" }]);
    expect(ciExitCode(out)).toBe(CI_EXIT_FAIL);
    expect(ciFailReason(out)).toBe(CI_TIMEOUT);
  });

  test("askRejected → exit 2, ASK_CI_INVALID", () => {
    const out = { ...emptyOutcome(), askRejected: true };
    expect(ciExitCode(out)).toBe(CI_EXIT_ASK);
    expect(ciFailReason(out)).toBe(ASK_CI_INVALID);
  });

  test("provider_error → exit 1", () => {
    const out = foldCiEvents([
      { kind: "provider_error", error: "provider down" },
    ]);
    expect(ciExitCode(out)).toBe(CI_EXIT_FAIL);
  });

  test("busy sin stream_end → exit 1, CI_BUSY", () => {
    const out = foldCiEvents([{ kind: "busy" }]);
    expect(ciExitCode(out)).toBe(CI_EXIT_FAIL);
    expect(ciFailReason(out)).toBe(CI_BUSY);
  });

  test("deltas concatenados en assistantText", () => {
    const out = foldCiEvents([
      { kind: "assistant_delta", text: "hello " },
      { kind: "assistant_delta", text: "world" },
      { kind: "stream_end" },
    ]);
    expect(out.assistantText).toBe("hello world");
  });
});
