import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CAPS,
  cursorCapsFromAgentCreate,
  cursorCapsStatic,
} from "./provider-caps";

describe("provider-caps", () => {
  test("CLAUDE_CAPS.mcp === true", () => {
    expect(CLAUDE_CAPS.mcp).toBe(true);
  });

  test("cursorCapsFromAgentCreate([]) → all false", () => {
    const c = cursorCapsFromAgentCreate([]);
    expect(c.mcp).toBe(false);
    expect(c.skills).toBe(false);
    expect(c.subagents).toBe(false);
    expect(c.nestedSubagentTools).toBe(false);
  });

  test("cursorCapsFromAgentCreate with mcpServers+agents", () => {
    const c = cursorCapsFromAgentCreate(["mcpServers", "agents"]);
    expect(c.mcp).toBe(true);
    expect(c.subagents).toBe(true);
    expect(c.nestedSubagentTools).toBe(false);
  });

  test("cursorCapsStatic nestedSubagentTools false", () => {
    expect(cursorCapsStatic().nestedSubagentTools).toBe(false);
  });
});
