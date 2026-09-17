import { describe, expect, test } from "bun:test";
import { PTY_DENIED_CI, NO_DAEMON_ERROR } from "./constants";

describe("pty api constants", () => {
  test("frozen strings", () => {
    expect(PTY_DENIED_CI).toBe(
      "PTY is not available in CI / non-interactive mode.",
    );
    expect(NO_DAEMON_ERROR).toMatch(/No daemon bound/);
  });
});
