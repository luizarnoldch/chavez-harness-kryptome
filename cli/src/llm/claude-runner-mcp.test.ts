import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildClaudeMcpOptions,
  shouldRetryWithoutProjectMcp,
} from "./claude-runner";
import { MCP_PREAMBLE, SKILLS_MCP_SERVER } from "./mcp-constants";
import { SUBAGENT_PLAN_PREAMBLE } from "./subagent-constants";

describe("buildClaudeMcpOptions", () => {
  test("merges project, host and skills MCP while retaining native tools", () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-claude-mcp-"));
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { command: "docs-server", args: ["--stdio"] },
        },
      }),
    );
    mkdirSync(join(cwd, ".claude/skills/review"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nFollow the checklist.",
    );

    const built = buildClaudeMcpOptions({
      cwd,
      executionMode: "plan",
      mcpServersExtra: { "chavez-git": { name: "git-host" } },
    });

    expect(built.options.strictMcpConfig).toBe(true);
    expect(built.options.settingSources).toEqual([]);
    expect(built.options.allowedTools).toContain("Read");
    expect(built.options.allowedTools).toContain(
      "mcp__chavez-skills__skill",
    );
    expect(built.options.allowedTools).toContain("Task");
    expect(built.options.mcpServers).toHaveProperty("docs");
    expect(built.options.mcpServers).toHaveProperty("chavez-git");
    expect(built.options.mcpServers).toHaveProperty(SKILLS_MCP_SERVER);
    expect(built.appendSystemPrompt).toContain(MCP_PREAMBLE);
    expect(built.appendSystemPrompt).toContain("review");
    expect(built.appendSystemPrompt).toContain(SUBAGENT_PLAN_PREAMBLE);
    expect(built.projectServerNames).toEqual(["docs"]);
  });
});

describe("shouldRetryWithoutProjectMcp", () => {
  test("retries errors mentioning MCP", () => {
    expect(
      shouldRetryWithoutProjectMcp(
        new Error("MCP server foo failed to connect"),
      ),
    ).toBe(true);
  });

  test("does not retry unrelated turn failures", () => {
    expect(
      shouldRetryWithoutProjectMcp(
        new Error("Claude no devolvió un resultado de éxito"),
      ),
    ).toBe(false);
  });
});
