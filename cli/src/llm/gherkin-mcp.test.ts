import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpFromDisk } from "./mcp-load";
import { canonicalMcpName } from "./mcp-names";
import { gateMcpTool } from "./mcp-gate";
import { PLAN_MCP_MUTATION_DENIED } from "./mcp-constants";
import { DEFAULT_CLAUDE_TOOLS } from "./tool-names";
import { shouldRetryWithoutProjectMcp } from "./claude-runner";
import { loadSkillsFromDisk } from "./skills-load";
import { formatSkillsPrompt } from "./skills-merge";
import { isSkillName } from "./skills-constants";
import {
  createSubagentBudget,
  trySpawnSubagent,
} from "./subagent-budget";
import {
  eventsFromSdkTaskMessage,
  subagentStartFromToolUse,
} from "./subagent-events";
import { groupToolsBySubagent } from "./subagent-group";
import { gateSubagentSpawn } from "./mcp-gate";
import { CLAUDE_CAPS, cursorCapsStatic } from "./provider-caps";
import { cursorSkillDegraded } from "./subagent-constants";
import { cursorDegradeEvents } from "./cursor-mcp-bridge";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { gateMutation } from "./execution-gate";
import { MCP_NATIVE_TOOLS_OK } from "./mcp-constants";

/** Local copy of API helper for Gherkin without importing api/ */
function formatMcpFailedSystem(
  servers: Array<{ name: string; status: string }>,
): string | null {
  const failed = servers
    .filter((s) => s.status === "failed")
    .map((s) => s.name);
  if (!failed.length) return null;
  return `MCP server failed: ${failed.join(", ")} — ${MCP_NATIVE_TOOLS_OK}`;
}

describe("Gherkin: MCP del workspace se carga", () => {
  test("load + canonical + gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "gherkin-mcp-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: "node",
            args: ["-e", "process.stdin.resume()"],
          },
        },
      }),
    );
    const mcp = loadMcpFromDisk(dir, { localFile: join(dir, "nolocal") });
    expect(mcp.servers.some((s) => s.name === "echo")).toBe(true);
    expect(canonicalMcpName("mcp__echo__ping")).toBe("mcp:echo/ping");
    expect(
      gateMcpTool("ask", "mcp__echo__ping", {
        readOnly: false,
        destructive: false,
        openWorld: false,
      }).decision,
    ).toBe("ask");
    expect(
      gateMcpTool("ask", "mcp__echo__get", {
        readOnly: true,
        destructive: false,
        openWorld: false,
      }).decision,
    ).toBe("allow");
  });
});

describe("Gherkin: MCP falla al arrancar", () => {
  test("parse dead server + failed system + retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "gherkin-dead-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          dead: { command: "mcp-server-does-not-exist-xyz" },
        },
      }),
    );
    const mcp = loadMcpFromDisk(dir, { localFile: join(dir, "nolocal") });
    expect(mcp.servers.some((s) => s.name === "dead")).toBe(true);
    const msg = formatMcpFailedSystem([
      { name: "dead", status: "failed" },
    ]);
    expect(msg).toContain("dead");
    expect(msg).toContain("Native tools continue");
    expect(DEFAULT_CLAUDE_TOOLS).toContain("Read");
    expect(
      shouldRetryWithoutProjectMcp(
        new Error("MCP server dead failed to connect"),
      ),
    ).toBe(true);
  });
});

describe("Gherkin: Skills del proyecto", () => {
  test("project skill loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "gherkin-skill-"));
    mkdirSync(join(dir, ".claude/skills/pdf"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: PDF tools\n---\nDo PDF.\n",
    );
    const bundle = loadSkillsFromDisk(dir, [], {
      localDir: join(dir, "nomachine"),
    });
    expect(bundle.applied.some((s) => s.name === "pdf" && s.layer === "project")).toBe(
      true,
    );
    expect(formatSkillsPrompt(bundle)).toContain("pdf");
    expect(canonicalMcpName("mcp__chavez-skills__skill")).toBe("skill");
  });
});

describe("Gherkin: Skills de usuario", () => {
  test("project overrides user; user alone applies", () => {
    const dir = mkdtempSync(join(tmpdir(), "gherkin-user-skill-"));
    mkdirSync(join(dir, ".claude/skills/pdf"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: proj\n---\nP\n",
    );
    const over = loadSkillsFromDisk(
      dir,
      [{ name: "pdf", description: "u", body: "u", enabled: true }],
      { localDir: join(dir, "nomachine") },
    );
    expect(over.applied[0]?.layer).toBe("project");
    const alone = loadSkillsFromDisk(
      dir + "-empty",
      [{ name: "acct", description: "a", body: "b", enabled: true }],
      { localDir: join(dir, "nomachine") },
    );
    // empty cwd may not exist — use fresh empty
    const empty = mkdtempSync(join(tmpdir(), "gherkin-user-only-"));
    const only = loadSkillsFromDisk(
      empty,
      [{ name: "acct", description: "a", body: "b", enabled: true }],
      { localDir: join(empty, "nomachine") },
    );
    expect(only.applied[0]?.layer).toBe("user");
    expect(isSkillName("acct")).toBe(true);
    void alone;
  });
});

describe("Gherkin: Subagente", () => {
  test("task_started + child grouping + end", () => {
    const start = eventsFromSdkTaskMessage({
      type: "system",
      subtype: "task_started",
      task_id: "sa1",
      tool_use_id: "tu1",
      subagent_type: "Explore",
      description: "look",
    });
    expect(start[0]?.kind).toBe("subagent_start");
    const toolStart = subagentStartFromToolUse({
      id: "tu1",
      name: "Task",
      input: { description: "look" },
    });
    expect(toolStart?.kind).toBe("subagent_start");
    const grouped = groupToolsBySubagent([
      {
        id: "tu1",
        metadata: { kind: "subagent", subagentId: "sa1" },
      },
      {
        id: "child1",
        metadata: {
          kind: "read",
          parentToolCallId: "tu1",
          subagentId: "sa1",
        },
      },
    ]);
    expect(grouped.childrenOf.get("tu1")?.length).toBe(1);
    const end = eventsFromSdkTaskMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "sa1",
      status: "completed",
      summary: "done",
    });
    expect(end[0]).toMatchObject({ kind: "subagent_end", status: "done" });
  });
});

describe("Gherkin: Presupuesto de subagentes", () => {
  test("8 ok, 9th exact message", () => {
    let b = createSubagentBudget();
    for (let i = 0; i < 8; i++) {
      const r = trySpawnSubagent(b, 1);
      expect(r.ok).toBe(true);
      if (r.ok) b = r.next;
    }
    const ninth = trySpawnSubagent(b, 1);
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) {
      expect(ninth.message).toBe(
        "Subagent budget exceeded (max 8 per turn)",
      );
    }
    const deny = gateSubagentSpawn(b, 1);
    expect(deny.decision).toBe("deny");
  });
});

describe("Gherkin: Subagente en modo plan", () => {
  test("MCP write denied; native write denied; Task spawn allowed", () => {
    expect(
      gateMcpTool("plan", "mcp__echo__write", {
        readOnly: false,
        destructive: false,
        openWorld: false,
      }),
    ).toEqual({ decision: "deny", message: PLAN_MCP_MUTATION_DENIED });
    const g = gateMutation("plan", "Write", {});
    expect(g.decision).toBe("deny");
    expect(g.message).toBe(PLAN_MUTATION_DENIED);
    expect(gateMcpTool("plan", "Task", {
      readOnly: false,
      destructive: false,
      openWorld: false,
    }).decision).toBe("passthrough");
  });
});

describe("Gherkin: Provider Claude vs Cursor", () => {
  test("caps and degrade without fake tool_start", () => {
    expect(CLAUDE_CAPS.mcp).toBe(true);
    expect(CLAUDE_CAPS.skills).toBe(true);
    expect(CLAUDE_CAPS.subagents).toBe(true);
    expect(cursorCapsStatic().nestedSubagentTools).toBe(false);
    expect(cursorSkillDegraded("pdf")).toBe(
      'Cursor does not load skill "pdf" the same way as Claude — offering description only',
    );
    const events = cursorDegradeEvents(cursorCapsStatic(), {
      user: [],
      project: [],
      local: [],
      applied: [
        {
          layer: "project",
          name: "pdf",
          description: "d",
          body: "b",
          enabled: true,
          chars: 1,
          truncated: false,
        },
      ],
    });
    expect(events.every((e) => e.kind === "capability_degraded")).toBe(true);
    expect(events.some((e) => (e as { kind: string }).kind === "tool_start")).toBe(
      false,
    );
  });
});
