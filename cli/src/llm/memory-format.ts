import {
  MEMORY_FACT_ERROR,
  MEMORY_FACT_MAX,
  MEMORY_PREAMBLE,
  MEMORY_PROMPT_MAX_CHARS,
  MEMORY_SAVE_HINT,
  MEMORY_SCOPE_ERROR,
  MEMORY_TITLE_ERROR,
  MEMORY_TITLE_MAX,
  MEMORY_WORKSPACE_REQUIRED,
  isMemoryScope,
  titleFromFact,
  type MemoryScope,
} from "./memory-constants";

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  title: string;
  fact: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryRef = {
  id: string;
  scope: MemoryScope;
  title: string;
};

export type MemoryMetadata = {
  used: number;
  applied: MemoryRef[];
};

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

export function selectMemoriesForPrompt(
  rows: MemoryRecord[],
  maxChars = MEMORY_PROMPT_MAX_CHARS,
): MemoryRecord[] {
  const newestFirst = [...rows].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const kept: MemoryRecord[] = [];
  let used = MEMORY_PREAMBLE.length + MEMORY_SAVE_HINT.length + 64;
  for (const row of newestFirst) {
    const cost = row.title.length + row.fact.length + row.id.length + 16;
    if (kept.length && used + cost > maxChars) continue;
    kept.push(row);
    used += cost;
  }
  return kept.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

export function formatMemoryPrompt(
  rows: MemoryRecord[] | undefined,
): string | undefined {
  if (!rows?.length) return undefined;
  const selected = selectMemoriesForPrompt(rows);
  if (!selected.length) return undefined;
  const user = selected.filter((r) => r.scope === "user");
  const ws = selected.filter((r) => r.scope === "workspace");
  const lines = [MEMORY_PREAMBLE, "", MEMORY_SAVE_HINT, ""];
  if (user.length) {
    lines.push("## User");
    for (const r of user) lines.push(`- [${r.id}] ${r.title}: ${r.fact}`);
    lines.push("");
  }
  if (ws.length) {
    lines.push("## Workspace");
    for (const r of ws) lines.push(`- [${r.id}] ${r.title}: ${r.fact}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function memoryMetadata(rows: MemoryRecord[] | undefined): MemoryMetadata {
  const selected = rows?.length ? selectMemoriesForPrompt(rows) : [];
  return {
    used: selected.length,
    applied: selected.map((r) => ({
      id: r.id,
      scope: r.scope,
      title: r.title,
    })),
  };
}

export function joinSystemPrompts(
  ...blocks: Array<string | undefined>
): string | undefined {
  const parts = blocks.map((b) => b?.trim()).filter((b): b is string => Boolean(b));
  if (!parts.length) return undefined;
  return parts.join("\n\n---\n\n");
}

export function applyMemoryToClaudeOptions(
  options: Record<string, unknown>,
  append: string | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...options,
    settingSources: [] as string[],
  };
  if (!append) return next;
  const prev =
    typeof next.appendSystemPrompt === "string" ? next.appendSystemPrompt : "";
  next.appendSystemPrompt = joinSystemPrompts(prev, append) ?? append;
  return next;
}

export function applyMemoryToCursorPrompt(
  prompt: string,
  append: string | undefined,
): string {
  if (!append) return prompt;
  return `${append}\n\n---\n\n${prompt}`;
}
