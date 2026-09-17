import { describe, expect, test } from "bun:test";
import {
  formatApprovalHeadline,
  formatNetworkHeadline,
} from "./approval-prompt";

describe("formatApprovalHeadline", () => {
  test("bash headline contains the command", () => {
    expect(
      formatApprovalHeadline({ kind: "bash", command: "npm test" }),
    ).toContain("npm test");
  });

  test("bash with needsNetwork says pide red", () => {
    expect(
      formatApprovalHeadline({
        kind: "bash",
        command: "curl https://x",
        needsNetwork: true,
      }),
    ).toContain("pide red");
  });
});

describe("formatNetworkHeadline", () => {
  test("needsNetwork command", () => {
    const s = formatNetworkHeadline({
      needsNetwork: true,
      command: "curl https://x",
    });
    expect(s).toContain("pide red");
    expect(s).toContain("curl");
  });
});
