import { GIT_MCP_SERVER, SKILLS_MCP_SERVER, SKILL_TOOL_ID } from "./mcp-constants";

const MCP_RE = /^mcp__([^_]+)__(.+)$/;

export function parseMcpSdkName(
  toolName: string,
): { server: string; tool: string } | null {
  const m = String(toolName || "").match(MCP_RE);
  if (!m) return null;
  return { server: m[1]!, tool: m[2]! };
}

export function canonicalMcpName(toolName: string): string {
  const parsed = parseMcpSdkName(toolName);
  if (!parsed) return toolName.toLowerCase();
  if (parsed.server === SKILLS_MCP_SERVER && parsed.tool === SKILL_TOOL_ID) {
    return "skill";
  }
  if (parsed.server === GIT_MCP_SERVER) return parsed.tool; // git_status, …
  return `mcp:${parsed.server}/${parsed.tool}`;
}

export function mcpSdkName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function isHostMcpServer(name: string): boolean {
  return name === GIT_MCP_SERVER || name === SKILLS_MCP_SERVER;
}
