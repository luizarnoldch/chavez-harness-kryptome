import { describe, expect, test } from "bun:test";
import {
  canonicalMcpName,
  parseMcpSdkName,
} from "./mcp-names";

describe("mcp-names", () => {
  test("mcp__linear__create_issue → mcp:linear/create_issue", () => {
    expect(canonicalMcpName("mcp__linear__create_issue")).toBe(
      "mcp:linear/create_issue",
    );
  });

  test("mcp__chavez-skills__skill → skill", () => {
    expect(canonicalMcpName("mcp__chavez-skills__skill")).toBe("skill");
  });

  test("mcp__chavez-git__git_commit → git_commit", () => {
    expect(canonicalMcpName("mcp__chavez-git__git_commit")).toBe("git_commit");
  });

  test("Read does not parse as MCP", () => {
    expect(parseMcpSdkName("Read")).toBeNull();
  });
});
