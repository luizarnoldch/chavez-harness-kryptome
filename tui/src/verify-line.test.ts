import { describe, expect, test } from "bun:test";
import { toolLine, verificationBanner } from "./verify-line";

test("verify tool", () => {
  expect(
    toolLine({
      id: "1",
      role: "tool",
      content: "bash",
      metadata: { kind: "verify", status: "error", command: "npm test" },
    }),
  ).toBe("test · error  npm test");
});

test("banner after failed assistant", () => {
  const b = verificationBanner([
    {
      id: "a",
      role: "assistant",
      content: "Done.",
      metadata: {
        verification: { status: "failed", command: "npm test", exitCode: 1 },
      },
    },
  ]);
  expect(b).toContain("verify failed");
  expect(b).toContain("npm test");
});
