/** keep-in-sync with cli/src/llm/memory-format.ts */

export const MEMORY_SCOPES = ["user", "workspace"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_FACT_MAX = 2_000;
export const MEMORY_TITLE_MAX = 120;
export const USER_MEMORIES_MAX = 50;
export const WORKSPACE_MEMORIES_MAX = 50;

export const USER_MEMORIES_CAP_ERROR = "Maximum 50 user memories";
export const WORKSPACE_MEMORIES_CAP_ERROR = "Maximum 50 workspace memories";
export const MEMORY_FACT_ERROR = "fact must be 1–2000 characters";
export const MEMORY_TITLE_ERROR = "title must be 1–120 characters";
export const MEMORY_SCOPE_ERROR = "scope must be user or workspace";
export const MEMORY_WORKSPACE_REQUIRED =
  "workspaceId is required when scope is workspace";
export const MEMORY_NOT_FOUND = "Memory not found";

export function isMemoryScope(v: unknown): v is MemoryScope {
  return v === "user" || v === "workspace";
}

export function titleFromFact(fact: string): string {
  const line = fact.trim().split(/\r?\n/)[0] ?? "";
  const cut = line.slice(0, MEMORY_TITLE_MAX).trim();
  return cut || "recuerdo";
}

export type SaveMemoryInput = {
  fact: string;
  scope: MemoryScope;
  workspaceId?: string | null;
  title?: string;
};

export function parseSaveMemoryInput(raw: {
  fact?: unknown;
  scope?: unknown;
  workspaceId?: unknown;
  title?: unknown;
}): SaveMemoryInput {
  const fact = String(raw.fact ?? "").trim();
  if (fact.length < 1 || fact.length > MEMORY_FACT_MAX) {
    throw new Error(MEMORY_FACT_ERROR);
  }
  const scopeRaw = raw.scope == null || raw.scope === "" ? "workspace" : raw.scope;
  if (!isMemoryScope(scopeRaw)) throw new Error(MEMORY_SCOPE_ERROR);
  const title =
    raw.title == null || String(raw.title).trim() === ""
      ? titleFromFact(fact)
      : String(raw.title).trim();
  if (title.length < 1 || title.length > MEMORY_TITLE_MAX) {
    throw new Error(MEMORY_TITLE_ERROR);
  }
  const workspaceId =
    raw.workspaceId == null || raw.workspaceId === ""
      ? null
      : String(raw.workspaceId);
  if (scopeRaw === "workspace" && !workspaceId) {
    throw new Error(MEMORY_WORKSPACE_REQUIRED);
  }
  return {
    fact,
    scope: scopeRaw,
    workspaceId: scopeRaw === "user" ? null : workspaceId,
    title,
  };
}
