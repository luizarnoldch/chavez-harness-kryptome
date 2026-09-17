/** keep-in-sync with cli/src/llm/memory-constants.ts */
export function memoryUsedLabel(n: number): string {
  if (n <= 0) return "0 recuerdos";
  if (n === 1) return "usé 1 recuerdo";
  return `usé ${n} recuerdos`;
}

const MEMORY_TOOL_IDS = [
  "memory_save",
  "memory_list",
  "memory_forget",
] as const;

const MEMORY_MCP_PREFIX = "mcp__chavez-memory__";

/** keep-in-sync with cli/src/llm/memory-constants.ts */
export function isMemoryToolName(sdkName: string): boolean {
  const n = sdkName.trim();
  if ((MEMORY_TOOL_IDS as readonly string[]).includes(n)) return true;
  if (
    n.startsWith(MEMORY_MCP_PREFIX) &&
    (MEMORY_TOOL_IDS as readonly string[]).includes(
      n.slice(MEMORY_MCP_PREFIX.length),
    )
  ) {
    return true;
  }
  return false;
}

/** keep-in-sync with cli/src/llm/memory-constants.ts */
export function canonicalMemoryToolName(sdkName: string): string {
  const n = sdkName.trim();
  const bare = n.startsWith(MEMORY_MCP_PREFIX)
    ? n.slice(MEMORY_MCP_PREFIX.length)
    : n;
  if ((MEMORY_TOOL_IDS as readonly string[]).includes(bare)) return bare;
  return n.toLowerCase() || "tool";
}
