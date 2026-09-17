// keep-in-sync with cli/src/llm/mcp-names.ts
export function canonicalMcpName(toolName: string): string {
  if (toolName === "Skill" || toolName === "skill") return "skill";
  if (toolName === "Task" || toolName === "Agent" || toolName === "task") {
    return "subagent";
  }
  const m = String(toolName).match(/^mcp__([^_]+)__(.+)$/);
  if (!m) return String(toolName).toLowerCase();
  if (m[1] === "chavez-skills") return "skill";
  if (m[1] === "chavez-git") return m[2]!;
  return `mcp:${m[1]}/${m[2]}`;
}

export function mcpFailedBanner(
  servers: Array<{ name: string; status: string }>,
): string | null {
  const failed = servers
    .filter((server) => server.status === "failed")
    .map((server) => server.name);
  if (!failed.length) return null;
  return `MCP failed: ${failed.join(", ")} — native tools continue`;
}

export function groupToolsBySubagent<
  T extends { id: string; metadata?: Record<string, unknown> },
>(messages: T[]): { roots: T[]; childrenOf: Map<string, T[]> } {
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const message of messages) {
    const parent = String(
      message.metadata?.parentToolCallId ||
        message.metadata?.subagentId ||
        "",
    );
    const kind = String(message.metadata?.kind || "");
    if (kind !== "subagent" && parent) {
      const children = childrenOf.get(parent) || [];
      children.push(message);
      childrenOf.set(parent, children);
    } else {
      roots.push(message);
    }
  }
  return { roots, childrenOf };
}
