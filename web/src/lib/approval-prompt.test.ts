import { describe, expect, test } from "bun:test";
import { formatApprovalHeadline } from "./approval-prompt";

describe("formatApprovalHeadline", () => {
  test("bash headline contains the command", () => {
    expect(
      formatApprovalHeadline({ kind: "bash", command: "npm test" }),
    ).toContain("npm test");
  });
});
