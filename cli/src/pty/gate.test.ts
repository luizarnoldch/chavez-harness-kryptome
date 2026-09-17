import { describe, expect, test } from "bun:test";
import { PTY_DENIED_AUTO, PTY_DENIED_CI, PTY_DENIED_PLAN } from "./constants";
import { gatePty, isBashOneShot, isPtyTool } from "./gate";

describe("gatePty", () => {
  test("auto denies without spawn", () => {
    expect(gatePty({ mode: "auto" })).toEqual({
      action: "deny",
      message: PTY_DENIED_AUTO,
    });
  });
  test("plan denies", () => {
    expect(gatePty({ mode: "plan" }).message).toBe(PTY_DENIED_PLAN);
  });
  test("ask asks", () => {
    expect(gatePty({ mode: "ask" })).toEqual({ action: "ask" });
  });
  test("CI denies even in ask", () => {
    expect(gatePty({ mode: "ask", ci: true })).toEqual({
      action: "deny",
      message: PTY_DENIED_CI,
    });
  });
});

describe("tool class", () => {
  test("Bash is one-shot, not pty", () => {
    expect(isBashOneShot("Bash")).toBe(true);
    expect(isPtyTool("Bash")).toBe(false);
    expect(isPtyTool("mcp__chavez-pty__pty")).toBe(true);
  });
});
