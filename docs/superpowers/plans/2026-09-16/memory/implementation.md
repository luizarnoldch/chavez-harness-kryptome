# Memory Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/memory` (plan 11 no lo lista), cola de turns (plan 29), worktrees paralelos (plan 28), ni reglas de archivo (plan 9 — AGENTS.md / CLAUDE.md / `.cursor/rules` **no** son memoria). Spec: [`plan.md`](./plan.md). Distinta de reglas ([`project-rules`](../project-rules/implementation.md): instrucciones en capas) y de compact ([`context-compact`](../context-compact/implementation.md): resume **ese** chat; **no** borra memoria global). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario dice “recuerda que…” en un turn y el fact queda en **memoria de usuario o de workspace**, no en AGENTS.md ni en el historial de un chat. Un chat **nuevo** del mismo usuario ve la de usuario; un chat nuevo del **mismo** workspace ve también la de workspace. La de workspace **no** vuela a otro repo. Se lista y se borra desde Web y TUI. El turn muestra `usé N recuerdos`. Compactar un chat (plan 10) **no** borra esas filas.

**Architecture:** La fuente de verdad es Postgres en la API (`memories`), no el filesystem del daemon y no `chat_messages`. El daemon **no** escribe `MEMORY.md` ni AGENTS.md. El LLM guarda/olvida con un MCP in-process (`chavez-memory`) que llama HTTP a la API. Cada `agent.turn.request` adjunta el bundle al dispatch; `publishAgentTurn` lo inyecta en `appendSystemPrompt` (bloque **facts**, no instrucciones). Web / TUI / CLI `watch` ven el mismo chip y las mismas tools.

```
Composer (Web | TUI | CLI ask)
  "recuerda que el paquete de tests es bun"
        |
        v
  agent.turn.request  --WS-->  API
        |  loadMemories(userId, workspaceId)
        |  hub.findDaemon  (sin daemon → NO_DAEMON_ERROR)
        v
  agent.turn.dispatch { prompt, memories[] }
        |
        v
  daemon / TUI  publishAgentTurn
        |  formatMemoryPrompt(memories)  → appendSystemPrompt (junto a rules si plan 9)
        |  mcpServers.chavez-memory = { memory_save, memory_list, memory_forget }
        |  query({ settingSources: [], tools nativas + memory MCP })
        |
        |  memory_save  → POST /memories  (API, no disco)
        |  memory_forget → DELETE /memories/:id
        |  chat.tool.*   misma timeline que read/write
        |  chat.stream.end metadata.memory { used, applied[] }
        v
  Web MemoryChip · TUI tecla y · CLI watch  (mismo contrato)

CRUD humano (sin turn):
  GET/POST/DELETE /memories  →  Web /memory + panel workspace · TUI overlay · chavez memory
  memory.changed broadcast   →  las tres superficies refrescan la lista
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts` tiene `user_preferences`, `workspaces`, `chats`, `chat_messages`. **No** hay tabla `memories`. **No** hay `user_rules` hasta el plan 9.
- `api/src/ws/handlers.ts` `agent.turn.request` despacha `{ chatId, prompt, path, workspaceId, sessionId }`. **No** adjunta recuerdos.
- `cli/src/llm/publish-turn.ts` lee provider/model/effort, arma history, llama `runClaudeTurn`. **No** hay `appendSystemPrompt` de memoria. `cli/src/llm/claude-runner.ts` usa `settingSources: []` y `permissionMode: "bypassPermissions"` (planes 2–3 lo pasan a `default` + `canUseTool`). **No** volver a `bypassPermissions`.
- `cli/src/llm/history.ts` mapea `chat_messages` a history. La memoria **no** se persiste como `role=system` (duplicaría cada turn y compact la vería como historial).
- Compact (plan 10): si `cli/src/llm/compact.ts` / `chat.compact` existen, solo leen/appendean `chat_messages` (`kind: "compact_marker"`). Esta fase **prohíbe** que compact haga DELETE sobre `memories`.
- Reglas (plan 9): instrucciones. Memoria = **facts**. Si `loadTurnRules` / `appendSystemPrompt` ya existen, **concatenar** con `joinSystemPrompts`; no mezclar tablas ni precedencia de reglas.
- Tools (plan 2): `DEFAULT_CLAUDE_TOOLS` = Read/Write/Edit/Grep/Glob/Bash. Memoria es un MCP extra (`chavez-memory`), mismo contrato `chat.tool.*`. Lecturas no se confirman; memory_* **tampoco** (no son write de disco).
- Git MCP (plan 7): `createSdkMcpServer({ name: "chavez-git" })`. Mergear `{ ...existing, [MEMORY_MCP_SERVER]: memoryServer }`. No pisar `chavez-git` ni `chavez-skills`.
- Cursor `runnable: false` hasta el plan 4. El bundle se calcula igual. Si `cli/src/llm/cursor-runner.ts` existe, pasarle el mismo `appendSystemPrompt` / custom tools; si no, no crearlo.
- Web `ChatDetailPanel.tsx` pinta `role` + `ToolCard`. **No** hay chip de memoria. TUI teclas: `p` `[` `]` `{` `}` `m` `s` `c` (+ `o`/`r`/`g`/`C`/`k` si siblings aterrizaron). **No** hay `y`.
- CLI: `chavez headless chat create|list|append|get|ask|watch`. **No** hay `chavez memory`.
- Slash (plan 11): catálogo cerrado **sin** `/memory`. El save conversacional va al LLM + tool, no al compositor.
- `chat_messages.metadata` jsonb **ya existe**. El chip vive en `metadata.memory` del assistant. No hay migración de timeline.

**Tech Stack:** Bun, Hono + Drizzle (tabla `memories` nueva), WebSocket hub (`memory.changed` + metadata en `chat.stream.end`), Claude Agent SDK `query` (`createSdkMcpServer` + `tool`, `settingSources: []`, merge `mcpServers`), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar labels (`web/src/lib/memory-display.ts`, comentario keep-in-sync). Zod ya está en `cli/package.json` (handlers MCP). Sin archivos en cwd. Sin isomorphic-git. Sin tokenizer.

**Global Constraints:**

1. El filesystem real vive en el daemon. **Memoria no lo toca.** `memory_save` / `memory_forget` hablan con la API. Cero `writeFile` de AGENTS.md, CLAUDE.md, `MEMORY.md`, `.cursor/rules`, `.chavez/memory*`. API y browser no leen el cwd para “hidratar” recuerdos.
2. Un turn solo corre si hay daemon bound. `agent.turn.request` sin daemon falla con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. El CRUD HTTP `/memories` **sí** funciona sin daemon (listar/borrar/crear a mano).
3. Web, CLI `watch` y TUI ven el mismo chat en vivo: tools `memory_*` y el chip `usé N recuerdos` salen del mismo `chat.tool.*` / `chat.stream.end`.
4. Preferencias de provider/modelo/esfuerzo/modo **no** se tocan.
5. Claude es el provider ejecutable. Cursor vinculado no ejecuta aquí; el mismo bundle se pasará a `runCursorTurn` cuando exista. No simular un turn Cursor.
6. Tools por defecto (read/write/edit/grep/glob/bash) siguen. Memoria es **extra**, visible con el mismo contrato. Lecturas no piden confirmación. `memory_save` / `memory_list` / `memory_forget` tampoco: no son write/edit/bash del workspace. En `plan` el disco no cambia; guardar un fact en API **está permitido** (el usuario lo pidió).
7. Un usuario = su vault. `memories` filtra `eq(userId)`. Sin org ni roles. El link de solo lectura no ve ni borra recuerdos ajenos.
8. 1 turn por daemon. Guardar memoria **no** abre un segundo turn. Compact RPC sigue usando el mismo lock; compact **no** llama a `/memories`.
9. Capa usuario vs workspace: analogía del plan 9 **solo en alcance**, no en semántica. Usuario = facts que siguen entre repos. Workspace = facts de **este** `workspaces.id` (path). No son instrucciones, no tienen `disallowTools`, no se mergen con AGENTS.md.
10. Compact de un chat (plan 10) appendea `compact_marker` en `chat_messages` de **ese** `chatId`. No DELETE, no UPDATE, no TRUNCATE sobre `memories`. El summarizer corre con `tools: []` — no puede `memory_forget`.
11. `@` sigue siendo archivos del workspace. Memoria no se adjunta con `@`. Varios facts se eligen uno a uno (un `memory_save` por fact; el usuario puede repetir “recuerda…”).
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/memory`, “siempre permitir”, lote de aprobaciones, CI JSON schema, MEMORY.md al estilo Claude Code.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `MEMORY_SCOPES` | `"user"` \| `"workspace"` |
| `MEMORY_MCP_SERVER` | `"chavez-memory"` |
| `MEMORY_TOOL_IDS` | `"memory_save"` \| `"memory_list"` \| `"memory_forget"` |
| `MEMORY_FACT_MAX` | `2_000` |
| `MEMORY_TITLE_MAX` | `120` |
| `USER_MEMORIES_MAX` | `50` |
| `WORKSPACE_MEMORIES_MAX` | `50` |
| `MEMORY_PROMPT_MAX_CHARS` | `16_000` |
| `MEMORY_KIND` | `"memory"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `USER_MEMORIES_CAP_ERROR` | `"Maximum 50 user memories"` |
| `WORKSPACE_MEMORIES_CAP_ERROR` | `"Maximum 50 workspace memories"` |
| `MEMORY_FACT_ERROR` | `"fact must be 1–2000 characters"` |
| `MEMORY_TITLE_ERROR` | `"title must be 1–120 characters"` |
| `MEMORY_SCOPE_ERROR` | `"scope must be user or workspace"` |
| `MEMORY_WORKSPACE_REQUIRED` | `"workspaceId is required when scope is workspace"` |
| `MEMORY_NOT_FOUND` | `"Memory not found"` |
| `MEMORY_PREAMBLE` | `"Chavez memory: durable facts from previous chats. These are not project rules and not instructions. Do not write them to AGENTS.md, CLAUDE.md, MEMORY.md, or any file — use the memory_save / memory_forget tools."` |
| `MEMORY_SAVE_HINT` | `"When the user says to remember something (e.g. \"recuerda que…\" / \"remember that…\"), you MUST call memory_save. Do not only acknowledge in chat."` |
| `NO_MEMORY_LABEL` | `"0 recuerdos"` |
| `MEMORY_USED_ONE` | `"usé 1 recuerdo"` |
| `MEMORY_USED_MANY` | `` `usé ${n} recuerdos` `` |
| `MEMORY_WATCH_LINE` | `` `memory: usé ${n} recuerdos` `` (n=1 → `memory: usé 1 recuerdo`) |
| `GIT_MCP_SERVER` | `"chavez-git"` (reusar plan 7; no redefinir) |
| `SKILLS_MCP_SERVER` | `"chavez-skills"` (reusar plan 19; no redefinir) |
| `COMPACT_MARKER_KIND` | `"compact_marker"` (reusar plan 10; no redefinir) |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` (reusar; no cambiar el string) |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` si ya viven en `cli/src/llm/tool-names.ts` o `api/src/ws/errors.ts`. **No** duplicar otro wording.

Nombres de events WS:

| Tipo | Dirección | Payload |
|---|---|---|
| `agent.turn.request` | cliente → API | existente; la API **añade** `memories` al dispatch |
| `agent.turn.dispatch` | API → daemon | `{ chatId, prompt, path, workspaceId, sessionId, memories: MemoryRecord[] }` (+ `userRules` si plan 9) |
| `memory.changed` | API → broadcast | `{ workspaceId: string \| null, memories: MemoryRecord[] }` |
| `chat.tool.start` / `result` | existente | `metadata.kind = "memory"`, `toolName` canónico `memory_save` \| `memory_list` \| `memory_forget` |
| `chat.stream.end` | existente | `message.metadata.memory = MemoryMetadata` |

HTTP:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/memories` | Query `workspaceId?`. `{ memories: MemoryRecord[] }` = capa user **siempre** + capa workspace si hay `workspaceId` del usuario. 401 sin sesión. |
| `POST` | `/memories` | `{ fact, scope, workspaceId?, title? }`. 400 validación/cap. `scope=workspace` exige `workspaceId` owned. |
| `DELETE` | `/memories/:id` | 404 si no es del `userId`. 200 `{ ok: true, id }`. |

Tras POST/DELETE: `hub.broadcastToUser` `memory.changed`. GET no.

Tipos (congelados):

```ts
export const MEMORY_SCOPES = ["user", "workspace"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TOOL_IDS = [
  "memory_save",
  "memory_list",
  "memory_forget",
] as const;
export type MemoryToolId = (typeof MEMORY_TOOL_IDS)[number];

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
```

SDK tool names (timeline canónica, nunca el prefix MCP como único label):

| SDK `toolName` | Canónico |
|---|---|
| `memory_save`, `mcp__chavez-memory__memory_save` | `memory_save` |
| `memory_list`, `mcp__chavez-memory__memory_list` | `memory_list` |
| `memory_forget`, `mcp__chavez-memory__memory_forget` | `memory_forget` |

`canonicalToolName` (plan 2): si `cli/src/llm/tool-names.ts` existe, añadir estas tres entradas. Si no, `cli/src/llm/memory-names.ts` exporta `canonicalMemoryToolName` y el display de Task 6/7 lo usa; cuando plan 2 aterrice, **mover** el map ahí.

Alcance (Gherkin):

| Fact guardado en | Chat nuevo, mismo workspace | Chat nuevo, **otro** `workspaces.id` (otro path/repo) |
|---|---|---|
| `scope=user` | inyectado | inyectado |
| `scope=workspace` | inyectado | **ausente** |

`N` en `usé N recuerdos` = `memories.length` **inyectadas al empezar el turn** (las que el modelo recibió). Un `memory_save` a mitad de turn se ve como tool card; no infla `used` de ese turn.

---

## Task 1: Módulos puros — constantes, validate, prompt, metadata, join

**Files:**

- Create: `cli/src/llm/memory-constants.ts`
- Create: `cli/src/llm/memory-format.ts`
- Test: `cli/src/llm/memory-format.test.ts`
- Modify: `cli/package.json`
- Modify: `cli/src/llm/tool-names.ts` (solo si el archivo **ya** existe; si no, Create: `cli/src/llm/memory-names.ts`)
- Test: `cli/src/llm/memory-names.test.ts` (o extender `tool-names.test.ts`)

Sin I/O de disco ni red. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Task 2 duplica validate/errors; Task 7 duplica labels.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/memory-constants.ts`:

```ts
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

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

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
  return n.startsWith(prefix) &&
    (MEMORY_TOOL_IDS as readonly string[]).includes(n.slice(prefix.length));
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
```

Si `NO_DAEMON_ERROR` ya está exportado, reexportar el mismo literal.

- [ ] Si `cli/src/llm/tool-names.ts` existe, añadir al map `CANONICAL`:

```ts
memory_save: "memory_save",
memory_list: "memory_list",
memory_forget: "memory_forget",
"mcp__chavez-memory__memory_save": "memory_save",
"mcp__chavez-memory__memory_list": "memory_list",
"mcp__chavez-memory__memory_forget": "memory_forget",
```

`toolClass` para esos nombres: `"other"` (no `"write"` — el gate de modo no debe pedir ask ni denegar en plan). `isMemoryToolName` se consulta **antes** del sandbox de path.

Si `tool-names.ts` **no** existe, crear `cli/src/llm/memory-names.ts` que reexporte `canonicalMemoryToolName` / `isMemoryToolName` desde constants (no inventar un segundo map).

- [ ] Crear `cli/src/llm/memory-format.ts`:

```ts
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
```

- [ ] Crear `cli/src/llm/memory-format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  MEMORY_FACT_ERROR,
  MEMORY_PREAMBLE,
  MEMORY_SAVE_HINT,
  MEMORY_SCOPE_ERROR,
  MEMORY_WORKSPACE_REQUIRED,
  memoryUsedLabel,
  memoryWatchLine,
} from "./memory-constants";
import {
  formatMemoryPrompt,
  joinSystemPrompts,
  memoryMetadata,
  parseSaveMemoryInput,
  selectMemoriesForPrompt,
  type MemoryRecord,
} from "./memory-format";

function rec(
  partial: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "scope" | "fact">,
): MemoryRecord {
  return {
    title: partial.title ?? partial.fact.slice(0, 20),
    workspaceId: partial.scope === "workspace" ? partial.workspaceId ?? "ws1" : null,
    createdAt: partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    ...partial,
  };
}

describe("parseSaveMemoryInput", () => {
  test("default scope is workspace and requires workspaceId", () => {
    expect(() => parseSaveMemoryInput({ fact: "use bun" })).toThrow(
      MEMORY_WORKSPACE_REQUIRED,
    );
    const ok = parseSaveMemoryInput({
      fact: "el paquete de tests es bun",
      workspaceId: "ws1",
    });
    expect(ok.scope).toBe("workspace");
    expect(ok.workspaceId).toBe("ws1");
    expect(ok.title).toContain("bun");
  });

  test("user scope nulls workspaceId", () => {
    const ok = parseSaveMemoryInput({
      fact: "responde en español",
      scope: "user",
      workspaceId: "ws1",
    });
    expect(ok.scope).toBe("user");
    expect(ok.workspaceId).toBeNull();
  });

  test("rejects empty fact and bad scope", () => {
    expect(() => parseSaveMemoryInput({ fact: "  ", scope: "user" })).toThrow(
      MEMORY_FACT_ERROR,
    );
    expect(() =>
      parseSaveMemoryInput({ fact: "x", scope: "org" }),
    ).toThrow(MEMORY_SCOPE_ERROR);
  });
});

describe("formatMemoryPrompt", () => {
  test("undefined when empty", () => {
    expect(formatMemoryPrompt([])).toBeUndefined();
    expect(formatMemoryPrompt(undefined)).toBeUndefined();
  });

  test("separates user and workspace and is facts not rules", () => {
    const text = formatMemoryPrompt([
      rec({
        id: "u1",
        scope: "user",
        fact: "responde en español",
        createdAt: "2026-09-16T01:00:00.000Z",
      }),
      rec({
        id: "w1",
        scope: "workspace",
        fact: "el paquete de tests es bun",
        createdAt: "2026-09-16T02:00:00.000Z",
      }),
    ]);
    expect(text).toContain(MEMORY_PREAMBLE);
    expect(text).toContain(MEMORY_SAVE_HINT);
    expect(text).toContain("el paquete de tests es bun");
    expect(text).toContain("responde en español");
    expect(text).not.toContain("disallowTools");
    expect(text).toContain("## User");
    expect(text).toContain("## Workspace");
  });
});

describe("selectMemoriesForPrompt", () => {
  test("keeps newest when over budget", () => {
    const rows = [
      rec({
        id: "old",
        scope: "user",
        fact: "OLD".repeat(100),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      rec({
        id: "new",
        scope: "user",
        fact: "NEW fact",
        createdAt: "2026-09-16T00:00:00.000Z",
      }),
    ];
    const kept = selectMemoriesForPrompt(rows, 400);
    expect(kept.some((r) => r.id === "new")).toBe(true);
  });
});

describe("memoryMetadata + labels", () => {
  test("used counts injected rows without bodies", () => {
    const meta = memoryMetadata([
      rec({ id: "w1", scope: "workspace", fact: "use bun", title: "bun" }),
    ]);
    expect(meta.used).toBe(1);
    expect(meta.applied[0]).not.toHaveProperty("fact");
    expect(memoryUsedLabel(1)).toBe("usé 1 recuerdo");
    expect(memoryUsedLabel(3)).toBe("usé 3 recuerdos");
    expect(memoryWatchLine(1)).toBe("memory: usé 1 recuerdo");
    expect(memoryUsedLabel(0)).toBe("0 recuerdos");
  });
});

describe("joinSystemPrompts", () => {
  test("skips empty and joins with separator", () => {
    expect(joinSystemPrompts(undefined, "  ")).toBeUndefined();
    expect(joinSystemPrompts("rules here", "memory here")).toContain("---");
    expect(joinSystemPrompts("rules here", "memory here")).toContain("memory here");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/memory-format.test.ts
```

Esperado: pass.

- [ ] Commit:

```bash
git add cli/src/llm/memory-constants.ts cli/src/llm/memory-format.ts \
  cli/src/llm/memory-format.test.ts cli/package.json \
  cli/src/llm/tool-names.ts cli/src/llm/tool-names.test.ts \
  cli/src/llm/memory-names.ts cli/src/llm/memory-names.test.ts
git commit -m "feat(memory): pure format, validate, and used-N labels"
```

Solo añadir a `git add` los archivos que existan en el working tree.

---

## Task 2: API — tabla `memories`, HTTP CRUD, attach al dispatch

**Files:**

- Create: `api/src/llm/memory-constants.ts`
- Test: `api/src/llm/memory-constants.test.ts`
- Create: `api/src/routes/memories.ts`
- Test: `api/src/routes/memories-validate.test.ts`
- Create: `api/drizzle/0031_memory.sql`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/package.json`

La API es la fuente de verdad. El daemon no tiene copia en disco.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Crear `api/src/llm/memory-constants.ts` copiando `MEMORY_SCOPES`, caps, `MEMORY_*_ERROR`, `MEMORY_WORKSPACE_REQUIRED`, `MEMORY_NOT_FOUND`, `isMemoryScope`, `titleFromFact` y un `parseSaveMemoryInput` **idéntico** al de CLI (comentario `keep-in-sync with cli/src/llm/memory-format.ts`). No importar `cli/`.

- [ ] Test `api/src/llm/memory-constants.test.ts`: fact vacío → `MEMORY_FACT_ERROR`; `scope: "org"` → `MEMORY_SCOPE_ERROR`; user nulls workspaceId; workspace sin id → `MEMORY_WORKSPACE_REQUIRED`; title default = primer renglón recortado a 120.

- [ ] En `api/src/db/schema.ts` añadir **después** de `chatMessages` (no reordenar tablas Better Auth):

```ts
export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").notNull(), // user | workspace
    title: text("title").notNull(),
    fact: text("fact").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memories_user_id_id_uidx").on(table.userId, table.id),
  ],
);
```

No tocar `workspaces_user_path_uidx`. `workspaceId` nullable: `scope=user` → `null`; al borrar un workspace, CASCADE solo las filas `scope=workspace` de ese id. Las de usuario quedan.

- [ ] Crear `api/drizzle/0031_memory.sql`. Si `0031_` ya existe por otro plan, usar el siguiente entero libre; el SQL es idempotente:

```sql
CREATE TABLE IF NOT EXISTS "memories" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "workspace_id" text REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "title" text NOT NULL,
  "fact" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "memories_user_id_id_uidx"
  ON "memories" ("user_id", "id");

CREATE INDEX IF NOT EXISTS "memories_user_scope_ws_idx"
  ON "memories" ("user_id", "scope", "workspace_id");
```

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

Si `DATABASE_URL` no está, fallar con el error de drizzle. No editar `docker-compose.yml`.

- [ ] Crear `api/src/routes/memories.ts`:

```ts
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { memories, workspaces } from "../db/schema";
import { hub } from "../ws/hub";
import type { Session } from "../auth";
import {
  MEMORY_NOT_FOUND,
  USER_MEMORIES_CAP_ERROR,
  USER_MEMORIES_MAX,
  WORKSPACE_MEMORIES_CAP_ERROR,
  WORKSPACE_MEMORIES_MAX,
  parseSaveMemoryInput,
} from "../llm/memory-constants";

export function publicMemory(row: typeof memories.$inferSelect) {
  return {
    id: row.id,
    scope: row.scope as "user" | "workspace",
    title: row.title,
    fact: row.fact,
    workspaceId: row.workspaceId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadMemoriesForTurn(input: {
  userId: string;
  workspaceId: string | null;
}) {
  const userRows = await db
    .select()
    .from(memories)
    .where(
      and(eq(memories.userId, input.userId), eq(memories.scope, "user")),
    )
    .orderBy(desc(memories.createdAt));
  if (!input.workspaceId) return userRows.map(publicMemory);
  const wsRows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, input.userId),
        eq(memories.scope, "workspace"),
        eq(memories.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(memories.createdAt));
  return [...userRows, ...wsRows]
    .sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map(publicMemory);
}

async function assertWorkspaceOwned(userId: string, workspaceId: string) {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export function createMemoryRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const workspaceId = c.req.query("workspaceId") || null;
    if (workspaceId) {
      const ws = await assertWorkspaceOwned(session.user.id, workspaceId);
      if (!ws) return c.json({ error: "Workspace not found" }, 404);
    }
    const list = await loadMemoriesForTurn({
      userId: session.user.id,
      workspaceId,
    });
    return c.json({ memories: list });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const json = await c.req.json().catch(() => ({}));
    let fields;
    try {
      fields = parseSaveMemoryInput(json);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    if (fields.scope === "workspace") {
      const ws = await assertWorkspaceOwned(session.user.id, fields.workspaceId!);
      if (!ws) return c.json({ error: "Workspace not found" }, 404);
    }
    const capWhere =
      fields.scope === "user"
        ? and(eq(memories.userId, session.user.id), eq(memories.scope, "user"))
        : and(
            eq(memories.userId, session.user.id),
            eq(memories.scope, "workspace"),
            eq(memories.workspaceId, fields.workspaceId!),
          );
    const existing = await db.select({ id: memories.id }).from(memories).where(capWhere);
    const cap = fields.scope === "user" ? USER_MEMORIES_MAX : WORKSPACE_MEMORIES_MAX;
    if (existing.length >= cap) {
      return c.json(
        {
          error:
            fields.scope === "user"
              ? USER_MEMORIES_CAP_ERROR
              : WORKSPACE_MEMORIES_CAP_ERROR,
        },
        400,
      );
    }
    const dup = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, session.user.id),
          eq(memories.scope, fields.scope),
          eq(memories.fact, fields.fact),
          fields.scope === "user"
            ? isNull(memories.workspaceId)
            : eq(memories.workspaceId, fields.workspaceId!),
        ),
      )
      .limit(1);
    if (dup[0]) {
      const row = publicMemory(dup[0]);
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("memory.changed", {
          workspaceId: row.workspaceId,
          memories: await loadMemoriesForTurn({
            userId: session.user.id,
            workspaceId: row.workspaceId,
          }),
        }),
      );
      return c.json({ memory: row, deduped: true });
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      workspaceId: fields.workspaceId,
      scope: fields.scope,
      title: fields.title!,
      fact: fields.fact,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(memories).values(row);
    const pub = publicMemory(row);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("memory.changed", {
        workspaceId: pub.workspaceId,
        memories: await loadMemoriesForTurn({
          userId: session.user.id,
          workspaceId: pub.workspaceId,
        }),
      }),
    );
    return c.json({ memory: pub }, 201);
  });

  app.delete("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const rows = await db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, session.user.id)))
      .limit(1);
    if (!rows[0]) return c.json({ error: MEMORY_NOT_FOUND }, 404);
    const prev = rows[0];
    await db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, session.user.id)));
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("memory.changed", {
        workspaceId: prev.workspaceId ?? null,
        memories: await loadMemoriesForTurn({
          userId: session.user.id,
          workspaceId: prev.workspaceId ?? null,
        }),
      }),
    );
    return c.json({ ok: true, id });
  });

  return app;
}
```

- [ ] Test `api/src/routes/memories-validate.test.ts` (puro, sin DB): reexportar/volver a testear `parseSaveMemoryInput` desde `api/src/llm/memory-constants.ts` (cap strings, default title). No levantar Hono aquí.

- [ ] En `api/src/index.ts`:

  1. `app.use("/memories", corsMiddleware);` y `app.use("/memories/*", corsMiddleware);` junto a los otros `app.use`.
  2. `import { createMemoryRoutes } from "./routes/memories";`
  3. `app.route("/memories", createMemoryRoutes(requireSession));`

- [ ] En `api/src/ws/protocol.ts`, ampliar `ClientMessage` **solo** si hace falta para tipar el dispatch interno. El cliente **no** manda `memories` en `agent.turn.request` (la API las carga). No hace falta campo nuevo en el request.

- [ ] En `api/src/ws/handlers.ts` `case "agent.turn.request"`: **después** de resolver `ctx.workspaceId` y **antes** de `hub.sendTo`:

```ts
import { loadMemoriesForTurn } from "../routes/memories";
// ...
const memoriesForTurn = await loadMemoriesForTurn({
  userId,
  workspaceId: ctx.workspaceId,
});
const sent = hub.sendTo(
  daemon.connectionId,
  hub.pushEvent("agent.turn.dispatch", {
    chatId: msg.chatId,
    prompt: msg.prompt.trim(),
    requestId: id,
    workspaceId: ctx.workspaceId,
    path: workspace?.path || daemon.path,
    sessionId: ctx.session.id,
    requesterConnectionId: connectionId,
    memories: memoriesForTurn,
  }),
);
```

Si plan 9 ya pone `userRules` en ese objeto, **añadir** `memories` al mismo payload; no reemplazar el dispatch.

`loadMemoriesForTurn` **no** falla el turn si la tabla está vacía (array `[]`).

- [ ] Commit:

```bash
git add api/src/llm/memory-constants.ts api/src/llm/memory-constants.test.ts \
  api/src/routes/memories.ts api/src/routes/memories-validate.test.ts \
  api/src/db/schema.ts api/drizzle/0031_memory.sql api/src/index.ts \
  api/src/ws/handlers.ts api/src/ws/protocol.ts api/package.json
git commit -m "feat(memory): persist user/workspace facts and attach them to turn dispatch"
```

---

## Task 3: MCP `chavez-memory` + inyección en el turn

**Files:**

- Create: `cli/src/llm/memory-api.ts`
- Create: `cli/src/llm/memory-mcp.ts`
- Test: `cli/src/llm/memory-mcp.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx` (solo pasar `memories` del dispatch / GET; el overlay es Task 6)
- Modify: `cli/src/llm/cursor-runner.ts` (solo si **ya** existe)
- Modify: `cli/src/llm/can-use-tool.ts` (solo si **ya** existe)

El modelo **debe** poder persistir cuando el usuario dice “recuerda que…”. Eso es un tool call, no un parser del compositor.

- [ ] Crear `cli/src/llm/memory-api.ts` — cliente HTTP inyectable (el MCP no habla Drizzle):

```ts
import { apiFetch } from "../api-client";
import type { MemoryRecord, SaveMemoryInput } from "./memory-format";

export type MemoryApi = {
  list: (workspaceId: string | null) => Promise<MemoryRecord[]>;
  save: (input: SaveMemoryInput) => Promise<MemoryRecord>;
  forget: (id: string) => Promise<void>;
};

export function createMemoryHttpApi(
  token: string | undefined,
  fallbackWorkspaceId: string | null,
): MemoryApi {
  return {
    async list(workspaceId) {
      const id = workspaceId ?? fallbackWorkspaceId;
      const q = id ? `?workspaceId=${encodeURIComponent(id)}` : "";
      const data = await apiFetch<{ memories: MemoryRecord[] }>(
        `/memories${q}`,
        {},
        token,
      );
      return data.memories ?? [];
    },
    async save(input) {
      const body = {
        ...input,
        workspaceId: input.workspaceId ?? fallbackWorkspaceId,
      };
      const data = await apiFetch<{ memory: MemoryRecord }>(
        "/memories",
        { method: "POST", body: JSON.stringify(body) },
        token,
      );
      return data.memory;
    },
    async forget(id) {
      await apiFetch(`/memories/${id}`, { method: "DELETE" }, token);
    },
  };
}
```

- [ ] Crear `cli/src/llm/memory-mcp.ts`:

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MEMORY_MCP_SERVER,
  MEMORY_SAVE_HINT,
  MEMORY_TOOL_IDS,
} from "./memory-constants";
import type { MemoryApi } from "./memory-api";
import { parseSaveMemoryInput } from "./memory-format";

export type MemoryMcpContext = {
  api: MemoryApi;
  workspaceId: string | null;
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function allowedMemoryMcpTools(): string[] {
  return [
    `mcp__${MEMORY_MCP_SERVER}__memory_save`,
    `mcp__${MEMORY_MCP_SERVER}__memory_list`,
    `mcp__${MEMORY_MCP_SERVER}__memory_forget`,
    ...MEMORY_TOOL_IDS,
  ];
}

export function createMemoryMcpServer(ctx: MemoryMcpContext) {
  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions: [
      "Memory stores durable facts across chats. Not project rules. Not files.",
      MEMORY_SAVE_HINT,
      "scope=workspace (default) for this repo (package manager, test runner, architecture).",
      "scope=user for personal prefs that apply to every workspace.",
      "Never write AGENTS.md / CLAUDE.md / MEMORY.md for this.",
    ].join(" "),
    tools: [
      tool(
        "memory_save",
        "Save a durable fact. workspace = this repo; user = every workspace. Never write it to a file.",
        {
          fact: z.string(),
          scope: z.enum(["user", "workspace"]).optional(),
          title: z.string().optional(),
        },
        async (args) => {
          try {
            const input = parseSaveMemoryInput({
              fact: args.fact,
              scope: args.scope,
              title: args.title,
              workspaceId: ctx.workspaceId,
            });
            const row = await ctx.api.save(input);
            return textResult(
              `saved ${row.scope} memory ${row.id}: ${row.title}`,
            );
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
      tool("memory_list", "List user + workspace memories visible in this turn.", {}, async () => {
        try {
          const rows = await ctx.api.list(ctx.workspaceId);
          if (!rows.length) return textResult("0 recuerdos");
          return textResult(
            rows
              .map((r) => `[${r.scope} ${r.id}] ${r.title}: ${r.fact}`)
              .join("\n"),
          );
        } catch (err) {
          return textResult(
            err instanceof Error ? err.message : String(err),
            true,
          );
        }
      }),
      tool(
        "memory_forget",
        "Delete a memory by id. Use memory_list if the id is unknown.",
        { id: z.string() },
        async (args) => {
          try {
            await ctx.api.forget(String(args.id));
            return textResult(`deleted ${args.id}`);
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
    ],
  });
}

export function mergeMemoryMcpServer(
  existing: Record<string, unknown> | undefined,
  server: unknown,
): Record<string, unknown> {
  return { ...(existing ?? {}), [MEMORY_MCP_SERVER]: server };
}
```

Los handlers **no** importan `node:fs`. Si el SDK de esta versión no acepta `alwaysLoad`, omitir esa key y dejar `instructions` + `allowedTools`.

- [ ] Test `cli/src/llm/memory-mcp.test.ts` con un `MemoryApi` fake (Map in-memory). **No** instanciar `query()`. Extraer los callbacks no es obligatorio si el fake API se testea vía un helper exportado:

Añadir en `memory-mcp.ts` (mismo archivo):

```ts
export async function runMemorySave(
  ctx: MemoryMcpContext,
  args: { fact: string; scope?: "user" | "workspace"; title?: string },
) {
  const input = parseSaveMemoryInput({
    ...args,
    workspaceId: ctx.workspaceId,
  });
  return ctx.api.save(input);
}
```

Tests:

  1. `runMemorySave` con `{ fact: "el paquete de tests es bun" }` y `workspaceId: "ws-a"` → `scope === "workspace"`, `workspaceId === "ws-a"`. El fake **no** tiene método `writeFile`.
  2. `scope: "user"` → `workspaceId` null en el save.
  3. Fake que lanza si alguien llama `writeFile` / `mkdir` — no se llama.
  4. `mergeMemoryMcpServer({ "chavez-git": 1 }, srv)` conserva `chavez-git` y añade `chavez-memory`.
  5. `isMemoryToolName("mcp__chavez-memory__memory_save") === true`.
  6. `allowedMemoryMcpTools()` incluye `memory_save`.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. Ampliar `RunClaudeTurnInput`:

```ts
appendSystemPrompt?: string;
memories?: import("./memory-format").MemoryRecord[];
memoryApi?: import("./memory-api").MemoryApi;
workspaceId?: string | null;
mcpServers?: Record<string, unknown>;
```

  2. Construir el server **por turn**:

```ts
import { createMemoryMcpServer, mergeMemoryMcpServer, allowedMemoryMcpTools } from "./memory-mcp";
import { applyMemoryToClaudeOptions, formatMemoryPrompt } from "./memory-format";

const memoryPrompt =
  input.appendSystemPrompt ?? formatMemoryPrompt(input.memories);
const memoryServer =
  input.memoryApi
    ? createMemoryMcpServer({
        api: input.memoryApi,
        workspaceId: input.workspaceId ?? null,
      })
    : null;
```

  3. Options:

```ts
let options: Record<string, unknown> = {
  model: input.model,
  cwd: input.cwd,
  env: cleanEnv,
  settingSources: [],
  permissionMode: /* existing: "default" if plan 2/3 landed, else keep current and do NOT add bypassPermissions back */,
};
options = applyMemoryToClaudeOptions(options, memoryPrompt);
if (memoryServer) {
  options.mcpServers = mergeMemoryMcpServer(
    (input.mcpServers ?? options.mcpServers) as Record<string, unknown> | undefined,
    memoryServer,
  );
  const prevTools = Array.isArray(options.allowedTools)
    ? (options.allowedTools as string[])
    : Array.isArray(options.tools)
      ? (options.tools as string[])
      : [];
  const extra = allowedMemoryMcpTools();
  const merged = [...new Set([...prevTools, ...extra])];
  if (Array.isArray(options.allowedTools) || prevTools.length) {
    options.allowedTools = merged;
  }
  if (Array.isArray(options.tools)) {
    options.tools = [...new Set([...(options.tools as string[]), ...extra])];
  }
}
```

Si plan 2 ya puso `tools: DEFAULT_CLAUDE_TOOLS` / `canUseTool` / `permissionMode: "default"`, **dejarlos**. Concatenar memory tools; no quitar Read/Write/…. Si plan 7/19 ya pusieron `mcpServers`, mergear — no asignar un dict de un solo server.

  4. `settingSources` permanece `[]`.

- [ ] `canUseTool`: si `cli/src/llm/can-use-tool.ts` (o el callback inline) existe, **al inicio**:

```ts
if (isMemoryToolName(toolName)) {
  return { behavior: "allow" };
}
```

No path sandbox. No ask. No `PLAN_MUTATION_DENIED`. Si aún no hay `canUseTool` (`bypassPermissions`), no inventarlo aquí.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Ampliar input:

```ts
memories?: import("./memory-format").MemoryRecord[];
workspaceId?: string | null;
userRules?: unknown;
userRulesEnabled?: boolean;
```

  2. **Antes** de `runClaudeTurn`:

```ts
import { createMemoryHttpApi } from "./memory-api";
import {
  formatMemoryPrompt,
  joinSystemPrompts,
  memoryMetadata,
} from "./memory-format";

const memoryApi = createMemoryHttpApi(token, input.workspaceId ?? null);
const memories =
  input.memories ??
  (await memoryApi.list(input.workspaceId ?? null).catch(() => []));
const memoryPrompt = formatMemoryPrompt(memories);
```

Si `loadTurnRules` existe (plan 9), `appendSystemPrompt = joinSystemPrompts(loaded.appendSystemPrompt, memoryPrompt)`. Si no, `appendSystemPrompt = memoryPrompt`.

  3. Pasar `appendSystemPrompt`, `memories`, `memoryApi`, `workspaceId` a `runClaudeTurn`.

  4. En `chat.stream.end`, mergear metadata (no pisar `rules` si ya se estampa):

```ts
const meta: Record<string, unknown> = {
  ...(existingMetadata || {}),
  memory: memoryMetadata(memories),
};
await client.request(
  {
    type: "chat.stream.end",
    chatId,
    streamId,
    content: result,
    metadata: meta,
  },
  60_000,
);
```

El handler de API ya hace `...(msg.metadata || {})` sobre el assistant. Si el turn falla antes del LLM (provider no runnable), **no** exigir `metadata.memory`.

  5. **No** `chat.append` `role=system` con el texto de memoria.

- [ ] En `cli/src/ws/daemon.ts`, el payload de `agent.turn.dispatch` ahora trae `memories` y `workspaceId`. Pasarlos a `publishAgentTurn`. Si `memories` falta (API vieja), `publishAgentTurn` hace GET `/memories?workspaceId=`.

- [ ] En `tui/src/App.tsx`, el `onPush` de `agent.turn.dispatch` pasa `memories` / `workspaceId` del push. En `sendWithLlm` (compose local): GET `/memories?workspaceId=${workspaceId}` y pasar el array. Si el GET falla, `memories: []` y el turn sigue (no bloquear compose).

- [ ] Si `cli/src/llm/cursor-runner.ts` existe, `prompt: applyMemoryToCursorPrompt(prompt, memoryPrompt)` (o join con rules) y el mismo `metadata.memory`. Si el runner Cursor acepta `local.customTools`, registrar las tres tools con los mismos handlers. Si **no** existe, no crearlo.

- [ ] Commit:

```bash
git add cli/src/llm/memory-api.ts cli/src/llm/memory-mcp.ts \
  cli/src/llm/memory-mcp.test.ts cli/src/llm/claude-runner.ts \
  cli/src/llm/publish-turn.ts cli/src/ws/daemon.ts tui/src/App.tsx \
  cli/src/llm/cursor-runner.ts cli/src/llm/can-use-tool.ts
git commit -m "feat(memory): inject facts into turns and persist via chavez-memory MCP"
```

---

## Task 4: Compact no borra memoria · alcance · no es un archivo

**Files:**

- Create: `cli/src/llm/memory-isolation.test.ts`
- Modify: `cli/src/llm/compact.ts` (solo si existe; comentario + test, **no** cambiar el algoritmo)
- Modify: `cli/src/llm/compact-run.ts` (solo si existe: assert `tools: []` / sin `chavez-memory`)
- Modify: `cli/src/llm/history.ts` (no persistir memoria como system; no hace falta cambio si Task 3 no appendea)
- Modify: `api/src/ws/handlers.ts` (solo si existe `chat.compact`: **no** importar `memories` para DELETE)

Esta task es la regresión de los escenarios Gherkin “No es una regla de archivo”, “Alcance” y “Compact”.

- [ ] Crear `cli/src/llm/memory-isolation.test.ts` (un solo archivo, copiar tal cual):

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { MEMORY_MCP_SERVER, MEMORY_PREAMBLE } from "./memory-constants";
import { formatMemoryPrompt, type MemoryRecord } from "./memory-format";
import { historyFromChatMessages } from "./history";
import { runMemorySave, type MemoryMcpContext } from "./memory-mcp";

const bunFact = "el paquete de tests es bun";

function rec(
  id: string,
  scope: "user" | "workspace",
  fact: string,
  ws: string | null,
): MemoryRecord {
  return {
    id,
    scope,
    title: fact.slice(0, 40),
    fact,
    workspaceId: ws,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("alcance", () => {
  test("workspace memory does not fly to another workspace; user memory does", () => {
    const user = rec("u1", "user", "responde en español", null);
    const wsA = rec("wA", "workspace", bunFact, "ws-A");
    const forA = [user, wsA];
    const forB = [user];
    const a = formatMemoryPrompt(forA)!;
    const b = formatMemoryPrompt(forB)!;
    expect(a).toContain(bunFact);
    expect(a).toContain("responde en español");
    expect(b).toContain("responde en español");
    expect(b).not.toContain(bunFact);
  });
});

describe("no es una regla de archivo", () => {
  test("memory_save talks to MemoryApi only — source never writes AGENTS.md", async () => {
    const saved: MemoryRecord[] = [];
    const ctx: MemoryMcpContext = {
      workspaceId: "ws-A",
      api: {
        list: async () => saved,
        save: async (input) => {
          const row = rec(
            "m1",
            input.scope,
            input.fact,
            input.workspaceId ?? "ws-A",
          );
          saved.push(row);
          return row;
        },
        forget: async () => {},
      },
    };
    await runMemorySave(ctx, { fact: bunFact });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.fact).toBe(bunFact);
    expect(saved[0]!.scope).toBe("workspace");

    const mcpSrc = readFileSync(new URL("./memory-mcp.ts", import.meta.url), "utf8");
    expect(mcpSrc).not.toMatch(/from ["']node:fs["']/);
    expect(mcpSrc).not.toMatch(/writeFileSync|AGENTS\.md|MEMORY\.md|CLAUDE\.md/);

    const prompt = formatMemoryPrompt(saved)!;
    expect(prompt).toContain(MEMORY_PREAMBLE);
    expect(prompt).not.toContain("disallowTools");
  });
});

describe("compact no borra memoria global", () => {
  test("compact_marker in chat history does not remove formatMemoryPrompt facts", () => {
    const mem = [rec("wA", "workspace", bunFact, "ws-A")];
    const history = historyFromChatMessages(
      [
        { role: "user", content: "hola" },
        { role: "assistant", content: "ok" },
        { role: "system", content: "contexto compactado" },
      ],
      "siguiente",
    );
    expect(formatMemoryPrompt(mem)).toContain(bunFact);
    expect(history.some((m) => m.content.includes(bunFact))).toBe(false);
  });

  test("compact source does not import or delete memories", () => {
    if (existsSync(new URL("./compact.ts", import.meta.url))) {
      const src = readFileSync(new URL("./compact.ts", import.meta.url), "utf8");
      expect(src).not.toMatch(/from ["'].*memory/);
      expect(src).not.toMatch(/DELETE\s+FROM\s+memories/i);
      expect(src).not.toContain("memory_forget");
    }
    if (existsSync(new URL("./compact-run.ts", import.meta.url))) {
      const src = readFileSync(
        new URL("./compact-run.ts", import.meta.url),
        "utf8",
      );
      expect(src).not.toContain(MEMORY_MCP_SERVER);
      expect(src).toMatch(/tools:\s*\[\s*\]/);
    }
  });
});

describe("chat nuevo lo ve", () => {
  test("empty chat history still injects memory prompt", () => {
    const history = historyFromChatMessages([], "empieza");
    expect(history).toEqual([]);
    const prompt = formatMemoryPrompt([
      rec("wA", "workspace", bunFact, "ws-A"),
    ]);
    expect(prompt).toContain(bunFact);
  });
});
```

- [ ] Si `cli/src/llm/compact.ts` existe, añadir al encabezado del archivo:

```ts
/** Compact mutates chat_messages of one chat. It must never read or delete `memories`. */
```

No cambiar `splitCompactWindow` / summarizer.

- [ ] Si `api/src/ws/handlers.ts` tiene `case "chat.compact"`, grep del case: cero `db.delete(memories)` / `from(memories)`. No reescribir compact.

- [ ] Correr:

```bash
cd cli && bun test src/llm/memory-isolation.test.ts src/llm/memory-format.test.ts src/llm/memory-mcp.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/memory-isolation.test.ts cli/src/llm/compact.ts \
  cli/src/llm/compact-run.ts
git commit -m "test(memory): isolate facts from compact, files, and other workspaces"
```

---

## Task 5: CLI — `chavez memory` y `watch`

**Files:**

- Create: `cli/src/commands/memory.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/commands/headless.ts`

CRUD de usuario **no** necesita daemon. `add --scope workspace` usa el `workspaceId` del cwd abierto o flag `--workspace`.

- [ ] Crear `cli/src/commands/memory.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { readWorkspaceState, cwdPath } from "../workspace";
import type { MemoryRecord } from "../llm/memory-format";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

function currentWorkspaceId(flag?: string): string | undefined {
  if (flag) return flag;
  const st = readWorkspaceState(cwdPath());
  return st?.workspaceId;
}

export async function memoryCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const wsFlag = rest[0] === "--workspace" ? rest[1] : undefined;
    const workspaceId = currentWorkspaceId(wsFlag);
    const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const data = await apiFetch<{ memories: MemoryRecord[] }>(
      `/memories${q}`,
      {},
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "add") {
    let scope: "user" | "workspace" = "workspace";
    let workspaceId: string | undefined;
    const parts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--scope") {
        const v = rest[++i];
        if (v !== "user" && v !== "workspace") {
          throw new Error("Uso: chavez memory add [--scope user|workspace] [--workspace <id>] <fact…>");
        }
        scope = v;
        continue;
      }
      if (a === "--workspace") {
        workspaceId = rest[++i];
        continue;
      }
      parts.push(a);
    }
    const fact = parts.join(" ").trim();
    if (!fact) {
      throw new Error("Uso: chavez memory add [--scope user|workspace] [--workspace <id>] <fact…>");
    }
    if (scope === "workspace") {
      workspaceId = currentWorkspaceId(workspaceId);
      if (!workspaceId) {
        throw new Error(
          "workspaceId is required when scope is workspace (abre el cwd con chavez headless workspace open o pasa --workspace)",
        );
      }
    }
    const data = await apiFetch(
      "/memories",
      {
        method: "POST",
        body: JSON.stringify({ fact, scope, workspaceId }),
      },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "rm") {
    const id = rest[0];
    if (!id) throw new Error("Uso: chavez memory rm <id>");
    const data = await apiFetch(`/memories/${id}`, { method: "DELETE" }, token());
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("Uso: chavez memory list|add|rm");
}
```

- [ ] En `cli/src/index.ts` añadir `case "memory": await memoryCommand(rest);` y en `usage()`:

```
  chavez memory list|add|rm
  chavez headless memory list|add|rm
```

Importar `memoryCommand` desde `./commands/memory`.

- [ ] En `cli/src/commands/headless.ts`, grupo `memory` **antes** del `throw Grupo desconocido` (HTTP, no exige `ensureClient` para list/add/rm de usuario; workspace add sí necesita id):

```ts
if (group === "memory") {
  const { memoryCommand } = await import("./memory");
  await memoryCommand([action, ...rest].filter((x): x is string => x != null));
  return;
}
```

O inlinear la misma lógica sin dynamic import: `await memoryCommand(args.slice(1))` cuando `group === "memory"` — más simple:

```ts
if (group === "memory") {
  await memoryCommand([action ?? "list", ...rest]);
  return;
}
```

Import estático arriba. Actualizar el error de grupo desconocido para incluir `memory`. Actualizar el `Uso: chavez headless <workspace|session|chat|connections>` → añadir `memory`.

- [ ] En `chat watch` (`headless.ts` `onPush`): si `msg.type === "chat.stream.end"`, leer `data.message.metadata.memory.used` y `console.error(memoryWatchLine(used))` además del JSON. Importar `memoryWatchLine`. Si no hay `metadata.memory` o `used === 0`, no imprimir error (silencio).

Si plan 2 añadió `formatWatchLine`, extenderlo:

```ts
if (type === "chat.stream.end") {
  const used = Number(
    (data as { message?: { metadata?: { memory?: { used?: number } } } })
      ?.message?.metadata?.memory?.used ?? 0,
  );
  if (used > 0) return memoryWatchLine(used);
}
```

No romper el JSON dump: el `console.error` de la línea humana va a stderr; stdout sigue JSON.

- [ ] Commit:

```bash
git add cli/src/commands/memory.ts cli/src/index.ts cli/src/commands/headless.ts \
  cli/src/llm/watch-format.ts
git commit -m "feat(memory): CLI list/add/rm and watch used-N line"
```

---

## Task 6: TUI — tecla `y`, overlay, chip, borrar

**Files:**

- Modify: `tui/src/App.tsx`

TUI **es** daemon: el turn ya inyecta (Task 3). Esta task es listar/borrar y el chip.

- [ ] Ampliar `type Message` con `metadata?: Record<string, unknown>` si plan 2/9 no lo hizo.

- [ ] State nuevo:

```ts
const [memoryOverlay, setMemoryOverlay] = useState(false);
const [memoryList, setMemoryList] = useState<MemoryRecord[]>([]);
const [memoryCursor, setMemoryCursor] = useState(0);
```

Importar `MemoryRecord` y `memoryUsedLabel` desde `cli/src/llm/memory-format.ts` / `memory-constants.ts`.

Tras bind (junto al GET `/providers`):

```ts
async function refreshMemories(wsId: string | null) {
  if (!token) return;
  const q = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : "";
  try {
    const data = await apiFetch<{ memories: MemoryRecord[] }>(
      `/memories${q}`,
      {},
      token,
    );
    setMemoryList(data.memories ?? []);
    setMemoryCursor((c) => clampIndex(c, data.memories?.length ?? 0));
  } catch {
    // overlay shows empty; turn still runs
  }
}
```

Llamar `refreshMemories(ws?.id ?? null)` al bind. En `onPush`, si `msg.type === "memory.changed"`, `refreshMemories(workspaceId)`.

- [ ] En `useInput`, **no** interceptar `y` en modo compose (es texto). En command mode, **antes** de `q`:

  - Si `memoryOverlay` y `key.escape`: cerrar overlay, no exit.
  - Si `memoryOverlay` y `key.upArrow` / `downArrow`: mover `memoryCursor`.
  - Si `memoryOverlay` y `ch === "d"`: DELETE `/memories/${memoryList[memoryCursor].id}`, luego `refreshMemories`. Log `recuerdo borrado`. 404 → log `Memory not found`.
  - Si no overlay y `ch === "y"`: abrir overlay y `refreshMemories(workspaceId)`.

No interceptar `y` mientras `busy` para navegación del overlay (borrar sí se bloquea si `busy`, igual que otras mutaciones). Abrir overlay **sí** se permite durante busy (solo lectura).

- [ ] Overlay (cuando `memoryOverlay`): un `Box` extra encima del footer:

```
Memoria  user=${nUser} workspace=${nWs}
[d] borrar  [esc] cerrar
> [user] idioma  responde en español
  [workspace] bun  el paquete de tests es bun
```

Sin volcar facts enormes: `fact` recortado a 80 chars. Badge de `scope`. Si lista vacía: `0 recuerdos`.

- [ ] En la lista de Messages, si `m.role === "assistant"` y `m.metadata?.memory`:

```tsx
const mem = (m.metadata as { memory?: { used?: number } } | undefined)?.memory;
{mem && mem.used ? (
  <Text dimColor> {memoryUsedLabel(mem.used)}</Text>
) : null}
```

Pintar en la misma línea del assistant o en la siguiente; no el body de cada fact.

Si `m.role === "tool"` y `canonicalMemoryToolName(meta.toolName)` es una de las tres, pintar `tool · memory_save · done` (mismo patrón que plan 2 si `ToolCard` TUI no existe: `role: content` ya muestra el nombre).

- [ ] Footer de ayuda: añadir `[y] memoria`.

```
[Tab] listas  [↑↓]  [Enter] abrir  [s][c][m]  [y] memoria  [p]  [q]
```

No reordenar el resto de teclas de siblings.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(memory): TUI overlay to list/delete and used-N chip"
```

---

## Task 7: Web — `/memory`, panel workspace, chip, borrar

**Files:**

- Create: `web/src/lib/memory-display.ts`
- Create: `web/src/components/MemoryPanel.tsx`
- Create: `web/src/pages/memory.astro`
- Modify: `web/src/layouts/BaseLayout.astro`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/ws-context.tsx` (invalidar en `memory.changed` si el listener global existe; si no, en los paneles)

Web **no** importa `cli/`. Keep-in-sync de labels.

- [ ] Crear `web/src/lib/memory-display.ts`:

```ts
/** keep-in-sync with cli/src/llm/memory-constants.ts */
export function memoryUsedLabel(n: number): string {
  if (n <= 0) return "0 recuerdos";
  if (n === 1) return "usé 1 recuerdo";
  return `usé ${n} recuerdos`;
}
```

- [ ] `queryKeys.memories = (workspaceId?: string | null) => ["memories", workspaceId ?? "user"] as const`.

- [ ] Tipos + hooks en `web/src/lib/hooks.ts`:

```ts
export type MemoryScope = "user" | "workspace";
export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  title: string;
  fact: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function useMemories(workspaceId: string | null | undefined, enabled = true) {
  const q = workspaceId
    ? `/memories?workspaceId=${encodeURIComponent(workspaceId)}`
    : "/memories";
  return useQuery({
    queryKey: queryKeys.memories(workspaceId ?? null),
    queryFn: () => apiJson<{ memories: MemoryRecord[] }>(q),
    enabled,
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      fact: string;
      scope: MemoryScope;
      workspaceId?: string | null;
      title?: string;
    }) =>
      apiJson<{ memory: MemoryRecord }>("/memories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["memories"] });
    },
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiJson<{ ok: boolean }>(`/memories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["memories"] });
    },
  });
}
```

- [ ] En cada isla que liste recuerdos, `ws.onPush`: si `ev.type === "memory.changed"`, `qc.invalidateQueries({ queryKey: ["memories"] })`.

- [ ] `MemoryPanel.tsx` (página cuenta, **sin daemon**):

  1. GET `/memories` (sin query) → solo capa user (el GET sin `workspaceId` devuelve user; documentado en Task 2).
  2. Lista: título, fact, fecha, botón **Borrar** (DELETE uno a uno; sin lote, sin “siempre”).
  3. Form crear: textarea fact, radio/select `scope=user` (en esta página el default es **user**; no hay workspace). Submit POST `{ fact, scope: "user" }`.
  4. Copy: “Esto no es AGENTS.md. Los facts cruzan chats y workspaces. Bórralos aquí o en la TUI.”

- [ ] `web/src/pages/memory.astro`:

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import { MemoryPanel } from "../components/MemoryPanel";
---

<BaseLayout title="Memoria">
  <MemoryPanel client:only="react" />
</BaseLayout>
```

Igual que `providers.astro` (`prerender` default).

- [ ] `BaseLayout.astro` nav: `<a href="/memory">Memoria</a>` junto a Workspaces.

- [ ] `HubPanel.tsx`: enlace `<a href="/memory">Memoria</a>` junto a providers/workspaces.

- [ ] `WorkspaceDetailPanel.tsx`: sección “Memoria de este workspace”:

  1. `useMemories(workspaceId, signedIn)` — trae user **y** workspace (GET con query).
  2. Dos listas: “Usuario (todos los repos)” con link a `/memory`, y “Este workspace” con botón Borrar por fila.
  3. Form “Añadir recuerdo de workspace”: textarea + POST `{ fact, scope: "workspace", workspaceId }`. **No** requiere daemon.
  4. No mostrar un editor de AGENTS.md aquí (eso es plan 9).

- [ ] `ChatDetailPanel.tsx`: en mensajes `assistant`, si `metadata.memory`:

```tsx
const memory = (m.metadata as { memory?: { used?: number; applied?: Array<{ id: string; scope: string; title: string }> } })?.memory;
{memory && memory.used > 0 && (
  <details>
    <summary className="muted">{memoryUsedLabel(memory.used)}</summary>
    <ul>
      {memory.applied?.map((r) => (
        <li key={r.id}>
          <span className="badge">{r.scope}</span> {r.title}
        </li>
      ))}
    </ul>
  </details>
)}
```

**No** pintar `fact` en la timeline (el overlay/página sí). Invalidar `queryKeys.chat` ya ocurre en `chat.stream.end`.

Si `ToolCard` ve `meta.kind === "memory"` o `toolName` `memory_save`/`memory_list`/`memory_forget`, el badge es `tool · memory_save · done` — mismo componente, no un card especial.

- [ ] Commit:

```bash
git add web/src/lib/memory-display.ts web/src/components/MemoryPanel.tsx \
  web/src/pages/memory.astro web/src/layouts/BaseLayout.astro \
  web/src/components/HubPanel.tsx web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/ChatDetailPanel.tsx web/src/lib/hooks.ts \
  web/src/lib/query-keys.ts web/src/lib/ws-context.tsx
git commit -m "feat(memory): Web list/delete and used-N chip on the timeline"
```

---

## Task 8: OpenAPI + contrato WS documentado

**Files:**

- Modify: `api/openapi/openapi.yaml`

- [ ] Tag `Memory` en `tags:` (después de `Chats`).

- [ ] Paths:

```yaml
  /memories:
    get:
      tags: [Memory]
      summary: Listar recuerdos de usuario y, si hay workspaceId, los de ese workspace
      operationId: listMemories
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - in: query
          name: workspaceId
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/MemoriesResponse"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          description: Workspace not found
    post:
      tags: [Memory]
      summary: Guardar un fact (user o workspace). No escribe AGENTS.md.
      operationId: createMemory
      security:
        - bearerAuth: []
        - cookieAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateMemoryRequest"
      responses:
        "201":
          description: Created
        "400":
          description: Validación o cap 50
        "401":
          $ref: "#/components/responses/Unauthorized"
  /memories/{id}:
    delete:
      tags: [Memory]
      summary: Borrar un recuerdo propio
      operationId: deleteMemory
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Deleted
        "404":
          description: Memory not found
```

Schemas:

```yaml
    MemoryRecord:
      type: object
      required: [id, scope, title, fact, createdAt, updatedAt]
      properties:
        id: { type: string }
        scope: { type: string, enum: [user, workspace] }
        title: { type: string }
        fact: { type: string }
        workspaceId: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
    MemoriesResponse:
      type: object
      required: [memories]
      properties:
        memories:
          type: array
          items: { $ref: "#/components/schemas/MemoryRecord" }
    CreateMemoryRequest:
      type: object
      required: [fact]
      properties:
        fact: { type: string, minLength: 1, maxLength: 2000 }
        scope: { type: string, enum: [user, workspace], default: workspace }
        workspaceId: { type: string }
        title: { type: string, maxLength: 120 }
    MemoryMetadata:
      type: object
      properties:
        used: { type: integer }
        applied:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              scope: { type: string, enum: [user, workspace] }
              title: { type: string }
```

En la descripción del tag WebSocket, documentar `memory.changed` y que `agent.turn.dispatch` incluye `memories[]`. `chat.stream.end` puede traer `message.metadata.memory`.

No documentar slash `/memory`.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml
git commit -m "docs(memory): OpenAPI for /memories and turn metadata"
```

---

## Task 9: Smoke Gherkin — los cinco escenarios

**Files:**

- Create: `cli/scripts/memory-smoke.ts`
- Create: `api/scripts/e2e-memory.ts`
- Modify: `cli/package.json` (script opcional `"test:memory": "bun run scripts/memory-smoke.ts"`)
- Modify: `api/package.json` (script opcional `"test:e2e:memory": "bun run scripts/e2e-memory.ts"`)

Cubre las cinco cláusulas con asserts concretos. El turn live (Claude) se salta con exit 0 y un log si no hay token/daemon; HTTP + format + aislamiento **siempre** corren.

- [ ] Crear `cli/scripts/memory-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { formatMemoryPrompt, memoryMetadata, parseSaveMemoryInput } from "../src/llm/memory-format";
import { memoryUsedLabel } from "../src/llm/memory-constants";
import { historyFromChatMessages } from "../src/llm/history";
import { runMemorySave, mergeMemoryMcpServer } from "../src/llm/memory-mcp";
import type { MemoryRecord } from "../src/llm/memory-format";
import type { MemoryApi } from "../src/llm/memory-api";

const bunFact = "el paquete de tests es bun";

function rec(
  id: string,
  scope: "user" | "workspace",
  fact: string,
  ws: string | null,
): MemoryRecord {
  return {
    id,
    scope,
    title: fact.slice(0, 40),
    fact,
    workspaceId: ws,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function fakeApi(store: MemoryRecord[]): MemoryApi {
  return {
    list: async (workspaceId) =>
      store.filter(
        (m) => m.scope === "user" || m.workspaceId === workspaceId,
      ),
    save: async (input) => {
      const row = rec(
        crypto.randomUUID(),
        input.scope,
        input.fact,
        input.scope === "user" ? null : input.workspaceId ?? "ws-A",
      );
      store.push(row);
      return row;
    },
    forget: async (id) => {
      const i = store.findIndex((m) => m.id === id);
      if (i >= 0) store.splice(i, 1);
    },
  };
}

// 1. Guardar recuerdo + chat nuevo lo ve
{
  const store: MemoryRecord[] = [];
  const api = fakeApi(store);
  await runMemorySave(
    { api, workspaceId: "ws-A" },
    { fact: bunFact, scope: "workspace" },
  );
  assert.equal(store.length, 1);
  const emptyHistory = historyFromChatMessages([], "hola chat nuevo");
  assert.equal(emptyHistory.length, 0);
  const injected = formatMemoryPrompt(await api.list("ws-A"));
  assert.ok(injected && injected.includes(bunFact));
}

// 2. No es una regla de archivo
{
  const store: MemoryRecord[] = [];
  await runMemorySave(
    { api: fakeApi(store), workspaceId: "ws-A" },
    { fact: bunFact },
  );
  assert.equal(store[0]?.fact, bunFact);
  const prompt = formatMemoryPrompt(store)!;
  assert.ok(prompt.includes("not project rules") || prompt.includes("not instructions") || prompt.includes("Do not write"));
  assert.ok(!prompt.includes("disallowTools"));
}

// 3. Alcance
{
  const user = rec("u1", "user", "responde en español", null);
  const wsA = rec("wA", "workspace", bunFact, "ws-A");
  const forB = [user];
  const b = formatMemoryPrompt(forB)!;
  assert.ok(b.includes("responde en español"));
  assert.ok(!b.includes(bunFact));
  const a = formatMemoryPrompt([user, wsA])!;
  assert.ok(a.includes(bunFact));
}

// 4. Visible — listar/borrar + usé N
{
  const store = [
    rec("wA", "workspace", bunFact, "ws-A"),
    rec("u1", "user", "responde en español", null),
  ];
  const api = fakeApi(store);
  const listed = await api.list("ws-A");
  assert.equal(listed.length, 2);
  await api.forget("wA");
  assert.equal((await api.list("ws-A")).length, 1);
  const meta = memoryMetadata([store[1]!]);
  assert.equal(memoryUsedLabel(meta.used), "usé 1 recuerdo");
}

// 5. Compact no borra memoria global
{
  const mem = [rec("wA", "workspace", bunFact, "ws-A")];
  historyFromChatMessages(
    [
      { role: "user", content: "largo" },
      { role: "system", content: "contexto compactado" },
    ],
    "siguiente",
  );
  assert.ok(formatMemoryPrompt(mem)!.includes(bunFact));
}

assert.ok(
  mergeMemoryMcpServer({ "chavez-git": { n: 1 } }, { n: 2 })["chavez-git"],
);

console.log("memory-smoke ok");
```

El script es top-level await (`bun run`). `assert` + `process.exit(1)` implícito si lanza.

- [ ] Crear `api/scripts/e2e-memory.ts` al estilo de `api/scripts/e2e-phase1.ts` (signup dos users, cookie/bearer). Si e2e-phase1 exporta helpers, reutilizarlos; si no, duplicar el signup mínimo (email+password o magic-link test) **sin** imprimir secrets.

Escenarios HTTP:

  1. User A `POST /memories` `{ fact: "el paquete de tests es bun", scope: "workspace", workspaceId: <A.ws> }` → 201. `GET /memories?workspaceId=<A.ws>` contiene el fact.
  2. User A `POST /memories` `{ fact: "responde en español", scope: "user" }` → 201. `GET /memories` (sin query) lo trae. `GET /memories?workspaceId=<A.otroWorkspace>` (crear segundo workspace con **otro path**) trae el fact de usuario y **no** el de workspace del primero.
  3. User B `GET /memories` **no** ve los de A. User B `DELETE` del id de A → **404**.
  4. `DELETE /memories/:id` de A → 200; GET ya no lo lista (borrar desde “Web/TUI”).
  5. `POST` fact vacío → 400 `fact must be 1–2000 characters`. 51º user memory → 400 `Maximum 50 user memories` (insertar 50 cortos y el 51 falla; o mockear el cap en unit y aquí insertar 2 + documentar el cap test en unit de constants — **preferir**: loop 50 `f-${i}` y el 51 es 400; si el test se vuelve lento, cap check unitario ya cubre el string y e2e inserta 2).
  6. Sin cookie → **401**.
  7. `POST` no crea filas en un archivo: el e2e no toca cwd. Assert de respuesta JSON only.

Cap 50: en e2e insertar **2** facts y dejar el 51 al unit `USER_MEMORIES_MAX` (ya testeado el string). Comentario en el script: “cap cubierto en memory-constants.test / parse”.

- [ ] Correr:

```bash
cd cli && bun test src/llm/memory-format.test.ts src/llm/memory-mcp.test.ts \
  src/llm/memory-isolation.test.ts
cd cli && bun run scripts/memory-smoke.ts
cd api && bun test src/llm/memory-constants.test.ts
cd api && bun run scripts/e2e-memory.ts
```

Esperado: exit 0. Si la API/DB no está arriba, el e2e falla explícito (no silenciar). Los unit tests y `memory-smoke.ts` no necesitan API ni Claude.

Turn live opcional (no falla el script): si `CHAVEZ_ACCESS_TOKEN` + daemon bound, el operador puede:

```bash
chavez headless chat ask <chatId> "recuerda que el paquete de tests es bun"
chavez memory list
# fact presente
chavez headless chat create <sessionId> "chat nuevo"
chavez headless chat ask <newChatId> "¿qué paquete de tests uso?"
# el dispatch inyectó el fact; watch muestra memory: usé N recuerdos
```

Eso **no** es un test CI obligatorio (depende de Claude). El smoke cubre el contrato.

- [ ] Commit:

```bash
git add cli/scripts/memory-smoke.ts api/scripts/e2e-memory.ts \
  cli/package.json api/package.json
git commit -m "test(memory): gherkin smokes for save, scope, delete, compact isolation"
```

---

## Orden de implementación y riesgos

1. Task 1 (puro) puede mergear solo. Task 2 (API) desbloquea CLI/Web/TUI CRUD sin runner.
2. Task 3 cablea “cuando digo recuerda que…”. Sin Task 3, el usuario aún puede `POST /memories` a mano y el chat nuevo **no** lo ve hasta que el dispatch adjunte (Task 2) **y** `publishAgentTurn` inyecte (Task 3). Las dos hacen falta para el escenario Guardar.
3. Task 4 es regresión: correrla en cuanto existan format + mcp fake; no esperar compact mergeado (el test `existsSync` salta el grep si plan 10 no aterrizó).
4. Tasks 5–7 son superficies. Web borrar **no** espera daemon. TUI `y` tampoco.
5. Si plan 9 aún no aterrizó, `joinSystemPrompts(undefined, memoryPrompt)` es solo memoria. Cuando aterrice, **una** llamada `joinSystemPrompts(rules, memory)` en `publish-turn.ts`.
6. Si plan 2 aún no aterrizó, `permissionMode` puede seguir `bypassPermissions`; memory MCP igual corre. Al aterrizar `canUseTool`, el allow de `isMemoryToolName` es obligatorio o el gate de `other` en plan podría denegar.
7. Riesgo: `createSdkMcpServer` + `allowedTools`. Si la versión del SDK exige ids `mcp__chavez-memory__memory_save`, `allowedMemoryMcpTools()` ya los incluye **y** los bare ids.
8. Riesgo: `zod` v4 vs v3 en `tool()`. Usar `z.string()` del `zod` de `cli/package.json` (igual que plan 7).
9. Riesgo: `appendSystemPrompt` de rules + memory. Siempre `joinSystemPrompts`, nunca dos keys.
10. Riesgo: compact summarizer con tools por defecto del SDK. Plan 10 ya pone `tools: []`; Task 4 lo afirma. No registrar `chavez-memory` en `compact-run.ts`.
11. No implementar slash `/memory`. El compositor no intercepta “recuerda que”.
12. No escribir `MEMORY.md`. Si el modelo llama Write `AGENTS.md`, es el plan 9/2 (modo + reglas), no esta fase.

## Verificación manual (cuando el stack corre)

```bash
# terminal A
chavez login && chavez provider link claude
chavez headless workspace open   # repo A
# terminal B
chavez tui                       # tecla y: 0 recuerdos
# Web /memory — crear “responde en español” scope user
# Web workspace A — crear “el paquete de tests es bun” scope workspace
# Chat: “recuerda que el linter es biome” → tool memory_save · done
chavez memory list               # tres facts
# Chat nuevo mismo workspace: el assistant chip “usé N recuerdos”; responde con bun
# Otro cwd (repo B): chavez headless workspace open
# Chat nuevo: ve “español”, NO ve bun ni biome
# Compactar chat viejo (plan 10): chavez memory list intacto
# Web / TUI [y]+[d]: borrar biome; el siguiente turn ya no lo inyecta
```
