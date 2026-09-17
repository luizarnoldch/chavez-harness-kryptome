export type ProviderCaps = {
  provider: "claude" | "cursor";
  mcp: boolean;
  skills: boolean;
  subagents: boolean;
  nestedSubagentTools: boolean;
};

export const PROVIDER_FEATURES = ["mcp", "skill", "subagent"] as const;
export type ProviderFeature = (typeof PROVIDER_FEATURES)[number];

export const CLAUDE_CAPS: ProviderCaps = {
  provider: "claude",
  mcp: true,
  skills: true,
  subagents: true,
  nestedSubagentTools: true,
};

export const CURSOR_CAPS_UNKNOWN: ProviderCaps = {
  provider: "cursor",
  mcp: false,
  skills: false,
  subagents: false,
  nestedSubagentTools: false,
};

/** Probe at runtime from Cursor SDK option keys; default conservative. */
export function cursorCapsFromAgentCreate(
  createOptsKeys: string[],
): ProviderCaps {
  const set = new Set(createOptsKeys);
  const mcp = set.has("mcpServers");
  const skills = set.has("mcpServers") || set.has("customTools");
  const subagents = set.has("agents") || set.has("subagents");
  return {
    provider: "cursor",
    mcp,
    skills,
    subagents,
    nestedSubagentTools: false, // never claim nested until events arrive
  };
}

export function cursorCapsStatic(): ProviderCaps {
  // Documented in docs/ts-sdk.md: mcpServers, customTools, agents exist on Agent.create.
  return {
    provider: "cursor",
    mcp: true,
    skills: true,
    subagents: true,
    nestedSubagentTools: false,
  };
}
