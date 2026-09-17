import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SKILLS_MCP_SERVER, SKILL_TOOL_ID } from "./mcp-constants";
import type { SkillsBundle } from "./skills-constants";

export function createSkillsMcpServer(bundle: SkillsBundle) {
  const byName = new Map(bundle.applied.map((s) => [s.name, s]));
  return createSdkMcpServer({
    name: SKILLS_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Load a listed skill by name before following it. Skills not listed do not exist.",
    tools: [
      tool(
        SKILL_TOOL_ID,
        "Load a Chavez skill's full instructions by name.",
        { name: z.string() },
        async (args) => {
          const s = byName.get(String(args.name || ""));
          if (!s) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown skill "${args.name}". Available: ${[...byName.keys()].join(", ") || "(none)"}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `# ${s.name}\nlayer: ${s.layer}\n${s.description}\n\n${s.body}`,
              },
            ],
            isError: false,
          };
        },
      ),
    ],
  });
}

export function allowedSkillsMcpTools(): string[] {
  return [`mcp__${SKILLS_MCP_SERVER}__${SKILL_TOOL_ID}`];
}
