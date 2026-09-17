import type { AgentTurnEvent } from "./agent-events";
import type { McpServerSource } from "./mcp-constants";
import type { ProviderCaps } from "./provider-caps";
import type { SkillsBundle } from "./skills-constants";
import {
  CURSOR_SUBAGENT_DEGRADED,
  cursorSkillDegraded,
} from "./subagent-constants";

export function toCursorMcpServers(
  sources: McpServerSource[],
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const source of sources) {
    const config = source.config;
    servers[source.name] =
      config.transport === "stdio"
        ? {
            type: "stdio",
            command: config.command,
            args: config.args ?? [],
            env: config.env,
          }
        : {
            type: config.transport,
            url: config.url,
            headers: config.headers,
          };
  }
  return servers;
}

export function cursorDegradeEvents(
  caps: ProviderCaps,
  bundle: SkillsBundle,
): AgentTurnEvent[] {
  const events: AgentTurnEvent[] = [];
  if (!caps.skills) {
    for (const skill of bundle.applied.slice(0, 5)) {
      events.push({
        kind: "capability_degraded",
        provider: "cursor",
        feature: "skill",
        name: skill.name,
        message: cursorSkillDegraded(skill.name),
      });
    }
    const remaining = bundle.applied.length - 5;
    if (remaining > 0) {
      events.push({
        kind: "capability_degraded",
        provider: "cursor",
        feature: "skill",
        message: `${remaining} more skills degraded`,
      });
    }
  }
  if (!caps.nestedSubagentTools) {
    events.push({
      kind: "capability_degraded",
      provider: "cursor",
      feature: "subagent",
      message: CURSOR_SUBAGENT_DEGRADED,
    });
  }
  return events;
}
