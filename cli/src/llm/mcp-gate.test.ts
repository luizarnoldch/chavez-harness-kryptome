import { describe, expect, test } from "bun:test";
import { PLAN_MCP_MUTATION_DENIED } from "./mcp-constants";
import { gateMcpTool, gateSubagentSpawn } from "./mcp-gate";
import { createSubagentBudget } from "./subagent-budget";
import { SUBAGENT_BUDGET_EXCEEDED } from "./subagent-constants";

const readOnly = {
  readOnly: true,
  destructive: false,
  openWorld: false,
};
const unknown = {
  readOnly: false,
  destructive: false,
  openWorld: false,
};

describe("gateMcpTool", () => {
  for (const mode of ["auto", "plan", "ask"] as const) {
    test(`allows read-only MCP tools in ${mode}`, () => {
      expect(gateMcpTool(mode, "mcp__docs__search", readOnly)).toEqual({
        decision: "allow",
      });
    });
  }

  test("denies unannotated MCP mutation in plan mode", () => {
    expect(gateMcpTool("plan", "mcp__docs__write", unknown)).toEqual({
      decision: "deny",
      message: PLAN_MCP_MUTATION_DENIED,
    });
  });

  test("asks for unannotated MCP mutation in ask mode", () => {
    expect(gateMcpTool("ask", "mcp__docs__write", unknown)).toEqual({
      decision: "ask",
    });
  });

  test("allows unannotated MCP mutation in auto mode", () => {
    expect(gateMcpTool("auto", "mcp__docs__write", unknown)).toEqual({
      decision: "allow",
    });
  });

  test("always allows the skills server", () => {
    expect(
      gateMcpTool("plan", "mcp__chavez-skills__skill", unknown),
    ).toEqual({ decision: "allow" });
  });

  test("passes the git MCP server through to the git gate", () => {
    expect(
      gateMcpTool("plan", "mcp__chavez-git__git_commit", unknown),
    ).toEqual({ decision: "passthrough" });
  });

  test("passes native tools through", () => {
    expect(gateMcpTool("plan", "Read", unknown)).toEqual({
      decision: "passthrough",
    });
  });
});

describe("gateSubagentSpawn", () => {
  test("denies spawn when the per-turn budget is full", () => {
    const budget = createSubagentBudget();
    budget.spawned = budget.max;
    expect(gateSubagentSpawn(budget, 1)).toEqual({
      decision: "deny",
      message: SUBAGENT_BUDGET_EXCEEDED,
    });
  });
});
