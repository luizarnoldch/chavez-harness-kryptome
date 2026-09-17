import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";

describe("MCP, skill, and subagent watch lines", () => {
  test("formats MCP connection state", () => {
    expect(
      formatWatchLine({
        type: "chat.mcp.status",
        data: { connected: ["docs", "github"], failed: [] },
      }),
    ).toBe("mcp · connected: docs, github");
    expect(
      formatWatchLine({
        type: "chat.mcp.status",
        data: { connected: ["docs"], failed: ["github", "db"] },
      }),
    ).toBe("mcp · failed: github, db · native tools continue");
  });

  test("formats skill, subagent, and degraded capability events", () => {
    expect(
      formatWatchLine({
        type: "chat.skill.activated",
        data: { name: "review", layer: "project" },
      }),
    ).toBe("skill · review · project");
    expect(
      formatWatchLine({
        type: "chat.subagent.start",
        data: { agentType: "explore", id: "sub-1" },
      }),
    ).toBe("subagent · explore · running");
    expect(
      formatWatchLine({
        type: "chat.subagent.end",
        data: { id: "sub-1", status: "error" },
      }),
    ).toBe("subagent · sub-1 · error");
    expect(
      formatWatchLine({
        type: "chat.capability.degraded",
        data: { feature: "subagents", message: "provider unsupported" },
      }),
    ).toBe("degraded · subagents · provider unsupported");
  });

  test("formats MCP and skill tools before the generic tool formatter", () => {
    expect(
      formatWatchLine({
        type: "chat.tool.start",
        data: {
          metadata: {
            kind: "mcp",
            canonical: "github.search",
            status: "running",
          },
        },
      }),
    ).toBe("mcp · github.search · running");
    expect(
      formatWatchLine({
        type: "chat.tool.result",
        data: {
          metadata: { kind: "skill", name: "review", status: "done" },
        },
      }),
    ).toBe("skill · review · done");
  });

  test("indents child tool events by two spaces", () => {
    expect(
      formatWatchLine({
        type: "chat.tool.start",
        data: {
          metadata: {
            kind: "mcp",
            canonical: "github.search",
            status: "running",
            parentToolCallId: "parent-1",
          },
        },
      }),
    ).toBe("  mcp · github.search · running");
  });
});
