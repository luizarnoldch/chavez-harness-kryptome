/** keep-in-sync with web/src/lib/mcp-display.ts groupToolsBySubagent */
export function groupToolsBySubagent<
  T extends { id: string; metadata?: Record<string, unknown> },
>(messages: T[]): { roots: T[]; childrenOf: Map<string, T[]> } {
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const m of messages) {
    const parent = String(
      m.metadata?.parentToolCallId || m.metadata?.subagentId || "",
    );
    const kind = String(m.metadata?.kind || "");
    if (kind !== "subagent" && parent) {
      const list = childrenOf.get(parent) || [];
      list.push(m);
      childrenOf.set(parent, list);
    } else {
      roots.push(m);
    }
  }
  return { roots, childrenOf };
}
