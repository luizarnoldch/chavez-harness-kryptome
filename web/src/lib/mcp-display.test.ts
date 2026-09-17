import { describe, expect, test } from "bun:test";
import {
  canonicalMcpName,
  groupToolsBySubagent,
  mcpFailedBanner,
} from "./mcp-display";

describe("canonicalMcpName", () => {
  test("formats a third-party MCP tool", () => {
    expect(canonicalMcpName("mcp__linear__list_issues")).toBe(
      "mcp:linear/list_issues",
    );
  });

  test("normalizes skills, subagents, and host MCP tools", () => {
    expect(canonicalMcpName("Skill")).toBe("skill");
    expect(canonicalMcpName("Task")).toBe("subagent");
    expect(canonicalMcpName("mcp__chavez-skills__skill")).toBe("skill");
    expect(canonicalMcpName("mcp__chavez-git__git_status")).toBe("git_status");
  });
});

describe("mcpFailedBanner", () => {
  test("returns null when no server failed", () => {
    expect(
      mcpFailedBanner([
        { name: "docs", status: "connected" },
        { name: "git", status: "disabled" },
      ]),
    ).toBeNull();
  });

  test("lists failed servers while preserving native-tool availability", () => {
    expect(
      mcpFailedBanner([
        { name: "docs", status: "failed" },
        { name: "db", status: "failed" },
      ]),
    ).toBe("MCP failed: docs, db — native tools continue");
  });
});

describe("groupToolsBySubagent", () => {
  test("nests a child under its parent subagent tool call", () => {
    const root = {
      id: "root",
      metadata: {
        kind: "subagent",
        toolCallId: "task-1",
        subagentId: "agent-1",
      },
    };
    const child = {
      id: "child",
      metadata: { kind: "tool", parentToolCallId: "task-1" },
    };

    const grouped = groupToolsBySubagent([root, child]);

    expect(grouped.roots).toEqual([root]);
    expect(grouped.childrenOf.get("task-1")).toEqual([child]);
  });
});
