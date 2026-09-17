import { describe, expect, test } from "bun:test";
import {
  toolKindLabel,
  verificationBannerText,
  verificationFromMeta,
} from "./verify-display";

describe("verificationFromMeta", () => {
  test("returns null for empty metadata", () => {
    expect(verificationFromMeta({})).toBeNull();
  });
});

describe("toolKindLabel", () => {
  test("maps verify to test", () => {
    expect(toolKindLabel("verify", "bash")).toBe("test");
  });
});

describe("verificationBannerText", () => {
  test("failed banner mentions falló", () => {
    const text = verificationBannerText({
      status: "failed",
      kind: "verify",
      command: "bun test",
      exitCode: 1,
      timedOut: false,
    });
    expect(text).toContain("falló");
  });

  test("timeout banner mentions 120s", () => {
    const text = verificationBannerText({
      status: "timeout",
      kind: "verify",
      command: "bun test",
      exitCode: null,
      timedOut: true,
    });
    expect(text).toContain("120s");
  });
});
