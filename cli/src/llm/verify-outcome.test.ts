import { describe, expect, test } from "bun:test";
import {
  buildVerificationMetadata,
  formatVerifyToolOutput,
  isSilentSuccess,
  verificationHeadline,
} from "./verify-outcome";

describe("isSilentSuccess", () => {
  test("cheerful text after failed tests is silent", () => {
    expect(
      isSilentSuccess("All tests passed. Done.", { status: "failed" }),
    ).toBe(true);
  });

  test("explanation is not silent", () => {
    expect(
      isSilentSuccess("The tests failed in foo.test.ts because X", {
        status: "failed",
      }),
    ).toBe(false);
  });

  test("passed is never silent-success", () => {
    expect(isSilentSuccess("Done.", { status: "passed" })).toBe(false);
  });
});

describe("buildVerificationMetadata", () => {
  test("timeout", () => {
    const v = buildVerificationMetadata({
      kind: "verify",
      command: "npm test",
      exitCode: null,
      timedOut: true,
      source: "pact",
      truncated: false,
    });
    expect(v.status).toBe("timeout");
    expect(v.timedOut).toBe(true);
  });
});

describe("formatVerifyToolOutput", () => {
  test("truncates with marker", () => {
    const out = formatVerifyToolOutput({
      stdout: "a".repeat(50),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      truncated: false,
      maxChars: 20,
    });
    expect(out).toContain("[truncated:");
    expect(out.startsWith("exit 1")).toBe(true);
  });
});

describe("verificationHeadline", () => {
  test("failed test", () => {
    expect(
      verificationHeadline({
        status: "failed",
        kind: "verify",
        command: "npm test",
        exitCode: 1,
        timedOut: false,
        source: "pact",
        truncated: false,
      }),
    ).toBe("test · failed  npm test");
  });
});
