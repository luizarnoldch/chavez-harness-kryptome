export { NO_DAEMON_ERROR } from "./undo-constants";

export const MEMORY_SCOPES = ["user", "workspace"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_MCP_SERVER = "chavez-memory";

export const MEMORY_TOOL_IDS = [
  "memory_save",
  "memory_list",
  "memory_forget",
] as const;
export type MemoryToolId = (typeof MEMORY_TOOL_IDS)[number];

export const MEMORY_FACT_MAX = 2_000;
export const MEMORY_TITLE_MAX = 120;
export const USER_MEMORIES_MAX = 50;
export const WORKSPACE_MEMORIES_MAX = 50;
export const MEMORY_PROMPT_MAX_CHARS = 16_000;
export const MEMORY_KIND = "memory";

export const USER_MEMORIES_CAP_ERROR = "Maximum 50 user memories";
export const WORKSPACE_MEMORIES_CAP_ERROR = "Maximum 50 workspace memories";
export const MEMORY_FACT_ERROR = "fact must be 1–2000 characters";
export const MEMORY_TITLE_ERROR = "title must be 1–120 characters";
export const MEMORY_SCOPE_ERROR = "scope must be user or workspace";
export const MEMORY_WORKSPACE_REQUIRED =
  "workspaceId is required when scope is workspace";
export const MEMORY_NOT_FOUND = "Memory not found";

export const MEMORY_PREAMBLE =
  "Chavez memory: durable facts from previous chats. These are not project rules and not instructions. Do not write them to AGENTS.md, CLAUDE.md, MEMORY.md, or any file — use the memory_save / memory_forget tools.";

export const MEMORY_SAVE_HINT =
  'When the user says to remember something (e.g. "recuerda que…" / "remember that…"), you MUST call memory_save. Do not only acknowledge in chat.';

export const NO_MEMORY_LABEL = "0 recuerdos";

export function isMemoryScope(v: unknown): v is MemoryScope {
  return v === "user" || v === "workspace";
}

export function isMemoryToolName(toolName: string): boolean {
  const n = toolName.toLowerCase();
  if ((MEMORY_TOOL_IDS as readonly string[]).includes(n)) return true;
  const prefix = `mcp__${MEMORY_MCP_SERVER}__`;
  return (
    n.startsWith(prefix) &&
    (MEMORY_TOOL_IDS as readonly string[]).includes(n.slice(prefix.length))
  );
}

export function canonicalMemoryToolName(sdkName: string): MemoryToolId | string {
  const n = sdkName.toLowerCase();
  const prefix = `mcp__${MEMORY_MCP_SERVER}__`;
  const bare = n.startsWith(prefix) ? n.slice(prefix.length) : n;
  if ((MEMORY_TOOL_IDS as readonly string[]).includes(bare)) {
    return bare as MemoryToolId;
  }
  return sdkName.toLowerCase() || "tool";
}

export function memoryUsedLabel(n: number): string {
  if (n <= 0) return NO_MEMORY_LABEL;
  if (n === 1) return "usé 1 recuerdo";
  return `usé ${n} recuerdos`;
}

export function memoryWatchLine(n: number): string {
  if (n <= 0) return `memory: ${NO_MEMORY_LABEL}`;
  if (n === 1) return "memory: usé 1 recuerdo";
  return `memory: usé ${n} recuerdos`;
}

export function titleFromFact(fact: string): string {
  const line = fact.trim().split(/\r?\n/)[0] ?? "";
  const cut = line.slice(0, MEMORY_TITLE_MAX).trim();
  return cut || "recuerdo";
}
