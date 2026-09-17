import { describe, expect, test } from "bun:test";
import {
  VerifyTimeoutError,
  createTurnVerifyState,
  noteToolResult,
  noteToolStart,
  shouldExplain,
  shouldRunPact,
  skippedBecauseNoRule,
  stampSilentSuccess,
  watchdogTimedOut,
} from "./verify-turn";
import {
  VERIFY_SKIPPED_NO_RULE,
  VERIFY_TIMEOUT_ERROR,
  VERIFY_TIMEOUT_MS,
} from "./verify-constants";

describe("TurnVerifyState", () => {
  test("classifies tool starts and preserves bash commands", () => {
    const state = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "change X",
    });

    expect(
      noteToolStart(state, {
        toolCallId: "t1",
        sdkName: "Bash",
        input: { command: "npm test" },
      }),
    ).toEqual({ kind: "verify", command: "npm test" });
    expect(
      noteToolStart(state, { toolCallId: "r1", sdkName: "Read" }),
    ).toEqual({ kind: "read" });
    expect(
      noteToolStart(state, { toolCallId: "w1", sdkName: "Edit" }),
    ).toEqual({ kind: "write" });
  });

  test("runs the pact only after an auto-mode edit", () => {
    const state = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "change X",
    });

    expect(shouldRunPact(state)).toBe(false);
    noteToolStart(state, {
      toolCallId: "w1",
      sdkName: "Write",
      input: { file_path: "a.ts" },
    });
    expect(shouldRunPact(state)).toBe(true);
  });

  test("does not invent a suite when no pact exists", () => {
    const state = createTurnVerifyState({
      mode: "auto",
      pactCommand: null,
      prompt: "change X",
    });
    noteToolStart(state, { toolCallId: "w1", sdkName: "Edit" });

    expect(shouldRunPact(state)).toBe(false);
    expect(skippedBecauseNoRule(state)).toMatchObject({
      status: "skipped",
      command: "",
      source: "pact",
    });
    expect(VERIFY_SKIPPED_NO_RULE).toContain("not inventing");
  });

  test("does not run the pact twice after agent verification", () => {
    const state = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "change X and run tests",
    });
    noteToolStart(state, {
      toolCallId: "t1",
      sdkName: "Bash",
      input: { command: "npm test" },
    });
    noteToolResult(state, {
      toolCallId: "t1",
      sdkName: "Bash",
      output: "exit 0\nok",
      status: "done",
    });
    noteToolStart(state, { toolCallId: "w1", sdkName: "Write" });

    expect(shouldRunPact(state)).toBe(false);
  });

  test("records timeout and exposes the terminal timeout error", () => {
    const state = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "change X",
    });
    const startedAt = Date.now();
    noteToolStart(state, {
      toolCallId: "t1",
      sdkName: "Bash",
      input: { command: "npm test" },
    });

    expect(
      watchdogTimedOut(state, startedAt + VERIFY_TIMEOUT_MS + 1),
    ).toMatchObject({ toolCallId: "t1", command: "npm test" });
    const meta = noteToolResult(state, {
      toolCallId: "t1",
      sdkName: "Bash",
      output: VERIFY_TIMEOUT_ERROR,
      status: "error",
    });
    expect(meta).toMatchObject({
      status: "timeout",
      exitCode: 124,
      timedOut: true,
    });
    expect(new VerifyTimeoutError().message).toBe(VERIFY_TIMEOUT_ERROR);
  });

  test("failed verification with cheerful text requests one explanation", () => {
    const state = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "change X and run tests",
    });
    noteToolStart(state, {
      toolCallId: "t1",
      sdkName: "Bash",
      input: { command: "npm test" },
    });
    noteToolResult(state, {
      toolCallId: "t1",
      sdkName: "Bash",
      output: "exit 1\nFAIL src/a.test.ts",
      status: "error",
    });

    expect(shouldExplain(state, "All tests passed. Done.")).toBe(true);
    expect(stampSilentSuccess(state, "All tests passed. Done.")).toMatchObject({
      silentSuccess: true,
    });
    state.continuations += 1;
    expect(shouldExplain(state, "All tests passed. Done.")).toBe(false);
    expect(shouldExplain(state, "The tests failed in src/a.test.ts")).toBe(false);
  });
});
