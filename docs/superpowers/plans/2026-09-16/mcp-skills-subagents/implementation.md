# MCP Skills Subagents Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, marketplace de MCP/skills (plan 36), slash `/mcp` `/skill` (plan 11), cola de turns (plan 29), worktrees paralelos (plan 28), sandbox de red (plan 26), voz, extensión IDE, upload desde el navegador, ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Depende de tools ([`agent-tools`](../agent-tools/implementation.md)), modos ([`execution-modes`](../execution-modes/implementation.md)), aprobaciones ([`approvals`](../approvals/implementation.md)), reglas ([`project-rules`](../project-rules/implementation.md)), git MCP in-process ([`git-workspace`](../git-workspace/implementation.md)) y Cursor ejecutable ([`cursor-provider`](../cursor-provider/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El agente extiende las 6 tools nativas con **MCP del workspace**, **skills en tres capas** (usuario / proyecto / local) y **subagentes visibles**. Las tools MCP usan el **mismo contrato de timeline** (nombre, input, output, status). Si un servidor MCP falla al arrancar, el turn **sigue** con nativas y un aviso del servidor que no cargó. Skills de cuenta aplican en todos los workspaces; proyecto/local anulan por nombre. Un subagente es un **grupo** `running → done` con las tools del hijo anidadas. Hay un **tope N** por turn: el exceso se rechaza visible. En modo `plan`, los hijos **tampoco** mutan el disco. Claude y Cursor exponen solo lo que el runner soporta; si Cursor no iguala un skill de Claude, se **degrada con mensaje** — no se finge paridad. Web, TUI y `chat watch` convergen.

**Architecture:** El filesystem, el spawn de servidores MCP stdio y el loop del agente viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** ejecuta MCP ni lee `SKILL.md` del cwd: persiste skills de **usuario** (tabla `user_skills`), reenvía RPCs `workspace.mcp.*` / `workspace.skills.*` al daemon bound y hace fan-out de `chat.tool.*` + `chat.mcp.status` + grupos de subagente. Chavez **carga él mismo** la config MCP y las skills (`settingSources: []` y `strictMcpConfig: true` se mantienen) para no duplicar `.mcp.json`, aislar fallos por servidor, aplicar el modo a tools MCP mutables, y mostrar qué se usó. Los subagentes corren **dentro del mismo** `query()` / `run.stream()` — no son un segundo turn ni un worktree.

```
PUT /skills  (capa usuario, vault de la cuenta)
        |
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API
        |  lee user_skills (enabled)
        |  dispatch { prompt, userSkills, executionMode }
        v
  daemon / TUI
        |  loadProjectMcp(cwd)     .mcp.json + .claude/settings.json + .cursor/mcp.json
        |  loadLocalMcp(cwd)       ~/.chavez/workspaces/<hash>/mcp.json
        |  connect each server     fail → chat.mcp.status failed; NO throw
        |  merge mcpServers        + chavez-git (plan 7) + chavez-skills (host)
        |  loadSkills 3 layers     local > project > user (mismo name anula)
        |  native tools siempre    Read/Write/Edit/Grep/Glob/Bash
        v
  query() / Agent.create
        |  mcpServers + skills host tool + Task/task
        |  canUseTool:
        |    nativas              → gate de modo (plan 3)
        |    MCP readOnly         → allow (como read)
        |    MCP mutable          → plan deny / ask waiter / auto allow
        |    Task/task spawn      → budget; hijos heredan el mismo gate
        |
        |  mcp fail al init       → aviso; nativas siguen
        |  Skill / skill tool     → chat.tool.* kind=skill
        |  Task start             → grupo running + children parentToolCallId
        |  Task end               → grupo done|error
        |  budget exceeded        → tool error visible, no spawn
        v
  API persist + broadcast  →  Web ToolCard/SubagentGroup | TUI | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y `settingSources: []`. Hoy `permissionMode` es `bypassPermissions`; planes 2–3 lo pasan a `default` + `canUseTool`. **No** volver a `bypassPermissions`. **No** pasa `mcpServers`, `skills`, ni `Task`.
- `cli/src/llm/publish-turn.ts` emite `chat.tool.start` / `result`. **No** estampa `kind: "mcp"|"skill"|"subagent"`, **no** emite `chat.mcp.status`, **no** agrupa hijos.
- Plan 7 (git) registra `createSdkMcpServer({ name: "chavez-git" })`. Esta fase **mergea**: `{ ...projectMcp, [GIT_MCP_SERVER]: gitServer, [SKILLS_MCP_SERVER]: skillsServer }`. No reescribe git.
- Plan 9 carga reglas en tres capas y **no** skills. Skills reutilizan la misma precedencia y el mismo parser de frontmatter (`cli/src/llm/rules-parse.ts` si existe; si no, un parser mínimo aquí).
- `api/src/db/schema.ts` `chat_messages.metadata` jsonb **ya existe**. No hay `user_skills`. Sin migración de timeline.
- `api/src/ws/handlers.ts` persiste `role=tool`. Plan 2 hace spread de `msg.metadata`. Esta fase exige que `kind`, `parentToolCallId`, `subagentId`, `mcpServer` sobrevivan un reload.
- Web `ChatDetailPanel.tsx` `ToolCard`: nombre + status + JSON. **No** hay grupo de subagente, **no** hay chip de skill, **no** hay banner MCP failed.
- TUI `App.tsx`: `Message = { id, role, content }` (el plan 2 añade metadata). Teclas `p` `[` `]` `{` `}` `m` (+ `o`/`r`/`g` si planes 3/9/7 aterrizaron). **No** hay `k`.
- CLI: `chavez headless chat watch` vuelca JSON o `formatWatchLine` (plan 2). **No** hay `chavez skills` ni `headless mcp`.
- Cursor `runnable: false` hasta el plan 4. Si `cli/src/llm/cursor-runner.ts` existe, esta fase le pasa `mcpServers` inline y skills host; si una feature no está en el SDK, `capability.degraded` — **nunca** inventar un `chat.tool.*` de MCP/skill/subagente que Cursor no emitió.
- Plan 36 (marketplace) **no** se implementa: no hay catálogo remoto ni “instalar”. El usuario crea skills de cuenta por HTTP/CLI/Web y pone MCP en archivos del repo.
- Plan 26 (red): un MCP HTTP/SSE declarado en el proyecto **sí** se intenta conectar (intención explícita del repo). Esta fase **no** implementa el deny de red de bash/`curl`.

**Tech Stack:** Bun, Hono + Drizzle (`user_skills` nueva; `chat_messages.metadata` jsonb **sin** tabla de timeline), WebSocket hub + `createPendingMap` (reusar `api/src/ws/pending.ts` de attach-files/git/rules; crearlo si falta), Claude Agent SDK `query` (`mcpServers`, `strictMcpConfig: true`, `createSdkMcpServer` + `tool`, `canUseTool`, `permissionMode: "default"`, mensajes `system` `init` / `task_started` / `task_updated` / `task_notification`, hooks `SubagentStart`/`SubagentStop` como fallback), Cursor SDK `Agent.create` `mcpServers` + `local.customTools` **solo** si el runner del plan 4 existe (`local: { cwd }`, **nunca** `cloud`), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar labels/clasificación (comentario keep-in-sync). Sin paquete MCP client extra: el Claude Agent SDK ya depende de `@modelcontextprotocol/sdk`. Sin octokit. Sin marketplace.

**Global Constraints:**

1. El filesystem, stdio MCP y el Skill body se leen **solo** en el daemon (cwd del workspace / `~/.chavez/workspaces/<hash>/`). API y browser no spawnean `npx`, no hablan con URLs MCP y no leen `SKILL.md` del servidor.
2. Sin daemon bound, `agent.turn.request` y `workspace.mcp.*` / `workspace.skills.snapshot` fallan con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. Las skills de **usuario** (HTTP `/skills`) **sí** funcionan sin daemon.
3. Tools nativas (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`) están **siempre** en `allowedTools` / `tools`. Un MCP en llamas no las apaga.
4. Fallo de MCP al arrancar **no** mata el turn. Se avisa el **nombre del servidor** + el error. El JSON malformado de un archivo se salta (los demás archivos cuentan).
5. Tools MCP usan el **mismo** contrato visual que nativas: `chat.tool.start` / `update` / `result` con nombre canónico, input (secretos redactados), output truncado (`TOOL_OUTPUT_MAX_CHARS`), status `running` | `awaiting_approval` | `done` | `error`.
6. Lecturas (nativas **y** MCP con `readOnlyHint`/`readOnly`/`readOnlyHint: true`) **nunca** piden confirmación. MCP sin anotación se trata como **write** (conservador). Write/edit/bash y MCP mutables siguen el modo (plan 3) y las aprobaciones una a una (plan 13). Sin lote ni “siempre permitir”.
7. Skills: tres capas. Precedencia de **mismo `name`**: **local > proyecto > usuario**. El texto de la skill ganadora se ofrece al modelo; las perdedoras no se listan. Faltar skills **no** falla el turn.
8. Skills de usuario viven en la API (cuenta). Siguen entre workspaces y máquinas. Un usuario = su vault (`eq(userId)`). Sin org ni roles.
9. Subagentes viven **dentro del turn** del daemon. No abren un segundo `agent.turn`. No crean worktree. No sobreviven a `agent.turn.ended`: se espera a que terminen (o se cancelan) antes del `finally`. Constraint 17: 1 turn por daemon.
10. Tope `SUBAGENT_MAX_PER_TURN`. El spawn N+1 se **deniega** con `SUBAGENT_BUDGET_EXCEEDED` (tool `error` visible). Profundidad máxima `SUBAGENT_MAX_DEPTH`.
11. Modo `plan`: el `canUseTool` del **host** aplica a padre **e hijos**. Write/edit/bash/MCP mutable → `PLAN_MUTATION_DENIED`. El disco no cambia. No usar `permissionMode: "plan"` del SDK (puede bloquear lecturas).
12. Claude vs Cursor: matriz `ProviderCaps`. Se expone MCP/skills/subagentes **solo** si el runner lo soporta. Si Cursor no carga un skill Chavez igual que Claude, mensaje `CURSOR_SKILL_DEGRADED` (nombra el skill) y el catálogo en prompt; **cero** `chat.tool.start` inventados. No se finge paridad.
13. `settingSources` permanece `[]`. `strictMcpConfig: true`. No se carga `~/.claude/mcp.json` ni `~/.cursor/mcp.json` (eso es Claude Code / Cursor IDE en esta máquina, no la cuenta Chavez).
14. Env de MCP (`env`, `headers`, tokens) **nunca** viaja en `chat.tool.start` input, stream, watch ni logs. Redact igual que plan 2/8 (`api_key`/`token`/`secret`/`password`/`authorization`/`credential`, `sk-ant-…`, `ghp_…`).
15. Merge con git MCP (plan 7): no pisar `chavez-git`. Un `.mcp.json` que declare el mismo nombre `chavez-git` se renombra visible a `chavez-git-project` y se avisa; el in-process gana.
16. Fuera de alcance: Cursor cloud, marketplace (plan 36), voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/mcp` `/skills`, cola, worktrees paralelos, sandbox de red, CI GitHub Action.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `SKILLS_MCP_SERVER` | `"chavez-skills"` |
| `SKILL_TOOL_ID` | `"skill"` |
| `GIT_MCP_SERVER` | `"chavez-git"` (reusar plan 7; no redefinir el string) |
| `SUBAGENT_MAX_PER_TURN` | `8` |
| `SUBAGENT_MAX_DEPTH` | `2` |
| `MCP_CONNECT_TIMEOUT_MS` | `5_000` |
| `MCP_TOOL_TIMEOUT_MS` | `30_000` |
| `MCP_SERVERS_MAX` | `20` |
| `MCP_CONFIG_FILES_MAX` | `8` |
| `USER_SKILLS_MAX` | `50` |
| `USER_SKILL_NAME_MAX` | `64` |
| `USER_SKILL_DESC_MAX` | `200` |
| `USER_SKILL_BODY_MAX` | `32_000` |
| `SKILL_BODY_MAX_CHARS` | `32_000` |
| `SKILL_PREVIEW_CHARS` | `2_000` |
| `SKILLS_PROMPT_MAX_CHARS` | `40_000` |
| `SKILL_PROJECT_MAX` | `40` |
| `MCP_RPC_TIMEOUT_MS` | `5_000` |
| `TOOL_OUTPUT_MAX_CHARS` | `8000` (reusar `cli/src/llm/tool-display.ts` si existe) |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `MCP_FAILED_PREFIX` | `"MCP server failed: "` |
| `MCP_CONFIG_PARSE_ERROR` | `` `MCP config parse failed (${path}): ${reason}` `` |
| `MCP_NATIVE_TOOLS_OK` | `"Native tools continue"` |
| `MCP_NAME_COLLISION` | `` `Project MCP server "${name}" collides with host server; loaded as "${alias}"` `` |
| `SUBAGENT_BUDGET_EXCEEDED` | `` `Subagent budget exceeded (max ${SUBAGENT_MAX_PER_TURN} per turn)` `` |
| `SUBAGENT_DEPTH_EXCEEDED` | `` `Subagent nesting exceeds max depth ${SUBAGENT_MAX_DEPTH}` `` |
| `PLAN_MUTATION_DENIED` | `"Plan mode: write/edit/bash are disabled. Switch to ask or auto to apply changes."` (bit-idéntico al plan 3) |
| `PLAN_MCP_MUTATION_DENIED` | `"Plan mode: mutating MCP tools are disabled. Switch to ask or auto to apply changes."` |
| `CURSOR_MCP_DEGRADED` | `"Cursor runner does not expose this MCP server the same way as Claude — not faking it"` |
| `CURSOR_SKILL_DEGRADED` | `` `Cursor does not load skill "${name}" the same way as Claude — offering description only` `` |
| `CURSOR_SUBAGENT_DEGRADED` | `"Cursor runner does not stream nested subagent tools — showing the group only"` |
| `USER_SKILLS_CAP_ERROR` | `"Maximum 50 user skills"` |
| `USER_SKILL_NAME_ERROR` | `"name must be 1–64 chars, kebab-case [a-z0-9-]+"` |
| `USER_SKILL_DESC_ERROR` | `"description must be 1–200 characters"` |
| `USER_SKILL_BODY_ERROR` | `"body must be 1–32000 characters"` |
| `SKILLS_PREAMBLE` | ver Task 2 |
| `MCP_PREAMBLE` | ver Task 1 |
| `SUBAGENT_PLAN_PREAMBLE` | `"You are in plan mode. Subagents inherit plan mode: they may read, grep, glob, and load skills. They must not write, edit, run mutating bash, or call mutating MCP tools."` |
| `NO_SKILLS_LABEL` | `"0 skills"` |
| `NO_MCP_LABEL` | `"0 MCP"` |
| `MCP_FAILED_LABEL` | `` `MCP failed: ${names}` `` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` / `ASK_APPROVAL_TIMEOUT_MS` / `PLAN_MUTATION_DENIED` / `TOOL_OUTPUT_MAX_CHARS` si ya existen; **no** cambiar esos strings.

Nombres canónicos (timeline; el PascalCase/MCP no es el único label):

| SDK `toolName` | Canónico | `metadata.kind` |
|---|---|---|
| `Read` / `read` | `read` | `read` |
| `Write` / `write` | `write` | `write` |
| `Edit`, `NotebookEdit` / `edit` | `edit` | `write` |
| `Grep` / `grep` | `grep` | `read` |
| `Glob`, `LS` / `glob` / `ls` | `glob` | `read` |
| `Bash` / `shell` | `bash` | `write` |
| `mcp__chavez-git__git_*` | `git_*` (plan 7) | `git` |
| `mcp__chavez-skills__skill`, `Skill` | `skill` | `skill` |
| `Task`, `Agent`, `task` | `subagent` | `subagent` |
| `mcp__<server>__<tool>` | `mcp:<server>/<tool>` | `mcp` |
| cualquier otra | `toolName.toLowerCase()` | `other` |

Clases para el gate (extiende plan 2/3; git plan 7 se consulta **antes**):

- **read:** nativas Read/Grep/Glob/LS + MCP con `readOnly === true` + `skill` + `git_status`/`git_diff`.
- **write:** nativas Write/Edit/NotebookEdit/Bash + MCP sin readOnly o con `destructive === true` + git mutables.
- **subagent:** `Task`/`Agent`/`task` → allow de spawn (budget aparte); los hijos se clasifican por su propia tool.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `chat.tool.start` / `update` / `result` | daemon → API → broadcast | Contrato único. `metadata.kind`, `mcpServer`, `skillName`, `subagentId`, `parentToolCallId`. |
| `chat.mcp.status` | daemon → API → broadcast | `{ chatId, streamId, servers: McpServerRuntimeStatus[] }` al init. Un failed **no** es `chat.stream.error`. |
| `chat.skill.activated` | daemon → API → broadcast | `{ chatId, name, layer, source }` cuando el host skill tool corre. También hay `chat.tool.*` kind=skill. |
| `chat.subagent.start` | daemon → API → broadcast | Grupo. `{ chatId, subagentId, toolCallId, agentType, description, status: "running" }`. |
| `chat.subagent.update` | daemon → API → broadcast | `{ subagentId, status, lastToolName? }`. |
| `chat.subagent.end` | daemon → API → broadcast | `{ subagentId, status: "done"\|"error", summary }`. |
| `chat.capability.degraded` | daemon → API → broadcast | `{ chatId, provider, feature: "mcp"\|"skill"\|"subagent", name?, message }`. |
| `workspace.mcp.snapshot` | cliente → API | Pedir servers del cwd. API espera al daemon. |
| `workspace.skills.snapshot` | cliente → API | Pedir titles por capa. |
| `workspace.mcp.dispatch` | API → daemon | `{ requestId, action: "snapshot", path }` |
| `workspace.skills.dispatch` | API → daemon | `{ requestId, action: "snapshot", path, userSkills }` |
| `workspace.mcp.result` / `workspace.skills.result` | daemon → API | Completa el pending. |
| `workspace.mcp.changed` / `workspace.skills.changed` | API → broadcast | Snapshot para que Web/TUI coincidan. |

HTTP:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/skills` | `{ skills: UserSkill[] }` de **este** `userId`. 401 sin sesión. |
| `POST` | `/skills` | `{ name, description, body, enabled? }`. 400 si cap/validación. |
| `PUT` | `/skills/:id` | Patch. 404 si no es del usuario. |
| `DELETE` | `/skills/:id` | 404 si no es del usuario. |

Sin tabla de MCP en la API. Sin migración de `chat_messages`.

Tipos (congelados):

```ts
export const SKILL_LAYERS = ["user", "project", "local"] as const;
export type SkillLayer = (typeof SKILL_LAYERS)[number];

export const MCP_STATUSES = [
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
] as const;
export type McpRuntimeStatus = (typeof MCP_STATUSES)[number];

export const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const SUBAGENT_STATUSES = [
  "running",
  "done",
  "error",
  "cancelled",
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export const PROVIDER_FEATURES = ["mcp", "skill", "subagent"] as const;
export type ProviderFeature = (typeof PROVIDER_FEATURES)[number];

export type ProviderCaps = {
  provider: "claude" | "cursor";
  mcp: boolean;
  skills: boolean;
  subagents: boolean;
  nestedSubagentTools: boolean;
};

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

export type McpServerConfigJson = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type McpServerSource = {
  name: string;
  config: McpServerConfigJson;
  layer: "project" | "local";
  path: string; // relative cwd or ~/.chavez/...
};

export type McpServerRuntimeStatus = {
  name: string;
  status: McpRuntimeStatus;
  transport: McpTransport;
  error?: string;
  tools?: { name: string; readOnly: boolean; destructive: boolean }[];
  layer: "project" | "local" | "host";
};

export type McpToolAnnotations = {
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
};

export type SkillSource = {
  layer: SkillLayer;
  name: string;
  description: string;
  body: string;
  path?: string;
  enabled: boolean;
  chars: number;
  truncated: boolean;
};

export type SkillRef = Omit<SkillSource, "body">;

export type SkillsBundle = {
  user: SkillSource[];
  project: SkillSource[];
  local: SkillSource[];
  /** After same-name merge: local > project > user. */
  applied: SkillSource[];
};

export type SkillsMetadata = {
  counts: { user: number; project: number; local: number; total: number };
  applied: SkillRef[];
  activated: string[];
};

export type UserSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubagentGroup = {
  subagentId: string;
  toolCallId: string;
  agentType: string;
  description: string;
  status: SubagentStatus;
  depth: number;
  parentSubagentId?: string;
  childToolCallIds: string[];
  summary?: string;
};

export type McpSnapshot = {
  servers: McpServerRuntimeStatus[];
  failed: string[];
  nativeToolsContinue: true;
};

export type SkillsSnapshot = {
  counts: SkillsMetadata["counts"];
  applied: SkillRef[];
};
```

---

## Task 1: Módulos puros — MCP nombres, anotaciones, parse de config, aislamiento

**Files:**

- Create: `cli/src/llm/mcp-constants.ts`
- Create: `cli/src/llm/mcp-names.ts`
- Create: `cli/src/llm/mcp-classify.ts`
- Create: `cli/src/llm/mcp-parse.ts`
- Test: `cli/src/llm/mcp-names.test.ts`
- Test: `cli/src/llm/mcp-classify.test.ts`
- Test: `cli/src/llm/mcp-parse.test.ts`
- Modify: `cli/package.json`

Sin I/O de disco ni red. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Tasks 4 y 10 duplican labels (comentario keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/mcp-constants.ts`:

```ts
export const SKILLS_MCP_SERVER = "chavez-skills";
export const SKILL_TOOL_ID = "skill";
export const GIT_MCP_SERVER = "chavez-git";

export const MCP_CONNECT_TIMEOUT_MS = 5_000;
export const MCP_TOOL_TIMEOUT_MS = 30_000;
export const MCP_SERVERS_MAX = 20;
export const MCP_CONFIG_FILES_MAX = 8;
export const MCP_RPC_TIMEOUT_MS = 5_000;

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const MCP_FAILED_PREFIX = "MCP server failed: ";
export const MCP_NATIVE_TOOLS_OK = "Native tools continue";
export const NO_MCP_LABEL = "0 MCP";

export const HOST_MCP_NAMES = [GIT_MCP_SERVER, SKILLS_MCP_SERVER] as const;

export const PROJECT_MCP_FILES = [
  ".mcp.json",
  ".claude/settings.json",
  ".cursor/mcp.json",
] as const;

export const MCP_PREAMBLE =
  "Project MCP servers are loaded by Chavez. Native filesystem tools always remain available. If an MCP server failed, you still have read/write/edit/grep/glob/bash. Do not pretend a failed server's tools exist.";

export function mcpConfigParseError(path: string, reason: string): string {
  return `MCP config parse failed (${path}): ${reason}`;
}

export function mcpFailedMessage(name: string, error: string): string {
  return `${MCP_FAILED_PREFIX}${name} — ${error}`;
}

export function mcpNameCollision(name: string, alias: string): string {
  return `Project MCP server "${name}" collides with host server; loaded as "${alias}"`;
}

export function mcpFailedLabel(names: string[]): string {
  return `MCP failed: ${names.join(", ")}`;
}
```

Si `NO_DAEMON_ERROR` ya vive en `cli/src/llm/tool-names.ts`, reexportar el mismo literal.

- [ ] Crear `cli/src/llm/mcp-names.ts`:

```ts
import { GIT_MCP_SERVER, SKILLS_MCP_SERVER, SKILL_TOOL_ID } from "./mcp-constants";

const MCP_RE = /^mcp__([^_]+)__(.+)$/;

export function parseMcpSdkName(
  toolName: string,
): { server: string; tool: string } | null {
  const m = String(toolName || "").match(MCP_RE);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
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
```

Si `cli/src/llm/tool-names.ts` ya exporta `canonicalToolName`, **extenderlo**:

```ts
// after existing Read/Write/… map, before toLowerCase fallback:
if (toolName === "Skill") return "skill";
if (toolName === "Task" || toolName === "Agent" || toolName === "task") {
  return "subagent";
}
const mcp = canonicalMcpName(toolName);
if (mcp.startsWith("mcp:") || mcp === "skill" || mcp.startsWith("git_")) {
  return mcp;
}
```

No borrar el map de las 6 nativas ni los alias Cursor (`shell` → `bash`).

- [ ] Crear `cli/src/llm/mcp-classify.ts`:

```ts
import { parseMcpSdkName } from "./mcp-names";
import type { McpToolAnnotations } from "./mcp-constants";

export type McpGateClass = "read" | "write";

export function annotationsFromUnknown(v: unknown): McpToolAnnotations {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const readOnly = o.readOnly === true || o.readOnlyHint === true;
  const destructive = o.destructive === true || o.destructiveHint === true;
  const openWorld = o.openWorld === true || o.openWorldHint === true;
  return { readOnly, destructive, openWorld };
}

/** Conservative: missing annotations ⇒ write (ask/plan). */
export function mcpGateClass(ann: McpToolAnnotations): McpGateClass {
  if (ann.readOnly && !ann.destructive) return "read";
  return "write";
}

export function isMcpToolName(toolName: string): boolean {
  return parseMcpSdkName(toolName) != null;
}
```

- [ ] Crear `cli/src/llm/mcp-parse.ts`. Acepta el JSON crudo de `.mcp.json` / `.cursor/mcp.json` / `.claude/settings.json` (`mcpServers` top-level). **No** lee disco.

```ts
import type { McpServerConfigJson, McpServerSource } from "./mcp-constants";
import {
  MCP_SERVERS_MAX,
  MCP_CONFIG_PARSE_ERROR,
  HOST_MCP_NAMES,
  mcpConfigParseError,
  mcpNameCollision,
} from "./mcp-constants";

export type McpParseResult = {
  servers: McpServerSource[];
  errors: { path: string; reason: string }[];
  collisions: { name: string; alias: string }[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseMcpServersObject(
  raw: unknown,
  path: string,
  layer: "project" | "local",
): McpParseResult {
  const errors: McpParseResult["errors"] = [];
  const collisions: McpParseResult["collisions"] = [];
  const servers: McpServerSource[] = [];

  const root = asRecord(raw);
  if (!root) {
    errors.push({ path, reason: "root must be an object" });
    return { servers, errors, collisions };
  }
  const block = asRecord(root.mcpServers) ?? (path.endsWith("settings.json")
    ? asRecord(root.mcpServers)
    : asRecord(root.mcpServers));
  const mcpServers = asRecord(root.mcpServers);
  if (!mcpServers) {
    return { servers, errors, collisions }; // archivo sin mcpServers = vacío, no error
  }

  const names = Object.keys(mcpServers).slice(0, MCP_SERVERS_MAX);
  for (const name of names) {
    const entry = asRecord(mcpServers[name]);
    if (!entry) {
      errors.push({ path, reason: `server "${name}" must be an object` });
      continue;
    }
    const parsed = parseOneServer(name, entry);
    if ("reason" in parsed) {
      errors.push({ path, reason: parsed.reason });
      continue;
    }
    let finalName = parsed.name;
    if ((HOST_MCP_NAMES as readonly string[]).includes(finalName)) {
      const alias = `${finalName}-project`;
      collisions.push({ name: finalName, alias });
      finalName = alias;
    }
    servers.push({
      name: finalName,
      config: { ...parsed, name: finalName },
      layer,
      path,
    });
  }
  return { servers, errors, collisions };
}

function parseOneServer(
  name: string,
  entry: Record<string, unknown>,
): McpServerConfigJson | { reason: string } {
  const type = String(entry.type || (entry.command ? "stdio" : entry.url ? "http" : ""));
  if (type === "sse" || (type === "http" && typeof entry.url === "string")) {
    if (typeof entry.url !== "string" || !entry.url) {
      return { reason: `server "${name}" missing url` };
    }
    return {
      name,
      transport: type === "sse" ? "sse" : "http",
      url: entry.url,
      headers: sanitizeStringMap(entry.headers),
      timeoutMs: num(entry.timeout),
    };
  }
  if (typeof entry.command !== "string" || !entry.command) {
    return { reason: `server "${name}" missing command` };
  }
  return {
    name,
    transport: "stdio",
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : [],
    env: sanitizeStringMap(entry.env),
    timeoutMs: num(entry.timeout),
  };
}

function sanitizeStringMap(v: unknown): Record<string, string> | undefined {
  const o = asRecord(v);
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) out[k] = String(val);
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function mergeMcpParseResults(results: McpParseResult[]): McpParseResult {
  const servers: McpServerSource[] = [];
  const errors: McpParseResult["errors"] = [];
  const collisions: McpParseResult["collisions"] = [];
  const seen = new Set<string>();
  for (const r of results) {
    errors.push(...r.errors);
    collisions.push(...r.collisions);
    for (const s of r.servers) {
      if (seen.has(s.name)) continue; // first file wins; local se parsea después y pisa si llamas reversed
      seen.add(s.name);
      servers.push(s);
    }
  }
  return { servers, errors, collisions };
}

/** Local layer last so it overrides project on the same name. */
export function mergeMcpLayers(project: McpParseResult, local: McpParseResult): McpParseResult {
  const byName = new Map<string, McpServerSource>();
  for (const s of project.servers) byName.set(s.name, s);
  for (const s of local.servers) byName.set(s.name, s);
  return {
    servers: [...byName.values()],
    errors: [...project.errors, ...local.errors],
    collisions: [...project.collisions, ...local.collisions],
  };
}

void MCP_CONFIG_PARSE_ERROR;
void mcpConfigParseError;
void mcpNameCollision;
```

Corrige el bloque muerto `const block = …` al implementar: solo `asRecord(root.mcpServers)`. El snippet de arriba deja claro el shape; el archivo real **no** debe tener la variable `block`.

- [ ] Tests `mcp-names.test.ts`:

  - `mcp__linear__create_issue` → `mcp:linear/create_issue`.
  - `mcp__chavez-skills__skill` → `skill`.
  - `mcp__chavez-git__git_commit` → `git_commit`.
  - `Read` no parsea como MCP.

- [ ] Tests `mcp-classify.test.ts`:

  - `{ readOnly: true }` → read.
  - `{ readOnlyHint: true, destructiveHint: false }` → read.
  - `{}` → write.
  - `{ destructive: true }` → write.

- [ ] Tests `mcp-parse.test.ts`:

  - `.mcp.json` `{ mcpServers: { docs: { command: "npx", args: ["-y", "foo"] } } }` → stdio `docs`.
  - HTTP `{ type: "http", url: "https://example.com/mcp" }` → http.
  - `mcpServers` ausente → 0 servers, 0 errors.
  - `mcpServers: { x: 1 }` → error, 0 servers, **no throw**.
  - Nombre `chavez-git` → collision alias `chavez-git-project`.
  - `mergeMcpLayers`: local pisa el mismo name.

- [ ] Correr:

```bash
cd cli && bun test src/llm/mcp-names.test.ts src/llm/mcp-classify.test.ts src/llm/mcp-parse.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/package.json cli/src/llm/mcp-constants.ts cli/src/llm/mcp-names.ts \
  cli/src/llm/mcp-classify.ts cli/src/llm/mcp-parse.ts \
  cli/src/llm/mcp-names.test.ts cli/src/llm/mcp-classify.test.ts \
  cli/src/llm/mcp-parse.test.ts cli/src/llm/tool-names.ts
git commit -m "feat(mcp): parse project MCP config and classify tools"
```

---

## Task 2: Módulos puros — skills parse, merge de capas, preamble

**Files:**

- Create: `cli/src/llm/skills-constants.ts`
- Create: `cli/src/llm/skills-parse.ts`
- Create: `cli/src/llm/skills-merge.ts`
- Test: `cli/src/llm/skills-parse.test.ts`
- Test: `cli/src/llm/skills-merge.test.ts`

Sin I/O de disco. Reusar el parser de frontmatter de `cli/src/llm/rules-parse.ts` si el plan 9 lo creó (`parseFrontmatter(raw)` → `{ attrs, body }`); si no, copiar un parser mínimo **en** `skills-parse.ts` (bloque `---` inicial, `key: value`). No añadir paquete yaml.

- [ ] Crear `cli/src/llm/skills-constants.ts`:

```ts
export const SKILL_LAYERS = ["user", "project", "local"] as const;
export type SkillLayer = (typeof SKILL_LAYERS)[number];

export const USER_SKILLS_MAX = 50;
export const USER_SKILL_NAME_MAX = 64;
export const USER_SKILL_DESC_MAX = 200;
export const USER_SKILL_BODY_MAX = 32_000;
export const SKILL_BODY_MAX_CHARS = 32_000;
export const SKILL_PREVIEW_CHARS = 2_000;
export const SKILLS_PROMPT_MAX_CHARS = 40_000;
export const SKILL_PROJECT_MAX = 40;

export const USER_SKILLS_CAP_ERROR = "Maximum 50 user skills";
export const USER_SKILL_NAME_ERROR =
  "name must be 1–64 chars, kebab-case [a-z0-9-]+";
export const USER_SKILL_DESC_ERROR = "description must be 1–200 characters";
export const USER_SKILL_BODY_ERROR = "body must be 1–32000 characters";
export const NO_SKILLS_LABEL = "0 skills";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PROJECT_SKILL_GLOBS = [
  ".claude/skills/*/SKILL.md",
  ".cursor/skills/*/SKILL.md",
  ".chavez/skills/*/SKILL.md",
] as const;

export const LOCAL_SKILL_GLOBS = [
  ".chavez/skills.local/*/SKILL.md",
] as const;

export const LOCAL_MACHINE_SKILLS_DIR = "skills"; // under ~/.chavez/workspaces/<hash>/

export const SKILLS_PREAMBLE =
  "Chavez skills are in effect. Three layers apply: user, project, local. If the same skill name exists in more than one layer, local overrides project, and project overrides user. Load a skill with the skill tool before following its instructions. Do not invent a skill that is not listed.";

export function isSkillName(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= USER_SKILL_NAME_MAX && SKILL_NAME_RE.test(v);
}
```

- [ ] Crear `cli/src/llm/skills-parse.ts`:

```ts
import {
  SKILL_BODY_MAX_CHARS,
  USER_SKILL_DESC_MAX,
  isSkillName,
  type SkillLayer,
} from "./skills-constants";
import type { SkillSource } from "./mcp-constants";

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  truncated: boolean;
};

function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
  // If cli/src/llm/rules-parse.ts exports parseFrontmatter, import and use that instead.
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { attrs: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { attrs: {}, body: text };
  const fm = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, "");
  const attrs: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    attrs[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { attrs, body };
}

export function parseSkillMd(
  raw: string,
  fallbackName: string,
  layer: SkillLayer,
  path?: string,
): SkillSource | null {
  const { attrs, body: rest } = parseFrontmatter(raw);
  const name = isSkillName(attrs.name) ? attrs.name : isSkillName(fallbackName) ? fallbackName : null;
  if (!name) return null;
  const description = (attrs.description || name).slice(0, USER_SKILL_DESC_MAX);
  const truncated = rest.length > SKILL_BODY_MAX_CHARS;
  const body = rest.slice(0, SKILL_BODY_MAX_CHARS);
  return {
    layer,
    name,
    description,
    body,
    path,
    enabled: attrs.enabled === "false" ? false : true,
    chars: body.length,
    truncated,
  };
}

export function userSkillToSource(row: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}): SkillSource {
  const truncated = row.body.length > SKILL_BODY_MAX_CHARS;
  return {
    layer: "user",
    name: row.name,
    description: row.description,
    body: row.body.slice(0, SKILL_BODY_MAX_CHARS),
    enabled: row.enabled,
    chars: Math.min(row.body.length, SKILL_BODY_MAX_CHARS),
    truncated,
  };
}
```

Mueve `SkillSource` a `cli/src/llm/skills-constants.ts` (junto a los otros types de skills) en lugar de importarlo de `mcp-constants`. `mcp-constants.ts` **no** exporta `SkillSource`.

- [ ] Crear `cli/src/llm/skills-merge.ts`:

```ts
import { SKILLS_PREAMBLE, SKILLS_PROMPT_MAX_CHARS } from "./skills-constants";
import type { SkillRef, SkillSource, SkillsBundle, SkillsMetadata } from "./skills-constants";

export function mergeSkillLayers(input: {
  user: SkillSource[];
  project: SkillSource[];
  local: SkillSource[];
}): SkillsBundle {
  const enabled = (xs: SkillSource[]) => xs.filter((s) => s.enabled);
  const user = enabled(input.user);
  const project = enabled(input.project);
  const local = enabled(input.local);
  const byName = new Map<string, SkillSource>();
  for (const s of user) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);
  return { user, project, local, applied: [...byName.values()] };
}

export function skillsMetadata(bundle: SkillsBundle, activated: string[] = []): SkillsMetadata {
  const ref = (s: SkillSource): SkillRef => {
    const { body: _b, ...rest } = s;
    return rest;
  };
  return {
    counts: {
      user: bundle.user.length,
      project: bundle.project.length,
      local: bundle.local.length,
      total: bundle.applied.length,
    },
    applied: bundle.applied.map(ref),
    activated,
  };
}

export function formatSkillsPrompt(bundle: SkillsBundle): string {
  if (bundle.applied.length === 0) return "";
  const lines = [SKILLS_PREAMBLE, "", "Available skills:"];
  for (const s of bundle.applied) {
    lines.push(`- ${s.name} (${s.layer}): ${s.description}`);
  }
  lines.push("", "Call tool skill with { name } to load the full instructions.");
  let out = lines.join("\n");
  if (out.length > SKILLS_PROMPT_MAX_CHARS) {
    out = out.slice(0, SKILLS_PROMPT_MAX_CHARS) + "\n…[truncated]";
  }
  return out;
}
```

Exporta `SkillSource`, `SkillRef`, `SkillsBundle`, `SkillsMetadata` desde `skills-constants.ts`.

- [ ] Tests `skills-parse.test.ts`:

  - Frontmatter `name: pdf` + body → name `pdf`.
  - Nombre inválido `PDF Tool` + fallback `pdf` → `pdf`.
  - Body > 32000 → `truncated: true`.
  - `enabled: false` → enabled false.

- [ ] Tests `skills-merge.test.ts`:

  - Mismo name en user y project → applied es project.
  - Mismo name en las tres → applied es local.
  - `enabled: false` en user no aparece si project no lo tiene.
  - `formatSkillsPrompt` incluye preamble y los names; vacío → `""`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/skills-parse.test.ts src/llm/skills-merge.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/skills-constants.ts cli/src/llm/skills-parse.ts \
  cli/src/llm/skills-merge.ts cli/src/llm/skills-parse.test.ts \
  cli/src/llm/skills-merge.test.ts
git commit -m "feat(skills): parse SKILL.md and merge user/project/local layers"
```

---

## Task 3: Módulos puros — presupuesto de subagentes, codec de eventos, caps de provider

**Files:**

- Create: `cli/src/llm/subagent-constants.ts`
- Create: `cli/src/llm/subagent-budget.ts`
- Create: `cli/src/llm/subagent-events.ts`
- Create: `cli/src/llm/provider-caps.ts`
- Test: `cli/src/llm/subagent-budget.test.ts`
- Test: `cli/src/llm/subagent-events.test.ts`
- Test: `cli/src/llm/provider-caps.test.ts`

- [ ] Crear `cli/src/llm/subagent-constants.ts`:

```ts
export const SUBAGENT_MAX_PER_TURN = 8;
export const SUBAGENT_MAX_DEPTH = 2;

export const SUBAGENT_SPAWN_TOOLS = ["Task", "Agent", "task"] as const;

export function subagentBudgetExceeded(max = SUBAGENT_MAX_PER_TURN): string {
  return `Subagent budget exceeded (max ${max} per turn)`;
}

export function subagentDepthExceeded(max = SUBAGENT_MAX_DEPTH): string {
  return `Subagent nesting exceeds max depth ${max}`;
}

export const SUBAGENT_PLAN_PREAMBLE =
  "You are in plan mode. Subagents inherit plan mode: they may read, grep, glob, and load skills. They must not write, edit, run mutating bash, or call mutating MCP tools.";

export const CURSOR_MCP_DEGRADED =
  "Cursor runner does not expose this MCP server the same way as Claude — not faking it";
export const CURSOR_SUBAGENT_DEGRADED =
  "Cursor runner does not stream nested subagent tools — showing the group only";

export function cursorSkillDegraded(name: string): string {
  return `Cursor does not load skill "${name}" the same way as Claude — offering description only`;
}

export function isSubagentSpawnTool(toolName: string): boolean {
  const n = String(toolName || "");
  return n === "Task" || n === "Agent" || n === "task" || n.toLowerCase() === "subagent";
}
```

- [ ] Crear `cli/src/llm/subagent-budget.ts`:

```ts
import {
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_MAX_PER_TURN,
  subagentBudgetExceeded,
  subagentDepthExceeded,
} from "./subagent-constants";

export type SubagentBudget = {
  spawned: number;
  max: number;
  maxDepth: number;
};

export function createSubagentBudget(): SubagentBudget {
  return { spawned: 0, max: SUBAGENT_MAX_PER_TURN, maxDepth: SUBAGENT_MAX_DEPTH };
}

export type BudgetDecision =
  | { ok: true; next: SubagentBudget }
  | { ok: false; message: string };

export function trySpawnSubagent(
  budget: SubagentBudget,
  depth: number,
): BudgetDecision {
  if (depth > budget.maxDepth) {
    return { ok: false, message: subagentDepthExceeded(budget.maxDepth) };
  }
  if (budget.spawned >= budget.max) {
    return { ok: false, message: subagentBudgetExceeded(budget.max) };
  }
  return { ok: true, next: { ...budget, spawned: budget.spawned + 1 } };
}
```

`depth` del padre = 0; primer hijo = 1; nieto = 2. Un bisnieto (`depth === 3`) se deniega.

- [ ] Crear `cli/src/llm/subagent-events.ts`. Codec puro de mensajes SDK → eventos de harness. **No** llama a `query()`.

```ts
export type HarnessSubagentEvent =
  | {
      kind: "subagent_start";
      subagentId: string;
      toolCallId: string;
      agentType: string;
      description: string;
      depth: number;
    }
  | {
      kind: "subagent_update";
      subagentId: string;
      status: "running" | "done" | "error" | "cancelled";
      lastToolName?: string;
    }
  | {
      kind: "subagent_end";
      subagentId: string;
      status: "done" | "error" | "cancelled";
      summary: string;
    }
  | {
      kind: "child_tool";
      subagentId: string;
      parentToolCallId: string;
      toolCallId: string;
      toolName: string;
      input?: unknown;
    };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function eventsFromSdkTaskMessage(
  msg: Record<string, unknown>,
): HarnessSubagentEvent[] {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  if (type !== "system") return [];

  if (subtype === "task_started") {
    const id = String(msg.task_id || "");
    if (!id) return [];
    return [
      {
        kind: "subagent_start",
        subagentId: id,
        toolCallId: String(msg.tool_use_id || id),
        agentType: String(msg.subagent_type || msg.task_type || "general"),
        description: String(msg.description || ""),
        depth: typeof msg.spawn_depth === "number" ? msg.spawn_depth : 1,
      },
    ];
  }

  if (subtype === "task_updated") {
    const id = String(msg.task_id || "");
    const patch = asRecord(msg.patch) || {};
    const raw = String(patch.status || "running");
    const status =
      raw === "completed" || raw === "done"
        ? "done"
        : raw === "failed" || raw === "killed"
          ? "error"
          : raw === "paused"
            ? "running"
            : "running";
    if (status === "done" || status === "error") {
      return [
        {
          kind: "subagent_end",
          subagentId: id,
          status,
          summary: String(patch.error || patch.description || ""),
        },
      ];
    }
    return [{ kind: "subagent_update", subagentId: id, status: "running" }];
  }

  if (subtype === "task_notification") {
    const id = String(msg.task_id || "");
    const raw = String(msg.status || "completed");
    const status = raw === "failed" || raw === "stopped" ? "error" : "done";
    return [
      {
        kind: "subagent_end",
        subagentId: id,
        status: status === "error" ? "error" : "done",
        summary: String(msg.summary || ""),
      },
    ];
  }

  if (subtype === "task_progress") {
    const id = String(msg.task_id || "");
    const last = typeof msg.last_tool_name === "string" ? msg.last_tool_name : undefined;
    return [{ kind: "subagent_update", subagentId: id, status: "running", lastToolName: last }];
  }

  return [];
}

/** Claude tool_use of Task/Agent: group start before task_started arrives. */
export function subagentStartFromToolUse(block: {
  id?: string;
  name?: string;
  input?: unknown;
}): HarnessSubagentEvent | null {
  const name = String(block.name || "");
  if (name !== "Task" && name !== "Agent" && name !== "task") return null;
  const input = asRecord(block.input) || {};
  const id = String(block.id || crypto.randomUUID());
  return {
    kind: "subagent_start",
    subagentId: id,
    toolCallId: id,
    agentType: String(input.subagent_type || input.subagentType || "general"),
    description: String(input.description || input.prompt || ""),
    depth: 1,
  };
}
```

- [ ] Crear `cli/src/llm/provider-caps.ts`:

```ts
export type ProviderCaps = {
  provider: "claude" | "cursor";
  mcp: boolean;
  skills: boolean;
  subagents: boolean;
  nestedSubagentTools: boolean;
};

export const CLAUDE_CAPS: ProviderCaps = {
  provider: "claude",
  mcp: true,
  skills: true,
  subagents: true,
  nestedSubagentTools: true,
};

/** Probe at runtime from Cursor SDK option keys; default conservative. */
export function cursorCapsFromAgentCreate(createOptsKeys: string[]): ProviderCaps {
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
```

`nestedSubagentTools` arranca `false` para Cursor. Si durante el stream llega un tool_call anidado real, el runner lo pinta; **no** se sintetiza. Si no llega ninguno y sí hubo spawn, se emite `CURSOR_SUBAGENT_DEGRADED` una vez.

- [ ] Tests `subagent-budget.test.ts`:

  - 8 spawns depth 1 → ok; el 9º → `SUBAGENT_BUDGET_EXCEEDED` (exact string).
  - depth 3 → `SUBAGENT_DEPTH_EXCEEDED`.
  - depth 2 con spawned 0 → ok.

- [ ] Tests `subagent-events.test.ts`:

  - Fixture `task_started` → `subagent_start` con `agentType`.
  - `task_notification` status completed → `subagent_end` done.
  - `task_notification` failed → error.
  - `tool_use` name `Task` → start.
  - `tool_use` name `Read` → null.
  - Mensaje desconocido → `[]`.

- [ ] Tests `provider-caps.test.ts`:

  - `CLAUDE_CAPS.mcp === true`.
  - `cursorCapsFromAgentCreate([])` → todo false.
  - `cursorCapsFromAgentCreate(["mcpServers","agents"])` → mcp+subagents true, nested false.
  - `cursorCapsStatic().nestedSubagentTools === false`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/subagent-budget.test.ts src/llm/subagent-events.test.ts src/llm/provider-caps.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/subagent-constants.ts cli/src/llm/subagent-budget.ts \
  cli/src/llm/subagent-events.ts cli/src/llm/provider-caps.ts \
  cli/src/llm/subagent-budget.test.ts cli/src/llm/subagent-events.test.ts \
  cli/src/llm/provider-caps.test.ts
git commit -m "feat(subagents): budget, event codec, provider capability matrix"
```

---

## Task 4: API — `user_skills`, HTTP, OpenAPI

**Files:**

- Create: `api/src/llm/skills-constants.ts`
- Test: `api/src/llm/skills-constants.test.ts`
- Create: `api/src/routes/skills.ts`
- Test: `api/src/routes/skills.test.ts`
- Create: `api/drizzle/0019_user_skills.sql`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/index.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API es la fuente de verdad de la capa **usuario**. Proyecto/local no se guardan aquí. MCP de proyecto **no** tiene tabla.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta.

- [ ] Crear `api/src/llm/skills-constants.ts` copiando `USER_SKILLS_MAX`, `USER_SKILL_NAME_MAX`, `USER_SKILL_DESC_MAX`, `USER_SKILL_BODY_MAX`, los cuatro `*_ERROR`, `SKILL_NAME_RE` e `isSkillName` (no importar `cli/`).

- [ ] Test: reject `PDF Tool`, accept `pdf-extract`, cap 50, description vacía → error, body vacío → error.

- [ ] En `api/src/db/schema.ts` añadir:

```ts
export const userSkills = pgTable(
  "user_skills",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_skills_user_id_name_uidx").on(table.userId, table.name),
  ],
);
```

No tocar `workspaces`. No añadir `userSkillsEnabled` (las skills de usuario aplican en todos los workspaces; anular es por name en proyecto/local).

- [ ] Crear `api/drizzle/0019_user_skills.sql`. Si `0019_` ya existe por otro plan, usar el siguiente entero libre; el SQL es idempotente:

```sql
CREATE TABLE IF NOT EXISTS "user_skills" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_skills_user_id_name_uidx"
  ON "user_skills" ("user_id", "name");
```

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

Si `db:push` no está disponible en CI, el SQL arriba es la fuente; `schema.ts` debe coincidir.

- [ ] Crear `api/src/routes/skills.ts` (mismo patrón que `api/src/routes/rules.ts` del plan 9; si `rules.ts` no existe, copiar el esqueleto de `createProviderRoutes` + `requireSession`):

```ts
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userSkills } from "../db/schema";
import type { Session } from "../auth";
import {
  USER_SKILLS_MAX,
  USER_SKILL_BODY_ERROR,
  USER_SKILL_DESC_ERROR,
  USER_SKILL_NAME_ERROR,
  USER_SKILLS_CAP_ERROR,
  USER_SKILL_BODY_MAX,
  USER_SKILL_DESC_MAX,
  isSkillName,
} from "../llm/skills-constants";

function publicSkill(row: typeof userSkills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createSkillRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rows = await db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    return c.json({ skills: rows.map(publicSkill) });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const name = String((body as { name?: string }).name || "").trim();
    const description = String((body as { description?: string }).description || "").trim();
    const skillBody = String((body as { body?: string }).body || "");
    const enabled = (body as { enabled?: boolean }).enabled !== false;
    if (!isSkillName(name)) return c.json({ error: USER_SKILL_NAME_ERROR }, 400);
    if (!description || description.length > USER_SKILL_DESC_MAX) {
      return c.json({ error: USER_SKILL_DESC_ERROR }, 400);
    }
    if (!skillBody || skillBody.length > USER_SKILL_BODY_MAX) {
      return c.json({ error: USER_SKILL_BODY_ERROR }, 400);
    }
    const existing = await db
      .select({ id: userSkills.id })
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    if (existing.length >= USER_SKILLS_MAX) {
      return c.json({ error: USER_SKILLS_CAP_ERROR }, 400);
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      name,
      description,
      body: skillBody,
      enabled,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.insert(userSkills).values(row);
    } catch {
      return c.json({ error: `skill name "${name}" already exists` }, 400);
    }
    return c.json({ skill: publicSkill(row as typeof userSkills.$inferSelect) }, 201);
  });

  app.put("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const found = await db
      .select()
      .from(userSkills)
      .where(and(eq(userSkills.id, id), eq(userSkills.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Not found" }, 404);
    const patch = await c.req.json().catch(() => ({}));
    const next: Partial<typeof found[0]> = { updatedAt: new Date() };
    if ((patch as { name?: string }).name != null) {
      const name = String((patch as { name: string }).name).trim();
      if (!isSkillName(name)) return c.json({ error: USER_SKILL_NAME_ERROR }, 400);
      next.name = name;
    }
    if ((patch as { description?: string }).description != null) {
      const description = String((patch as { description: string }).description).trim();
      if (!description || description.length > USER_SKILL_DESC_MAX) {
        return c.json({ error: USER_SKILL_DESC_ERROR }, 400);
      }
      next.description = description;
    }
    if ((patch as { body?: string }).body != null) {
      const skillBody = String((patch as { body: string }).body);
      if (!skillBody || skillBody.length > USER_SKILL_BODY_MAX) {
        return c.json({ error: USER_SKILL_BODY_ERROR }, 400);
      }
      next.body = skillBody;
    }
    if ((patch as { enabled?: boolean }).enabled != null) {
      next.enabled = Boolean((patch as { enabled: boolean }).enabled);
    }
    const updated = { ...found[0], ...next };
    await db.update(userSkills).set(next).where(eq(userSkills.id, id));
    return c.json({ skill: publicSkill(updated) });
  });

  app.delete("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const found = await db
      .select({ id: userSkills.id })
      .from(userSkills)
      .where(and(eq(userSkills.id, id), eq(userSkills.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Not found" }, 404);
    await db.delete(userSkills).where(eq(userSkills.id, id));
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] En `api/src/index.ts`:

  - `app.use("/skills/*", corsMiddleware)` y `app.use("/skills", corsMiddleware)`.
  - `app.route("/skills", createSkillRoutes(requireSession))`.

- [ ] Tras POST/PUT/DELETE exitoso, si hay `hub` importable, `hub.broadcastToUser(userId, hub.pushEvent("skills.updated", { skills }))`. Si el insert no tiene el listado fresco, emitir `{ skillId, op }` y que el cliente re-GET. No bloquear el HTTP si el broadcast falla.

- [ ] Tests `api/src/routes/skills.test.ts`: extraer `validateUserSkill(input)` a `api/src/llm/skills-constants.ts` (name/desc/body/cap) y testear **sin** Postgres:

  - name `ok-skill` + desc + body → ok.
  - name `Bad Name` → `USER_SKILL_NAME_ERROR`.
  - 51º → `USER_SKILLS_CAP_ERROR`.
  - GET sin sesión no se testea aquí (e2e); el handler retorna 401.

- [ ] En `api/openapi/openapi.yaml` añadir paths `/skills`, `/skills/{id}` (GET/POST/PUT/DELETE), schema `UserSkill`, 401/400/404. Descripción de `/ws`: añadir `chat.mcp.status`, `chat.skill.activated`, `chat.subagent.start|update|end`, `chat.capability.degraded`, `workspace.mcp.snapshot`, `workspace.skills.snapshot`.

- [ ] Correr:

```bash
cd api && bun test src/llm/skills-constants.test.ts src/routes/skills.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/llm/skills-constants.ts api/src/llm/skills-constants.test.ts \
  api/src/routes/skills.ts api/src/routes/skills.test.ts \
  api/src/db/schema.ts api/drizzle/0019_user_skills.sql \
  api/src/index.ts api/openapi/openapi.yaml api/package.json
git commit -m "feat(skills): persist user skills per account"
```

---

## Task 5: Daemon — cargar MCP y skills del cwd, fallos aislados

**Files:**

- Create: `cli/src/llm/mcp-load.ts`
- Test: `cli/src/llm/mcp-load.test.ts`
- Create: `cli/src/llm/skills-load.ts`
- Test: `cli/src/llm/skills-load.test.ts`
- Create: `cli/src/llm/skills-mcp.ts`
- Test: `cli/src/llm/skills-mcp.test.ts`

Esta task lee disco **en tmp de test**, no llama al LLM.

- [ ] Crear `cli/src/llm/mcp-load.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { workspaceHash } from "../workspace";
import {
  PROJECT_MCP_FILES,
  MCP_CONFIG_FILES_MAX,
  MCP_CONNECT_TIMEOUT_MS,
  mcpConfigParseError,
} from "./mcp-constants";
import { mergeMcpLayers, parseMcpServersObject, type McpParseResult } from "./mcp-parse";
import type { McpServerConfigJson, McpServerSource } from "./mcp-constants";

function readJsonFile(abs: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!existsSync(abs)) return { ok: true, value: null };
  try {
    const raw = readFileSync(abs, "utf8");
    if (!raw.trim()) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function loadMcpFromDisk(cwd: string): McpParseResult {
  const projectParts: McpParseResult[] = [];
  let files = 0;
  for (const rel of PROJECT_MCP_FILES) {
    if (files >= MCP_CONFIG_FILES_MAX) break;
    const abs = join(cwd, rel);
    const got = readJsonFile(abs);
    files += 1;
    if (!got.ok) {
      projectParts.push({
        servers: [],
        errors: [{ path: rel, reason: got.reason }],
        collisions: [],
      });
      continue;
    }
    if (got.value == null) continue;
    projectParts.push(parseMcpServersObject(got.value, rel, "project"));
  }
  const project = projectParts.reduce<McpParseResult>(
    (acc, p) => ({
      servers: [...acc.servers, ...p.servers],
      errors: [...acc.errors, ...p.errors],
      collisions: [...acc.collisions, ...p.collisions],
    }),
    { servers: [], errors: [], collisions: [] },
  );

  const localRel = `~/.chavez/workspaces/${workspaceHash(cwd)}/mcp.json`;
  const localAbs = join(homedir(), ".chavez", "workspaces", workspaceHash(cwd), "mcp.json");
  const localGot = readJsonFile(localAbs);
  const local: McpParseResult = !localGot.ok
    ? { servers: [], errors: [{ path: localRel, reason: localGot.reason }], collisions: [] }
    : localGot.value == null
      ? { servers: [], errors: [], collisions: [] }
      : parseMcpServersObject(localGot.value, localRel, "local");

  return mergeMcpLayers(project, local);
}

export function toClaudeMcpServers(
  sources: McpServerSource[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of sources) {
    out[s.name] = claudeSdkConfig(s.config);
  }
  return out;
}

function claudeSdkConfig(c: McpServerConfigJson): Record<string, unknown> {
  const timeout = c.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  if (c.transport === "stdio") {
    return { type: "stdio", command: c.command, args: c.args ?? [], env: c.env, timeout };
  }
  if (c.transport === "sse") {
    return { type: "sse", url: c.url, headers: c.headers, timeout };
  }
  return { type: "http", url: c.url, headers: c.headers, timeout };
}

void mcpConfigParseError;
```

`loadMcpFromDisk` **nunca throw**. JSON roto → `errors[]`. Archivo ausente → skip.

El SDK conecta al pasar `mcpServers` a `query()`. Esta función **no** spawnea. El aislamiento de connect-fail se hace en Task 6 leyendo `system`/`init` `mcp_servers[].status`.

- [ ] Tests `mcp-load.test.ts` con `mkdtempSync`:

  - cwd con `.mcp.json` válido → 1 server.
  - `.mcp.json` texto `NOT_JSON` → errors length 1, servers 0, no throw.
  - `.mcp.json` bueno + `.cursor/mcp.json` bueno → merge (nombres distintos).
  - mismo name en project y local file (escribir localAbs mockeando `workspaceHash` vía cwd conocido) → local gana. Para no tocar `$HOME`, exportar `loadMcpFromDisk(cwd, { localFile?: string })` con default al path real. En test pasa `join(tmp, "local-mcp.json")`.

Firma final:

```ts
export function loadMcpFromDisk(
  cwd: string,
  opts?: { localFile?: string },
): McpParseResult;
```

- [ ] Crear `cli/src/llm/skills-load.ts`:

```ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { workspaceHash } from "../workspace";
import {
  PROJECT_SKILL_GLOBS,
  LOCAL_SKILL_GLOBS,
  LOCAL_MACHINE_SKILLS_DIR,
  SKILL_PROJECT_MAX,
} from "./skills-constants";
import { parseSkillMd } from "./skills-parse";
import { mergeSkillLayers } from "./skills-merge";
import type { SkillSource, SkillsBundle } from "./skills-constants";
import { userSkillToSource } from "./skills-parse";

function expandSkillGlob(cwd: string, glob: string): string[] {
  // Only the three patterns in PROJECT_SKILL_GLOBS / LOCAL_SKILL_GLOBS:
  // "<dir>/*/SKILL.md"
  const parts = glob.split("/");
  const root = join(cwd, ...parts.slice(0, -2)); // drop */SKILL.md
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: string[] = [];
  for (const ent of readdirSync(root)) {
    const skillMd = join(root, ent, "SKILL.md");
    if (existsSync(skillMd) && statSync(skillMd).isFile()) out.push(skillMd);
  }
  return out;
}

function loadFromGlobs(
  cwd: string,
  globs: readonly string[],
  layer: "project" | "local",
  cap: number,
): SkillSource[] {
  const files: string[] = [];
  for (const g of globs) files.push(...expandSkillGlob(cwd, g));
  const out: SkillSource[] = [];
  for (const abs of files.slice(0, cap)) {
    let raw = "";
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const fallback = basename(dirname(abs));
    const rel = abs.startsWith(cwd) ? abs.slice(cwd.length).replace(/^\//, "") : abs;
    const parsed = parseSkillMd(raw, fallback, layer, rel);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function loadSkillsFromDisk(
  cwd: string,
  userRows: Array<{ name: string; description: string; body: string; enabled: boolean }>,
  opts?: { localDir?: string },
): SkillsBundle {
  const project = loadFromGlobs(cwd, PROJECT_SKILL_GLOBS, "project", SKILL_PROJECT_MAX);
  const localCwd = loadFromGlobs(cwd, LOCAL_SKILL_GLOBS, "local", SKILL_PROJECT_MAX);
  const machineDir =
    opts?.localDir ??
    join(homedir(), ".chavez", "workspaces", workspaceHash(cwd), LOCAL_MACHINE_SKILLS_DIR);
  const localMachine = existsSync(machineDir)
    ? loadFromGlobs(machineDir, ["*/SKILL.md"], "local", SKILL_PROJECT_MAX)
    : [];
  // loadFromGlobs with cwd=machineDir and glob "*/SKILL.md":
  const localFromMachine: SkillSource[] = [];
  if (existsSync(machineDir) && statSync(machineDir).isDirectory()) {
    for (const ent of readdirSync(machineDir).slice(0, SKILL_PROJECT_MAX)) {
      const skillMd = join(machineDir, ent, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      try {
        const parsed = parseSkillMd(
          readFileSync(skillMd, "utf8"),
          ent,
          "local",
          `~/.chavez/workspaces/${workspaceHash(cwd)}/skills/${ent}/SKILL.md`,
        );
        if (parsed) localFromMachine.push(parsed);
      } catch {
        // skip unreadable skill; do not fail the turn
      }
    }
  }
  const user = userRows.map(userSkillToSource);
  return mergeSkillLayers({
    user,
    project,
    local: [...localCwd, ...localFromMachine],
  });
}
```

Simplifica `localCwd` + `localFromMachine` en el archivo real; el test cubre ambos. **Nunca throw** por archivo faltante.

El glob `"*/SKILL.md"` no está en `PROJECT_SKILL_GLOBS`. Para machine dir, usa el loop `readdir` (ya escrito); borra la llamada `loadFromGlobs(machineDir, ["*/SKILL.md"], …)` muerta.

- [ ] Tests `skills-load.test.ts` en tmp:

  - `.claude/skills/pdf/SKILL.md` → project `pdf`.
  - user row `pdf` + project `pdf` → applied layer project.
  - user `pdf` + local machine dir `pdf` → applied local.
  - sin archivos + user `[]` → applied `[]`, no throw.
  - `SKILL.md` ilegible se salta.

- [ ] Crear `cli/src/llm/skills-mcp.ts` — MCP in-process host (igual que git plan 7):

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SKILLS_MCP_SERVER, SKILL_TOOL_ID } from "./mcp-constants";
import type { SkillsBundle } from "./skills-constants";

export function createSkillsMcpServer(bundle: SkillsBundle) {
  const byName = new Map(bundle.applied.map((s) => [s.name, s]));
  return createSdkMcpServer({
    name: SKILLS_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Load a listed skill by name before following it. Skills not listed do not exist.",
    tools: [
      tool(
        SKILL_TOOL_ID,
        "Load a Chavez skill's full instructions by name.",
        { name: z.string() },
        async (args) => {
          const s = byName.get(String(args.name || ""));
          if (!s) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown skill "${args.name}". Available: ${[...byName.keys()].join(", ") || "(none)"}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `# ${s.name}\nlayer: ${s.layer}\n${s.description}\n\n${s.body}`,
              },
            ],
            isError: false,
          };
        },
      ),
    ],
  });
}

export function allowedSkillsMcpTools(): string[] {
  return [`mcp__${SKILLS_MCP_SERVER}__${SKILL_TOOL_ID}`];
}
```

- [ ] Test `skills-mcp.test.ts`: `createSkillsMcpServer` no lanza con bundle vacío ni con un skill. Si el objeto no expone handlers, skip de invocación (cubierto en Task 6 con `canUseTool` + codec).

- [ ] Correr:

```bash
cd cli && bun test src/llm/mcp-load.test.ts src/llm/skills-load.test.ts src/llm/skills-mcp.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/mcp-load.ts cli/src/llm/mcp-load.test.ts \
  cli/src/llm/skills-load.ts cli/src/llm/skills-load.test.ts \
  cli/src/llm/skills-mcp.ts cli/src/llm/skills-mcp.test.ts
git commit -m "feat(mcp): load workspace MCP and layered skills on the daemon"
```

---

## Task 6: Gate de modo + runners Claude/Cursor + publish-turn

**Files:**

- Create: `cli/src/llm/mcp-gate.ts`
- Test: `cli/src/llm/mcp-gate.test.ts`
- Modify: `cli/src/llm/execution-gate.ts` (si existe; si no, el `canUseTool` de `claude-runner.ts`)
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/cursor-runner.ts` (solo si el plan 4 lo creó)
- Test: `cli/src/llm/mcp-gate.test.ts`
- Test: `cli/src/llm/claude-runner-mcp.test.ts`
- Test: `cli/src/llm/sdk-task-events.test.ts`

`permissionMode` permanece `"default"`. **No** `bypassPermissions`. **No** `permissionMode: "plan"` del SDK.

- [ ] Crear `cli/src/llm/mcp-gate.ts`:

```ts
import { isMcpToolName, mcpGateClass, annotationsFromUnknown } from "./mcp-classify";
import { parseMcpSdkName } from "./mcp-names";
import { GIT_MCP_SERVER, SKILLS_MCP_SERVER } from "./mcp-constants";
import { isSubagentSpawnTool, subagentBudgetExceeded } from "./subagent-constants";
import { trySpawnSubagent, type SubagentBudget } from "./subagent-budget";
import type { McpToolAnnotations } from "./mcp-constants";

export type ExecutionMode = "plan" | "auto" | "ask";

export type McpGateDecision =
  | { decision: "passthrough" }
  | { decision: "allow" }
  | { decision: "deny"; message: string }
  | { decision: "ask" };

const PLAN_MCP_MUTATION_DENIED =
  "Plan mode: mutating MCP tools are disabled. Switch to ask or auto to apply changes.";

export function gateMcpTool(
  mode: ExecutionMode,
  toolName: string,
  annotations: McpToolAnnotations,
): McpGateDecision {
  if (!isMcpToolName(toolName) && !isSubagentSpawnTool(toolName) && toolName !== "Skill") {
    return { decision: "passthrough" };
  }
  const parsed = parseMcpSdkName(toolName);
  if (parsed?.server === GIT_MCP_SERVER) return { decision: "passthrough" }; // plan 7
  if (parsed?.server === SKILLS_MCP_SERVER || toolName === "Skill") {
    return { decision: "allow" }; // skill load is read
  }
  if (isSubagentSpawnTool(toolName)) {
    return { decision: "passthrough" }; // budget runs separately
  }
  const cls = mcpGateClass(annotations);
  if (cls === "read") return { decision: "allow" };
  if (mode === "plan") return { decision: "deny", message: PLAN_MCP_MUTATION_DENIED };
  if (mode === "ask") return { decision: "ask" };
  return { decision: "allow" };
}

export function gateSubagentSpawn(
  budget: SubagentBudget,
  depth: number,
): McpGateDecision {
  const r = trySpawnSubagent(budget, depth);
  if (!r.ok) return { decision: "deny", message: r.message };
  return { decision: "allow" };
}

void subagentBudgetExceeded;
void annotationsFromUnknown;
```

Exporta `PLAN_MCP_MUTATION_DENIED` desde `mcp-constants.ts` (ya listado en la tabla) e impórtalo; no dupliques el string.

- [ ] Tests `mcp-gate.test.ts`:

  - `mcp__docs__search` + readOnly auto/plan/ask → allow.
  - `mcp__docs__write` sin ann + plan → deny `PLAN_MCP_MUTATION_DENIED`.
  - mismo + ask → ask.
  - mismo + auto → allow.
  - `mcp__chavez-skills__skill` plan → allow.
  - `mcp__chavez-git__git_commit` → passthrough.
  - `Read` → passthrough.
  - spawn con budget lleno → deny exact `SUBAGENT_BUDGET_EXCEEDED`.

- [ ] En `cli/src/llm/execution-gate.ts` (o `can-use-tool.ts` / inline): **después** de git (`gateGitTool`) y **antes** del gate genérico write/read:

```ts
if (isSubagentSpawnTool(toolName)) {
  const depth = Number(ctx.subagentDepth ?? 1);
  const spawn = gateSubagentSpawn(ctx.budget, depth);
  if (spawn.decision === "deny") {
    return { behavior: "deny", message: spawn.message };
  }
  ctx.budget = trySpawnSubagent(ctx.budget, depth).ok
    ? (trySpawnSubagent(ctx.budget, depth) as { ok: true; next: SubagentBudget }).next
    : ctx.budget;
  return { behavior: "allow" };
}
const mcp = gateMcpTool(mode, toolName, annotationsFromUnknown(ctx.annotations));
if (mcp.decision === "deny") return { behavior: "deny", message: mcp.message };
if (mcp.decision === "allow") return { behavior: "allow" };
if (mcp.decision === "ask") {
  // mismo waiter que Write (plan 3/13)
}
```

Corrige el doble `trySpawnSubagent`: el gate debe mutar el budget **una vez**:

```ts
const r = trySpawnSubagent(ctx.budget, depth);
if (!r.ok) return { behavior: "deny", message: r.message };
ctx.budget = r.next;
return { behavior: "allow" };
```

Anota `PreToolUse` hook si el SDK pasa `agent_id` para `subagentDepth`: depth = 1 en el padre, `input.agent_id` presente → depth 2. Si no hay hook, usa `ctx.liveGroups.size + 1` acotado por `SUBAGENT_MAX_DEPTH`.

Hijos write en plan: caen al gate genérico (`PLAN_MUTATION_DENIED`) o MCP (`PLAN_MCP_MUTATION_DENIED`). Disco intacto.

- [ ] Extender `AgentTurnEvent` en `cli/src/llm/claude-runner.ts` (o el type extraído):

```ts
export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | {
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      output: string;
      status?: string;
      metadata?: Record<string, unknown>;
    }
  | { kind: "mcp_status"; servers: McpServerRuntimeStatus[] }
  | {
      kind: "skill_activated";
      name: string;
      layer: string;
      source?: string;
    }
  | HarnessSubagentEvent
  | {
      kind: "capability_degraded";
      provider: "claude" | "cursor";
      feature: "mcp" | "skill" | "subagent";
      name?: string;
      message: string;
    }
  | { kind: "result"; text: string };
```

Importa `HarnessSubagentEvent` desde `subagent-events.ts`.

- [ ] En `cli/src/llm/sdk-tool-events.ts` (plan 2; créalo si falta) añadir branches:

  - `type === "system" && subtype === "init"`: mapear `msg.mcp_servers` → `{ kind: "mcp_status", servers }`. Status `failed` **no** produce `result` error.
  - `eventsFromSdkTaskMessage(msg)`.
  - `tool_use` Task/Agent → `subagentStartFromToolUse` **y** `tool_start` canónico `subagent`.
  - `tool_use` `mcp__chavez-skills__skill` / `Skill` → `tool_start` kind skill + `skill_activated`.
  - `tool_use` `mcp__*` → `tool_start` con `metadata.kind = "mcp"`, `mcpServer`, `mcpTool`.
  - Si el bloque trae `parent_tool_use_id` / el hook trae `agent_id`, copiar a `metadata.parentToolCallId` / `subagentId`.

- [ ] En `runClaudeTurn` / `RunClaudeTurnInput` añadir:

```ts
export type RunClaudeTurnInput = {
  // existing fields …
  executionMode?: "plan" | "auto" | "ask";
  userSkills?: Array<{ name: string; description: string; body: string; enabled: boolean }>;
  mcpServersExtra?: Record<string, unknown>; // git MCP instance, already built
};
```

Dentro de `runClaudeTurn`:

1. `const parsed = loadMcpFromDisk(input.cwd);`
2. `const bundle = loadSkillsFromDisk(input.cwd, input.userSkills ?? []);`
3. `const skillsServer = createSkillsMcpServer(bundle);`
4. `const projectServers = toClaudeMcpServers(parsed.servers);`
5. `options.mcpServers = { ...projectServers, ...input.mcpServersExtra, [SKILLS_MCP_SERVER]: skillsServer };`
6. `options.strictMcpConfig = true;`
7. `options.settingSources = [];`
8. `allowedTools = [...DEFAULT_CLAUDE_TOOLS, ...allowedSkillsMcpTools(), "Task", ...(allowedGitMcpTools?.() ?? [])]` — concatenar, no quitar nativas. Si el plan 7 ya añadió git, no duplicar.
9. `appendSystemPrompt` (o prepend al prompt): `MCP_PREAMBLE` + lista de servers (nombre + status pending) + `formatSkillsPrompt(bundle)` + si mode==plan `SUBAGENT_PLAN_PREAMBLE`. Si plan 3/9 ya prependen, **añadir debajo**, no sustituir.
10. `permissionMode: "default"`.
11. `canUseTool` usa el gate de esta task. Budget: `createSubagentBudget()` por turn.
12. En el `for await` de `query()`: `eventsFromSdkMessage` + task codec. `init.mcp_servers` con `status: "failed"` → evento `mcp_status` (el turn sigue). **No** throw.
13. Si `query()` lanza **antes** de init por un MCP: catch, emitir `mcp_status` failed `unknown` con el message, **reintentar una vez** con `mcpServers` solo host (`chavez-git` + `chavez-skills`). Si el retry funciona, nativas + host siguen. Si el retry falla, entonces sí throw (fallo no-MCP). Documentar que el retry es solo cuando el error menciona `MCP` / `mcp`.

- [ ] Tests `claude-runner-mcp.test.ts` **sin** SDK vivo: extrae `buildClaudeMcpOptions(input)` (servers dict, allowedTools, preambles, strictMcpConfig) y `shouldRetryWithoutProjectMcp(err)`:

  - options incluyen `strictMcpConfig: true`, `settingSources: []`.
  - `allowedTools` contiene `Read` y `mcp__chavez-skills__skill`.
  - error `MCP server foo failed to connect` → retry true.
  - error `Claude no devolvió un resultado de éxito` → retry false.

- [ ] Si existe `cli/src/llm/cursor-runner.ts`:

  1. `const caps = cursorCapsStatic();`
  2. Si `caps.mcp`: pasar `mcpServers: toCursorMcpServers(parsed.servers)` en `Agent.create` (shape `{ command, args, env }` / `{ url }` según `docs/ts-sdk.md`). **Nunca** `cloud`.
  3. Skills: registrar `customTools.skill` que lee `bundle.applied`. Si `customTools` no está en el type del paquete instalado, **no** castear a `any` para fingir: emitir `capability_degraded` feature `skill` con `CURSOR_SKILL_DEGRADED` por cada skill applied (máx. 5 mensajes; el resto se resume `"N more skills degraded"`) y meter `formatSkillsPrompt(bundle)` en el prompt (descripciones, no fakes de tool_start).
  4. Subagentes: si `agents` existe en create, no hace falta definir custom agents; el Task nativo de Cursor basta. Mapear eventos `task` / `taskUpdate` / `NestedTaskUpdate` con el mismo codec. Si no hay nested tool events, un `capability_degraded` `CURSOR_SUBAGENT_DEGRADED` y el grupo padre igual se pinta.
  5. `canUseTool` equivalente: Cursor `local.autoReview` **no** sustituye el modo Chavez. Si el SDK no tiene canUseTool, documentar que el gate corre en el mapper de tool_call **antes** de pintar approve — y para auto/plan se pasa `tools.disabled` mutables en plan (`disallowed: ["edit","write","shell"]` más MCP write). En plan, hijos tampoco mutan.

- [ ] Si `cursor-runner.ts` **no** existe: crear `cli/src/llm/cursor-mcp-bridge.ts` con `toCursorMcpServers` + `cursorDegradeEvents(caps, bundle)` testeable, y un comentario `// wired from publish-turn when runCursorTurn exists`. No simular un turn Cursor.

- [ ] En `publish-turn.ts`:

  1. GET `/skills` (token del daemon). 401/red → `userSkills = []` (el turn sigue; no es fatal). Filtrar `enabled`.
  2. Pasar `userSkills` y `executionMode` (de GET `/providers` si plan 3; default `ask`) a `runClaudeTurn` / `runCursorTurn`.
  3. Mapear eventos nuevos a WS:

```ts
if (ev.kind === "mcp_status") {
  await client.request({
    type: "chat.mcp.status",
    chatId,
    streamId,
    metadata: { servers: ev.servers },
  });
}
if (ev.kind === "skill_activated") {
  await client.request({
    type: "chat.skill.activated",
    chatId,
    metadata: { name: ev.name, layer: ev.layer, source: ev.source },
  });
}
if (ev.kind === "subagent_start") {
  await client.request({
    type: "chat.subagent.start",
    chatId,
    toolCallId: ev.toolCallId,
    metadata: { ...ev, status: "running", kind: "subagent" },
  });
  await client.request({
    type: "chat.tool.start",
    chatId,
    toolCallId: ev.toolCallId,
    toolName: "subagent",
    content: ev.agentType,
    metadata: {
      kind: "subagent",
      subagentId: ev.subagentId,
      agentType: ev.agentType,
      description: ev.description,
      status: "running",
      input: { description: ev.description, agentType: ev.agentType },
    },
  });
}
if (ev.kind === "subagent_end") {
  await client.request({
    type: "chat.subagent.end",
    chatId,
    metadata: { ...ev },
  });
  await client.request({
    type: "chat.tool.result",
    chatId,
    toolCallId: ev.subagentId,
    toolName: "subagent",
    content: ev.summary,
    status: ev.status === "done" ? "done" : "error",
    metadata: { kind: "subagent", subagentId: ev.subagentId, status: ev.status },
  });
}
if (ev.kind === "capability_degraded") {
  await client.request({
    type: "chat.capability.degraded",
    chatId,
    content: ev.message,
    metadata: { provider: ev.provider, feature: ev.feature, name: ev.name },
  });
}
if (ev.kind === "tool_start") {
  await client.request({
    type: "chat.tool.start",
    chatId,
    toolCallId: ev.toolCallId,
    toolName: canonicalToolName(ev.toolName),
    content: canonicalToolName(ev.toolName),
    metadata: {
      input: redactSecrets(ev.input),
      ...ev.metadata,
      kind: ev.metadata?.kind ?? kindFromName(ev.toolName),
    },
  });
}
```

`redactSecrets`: reusar plan 2 (`cli/src/llm/tool-display.ts`). Si no existe, redact keys `api_key|token|secret|password|authorization|credential` y strings `sk-ant-` / `ghp_`. **Env de MCP no se copia al input.**

4. `chat.stream.end` metadata: `{ mcp: { failed: string[], connected: string[] }, skills: skillsMetadata(bundle, activated), subagents: { spawned, max: 8 } }`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/mcp-gate.test.ts src/llm/claude-runner-mcp.test.ts src/llm/subagent-events.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/mcp-gate.ts cli/src/llm/mcp-gate.test.ts \
  cli/src/llm/execution-gate.ts cli/src/llm/can-use-tool.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/sdk-tool-events.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/claude-runner-mcp.test.ts \
  cli/src/llm/cursor-runner.ts cli/src/llm/cursor-mcp-bridge.ts \
  cli/src/llm/tool-names.ts
git commit -m "feat(mcp): wire MCP, skills and subagents into the agent turn"
```

Solo añade a `git add` los archivos que existan / hayas creado.

---

## Task 7: API WS — persistir kind/parent/subagent, fan-out, RPC snapshot

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Create: `api/src/ws/pending.ts` (solo si attach-files/git/rules **no** lo crearon)
- Test: `api/src/ws/mcp-protocol.test.ts`
- Modify: `api/openapi/openapi.yaml`

- [ ] En `api/src/ws/protocol.ts` añadir campos opcionales si no están:

```ts
export type ClientMessage = {
  // existing …
  requestId?: string;
  action?: string;
  parentToolCallId?: string;
  subagentId?: string;
};
```

- [ ] `chat.tool.start` / `update` / `result`: **spread** `msg.metadata` al persistir (plan 2). Exigir que queden `kind`, `mcpServer`, `mcpTool`, `skillName`, `skillLayer`, `subagentId`, `parentToolCallId`, `agentType`. Truncar `content` con la misma constante de tools si el helper existe.

- [ ] Cases nuevos:

```ts
case "chat.mcp.status": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await loadChatForUser(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const payload = {
    chatId: msg.chatId,
    streamId: msg.streamId,
    servers: (msg.metadata as { servers?: unknown })?.servers ?? [],
  };
  broadcast(userId, "chat.mcp.status", payload);
  return ok(type, id, payload);
}
case "chat.skill.activated": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  broadcast(userId, "chat.skill.activated", {
    chatId: msg.chatId,
    name: (msg.metadata as { name?: string })?.name,
    layer: (msg.metadata as { layer?: string })?.layer,
    source: (msg.metadata as { source?: string })?.source,
  });
  return ok(type, id, { ok: true });
}
case "chat.subagent.start":
case "chat.subagent.update":
case "chat.subagent.end": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  broadcast(userId, type, {
    chatId: msg.chatId,
    ...(msg.metadata || {}),
    toolCallId: msg.toolCallId,
  });
  return ok(type, id, { ok: true });
}
case "chat.capability.degraded": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const row = {
    id: crypto.randomUUID(),
    chatId: msg.chatId,
    role: "system",
    content: msg.content || "Provider capability degraded",
    metadata: { kind: "capability_degraded", ...(msg.metadata || {}) },
    createdAt: new Date(),
  };
  await db.insert(chatMessages).values(row);
  broadcast(userId, "chat.capability.degraded", { chatId: msg.chatId, message: row });
  broadcast(userId, "message.appended", { chatId: msg.chatId, message: row });
  return ok(type, id, { message: row });
}
```

`chat.mcp.status` **no** inserta un mensaje por cada server connected (ruido). Failed servers: si `servers.some(s => s.status==="failed")`, insertar **un** `role=system` content `MCP server failed: a, b — Native tools continue` metadata `{ kind: "mcp_status", servers }`. Reload reconstruye el aviso.

- [ ] `agent.turn.request`: además de `executionMode` (plan 3) y `userRules` (plan 9), cargar skills del usuario:

```ts
const skillRows = await db
  .select()
  .from(userSkills)
  .where(eq(userSkills.userId, userId));
const userSkillsPayload = skillRows
  .filter((s) => s.enabled)
  .map((s) => ({
    name: s.name,
    description: s.description,
    body: s.body,
    enabled: s.enabled,
  }));
```

Pasarlas en `agent.turn.dispatch` data: `{ chatId, prompt, path, executionMode, userSkills: userSkillsPayload }`. El daemon **no** llama GET `/skills` si el dispatch ya las trae; `publish-turn` usa `input.userSkills ?? fetch`.

- [ ] RPC snapshot. Reusar `createPendingMap` de `api/src/ws/pending.ts`. Si el archivo no existe:

```ts
export function createPendingMap(timeoutMs: number) {
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  return {
    wait(requestId: string) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("timeout"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
      });
    },
    settle(requestId: string, value: unknown, error?: string) {
      const p = pending.get(requestId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(requestId);
      if (error) p.reject(new Error(error));
      else p.resolve(value);
    },
  };
}
```

Timeout `MCP_RPC_TIMEOUT_MS` (5000). Cases:

```ts
case "workspace.mcp.snapshot":
case "workspace.skills.snapshot": {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const requestId = crypto.randomUUID();
  const action = type === "workspace.mcp.snapshot" ? "mcp.snapshot" : "skills.snapshot";
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.ext.dispatch", {
      requestId,
      action,
      path: daemon.path,
      userSkills: action === "skills.snapshot" ? userSkillsPayload : undefined,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  try {
    const data = await pending.wait(requestId);
    broadcast(userId, action === "mcp.snapshot" ? "workspace.mcp.changed" : "workspace.skills.changed", {
      workspaceId,
      snapshot: data,
    });
    return ok(type, id, data);
  } catch (e) {
    return fail(type, id, e instanceof Error ? e.message : "timeout");
  }
}
case "workspace.ext.result": {
  if (!msg.requestId) return fail(type, id, "requestId is required");
  pending.settle(msg.requestId, msg.metadata ?? msg, (msg as { error?: string }).error);
  return ok(type, id, { ok: true });
}
```

Si git/rules ya tienen `workspace.git.dispatch` / `workspace.rules.dispatch`, **no** inventes un bus genérico que los rompa: añade `workspace.mcp.dispatch` y `workspace.skills.dispatch` **paralelos**, mismo pending map.

`NO_DAEMON_ERROR` reusado. Un cliente no-daemon no lee el cwd.

- [ ] Tests `api/src/ws/mcp-protocol.test.ts` puros (helpers extraídos):

  - `formatMcpFailedSystem(servers)` con 2 failed → string contiene ambos names y `Native tools continue`.
  - 0 failed → `null` (no insertar system).
  - metadata spread conserva `parentToolCallId`.

- [ ] Correr:

```bash
cd api && bun test src/ws/mcp-protocol.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/handlers.ts api/src/ws/pending.ts \
  api/src/ws/mcp-protocol.test.ts api/openapi/openapi.yaml
git commit -m "feat(ws): fan-out MCP status, skills and nested subagent tools"
```

---

## Task 8: Daemon handler + CLI `skills` + `headless mcp` + watch

**Files:**

- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/commands/headless.ts`
- Create: `cli/src/commands/skills.ts`
- Modify: `cli/src/index.ts`
- Create: `cli/src/llm/watch-format-mcp.ts` **o** Modify: `cli/src/llm/watch-format.ts`
- Test: `cli/src/llm/watch-format-mcp.test.ts`
- Test: `cli/src/commands/skills-format.test.ts`

- [ ] En `cli/src/ws/daemon.ts` `onPush`:

  1. `agent.turn.dispatch`: leer `userSkills` y `executionMode` del payload y pasarlos a `publishAgentTurn`.
  2. Nuevo: `workspace.mcp.dispatch` / `workspace.skills.dispatch` / `workspace.ext.dispatch`:

```ts
if (
  msg.type === "workspace.mcp.dispatch" ||
  msg.type === "workspace.skills.dispatch" ||
  msg.type === "workspace.ext.dispatch"
) {
  const data = (msg.data || {}) as {
    requestId?: string;
    action?: string;
    path?: string;
    userSkills?: Array<{ name: string; description: string; body: string; enabled: boolean }>;
  };
  const cwd = data.path || path;
  let snapshot: unknown = {};
  try {
    if (data.action === "mcp.snapshot" || data.action === "snapshot" && msg.type.includes("mcp")) {
      const parsed = loadMcpFromDisk(cwd);
      snapshot = {
        servers: parsed.servers.map((s) => ({
          name: s.name,
          status: "pending",
          transport: s.config.transport,
          layer: s.layer,
        })),
        errors: parsed.errors,
        collisions: parsed.collisions,
        failed: parsed.errors.map((e) => e.path),
        nativeToolsContinue: true,
      };
    } else {
      const bundle = loadSkillsFromDisk(cwd, data.userSkills ?? []);
      snapshot = skillsMetadata(bundle);
    }
    await client.request({
      type: "workspace.ext.result",
      requestId: data.requestId,
      metadata: snapshot as Record<string, unknown>,
    });
  } catch (err) {
    await client.request({
      type: "workspace.ext.result",
      requestId: data.requestId,
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
```

Ajusta `type` al que Task 7 haya congelado (`workspace.mcp.result` vs `workspace.ext.result`). Daemon y API deben usar **el mismo** string.

El snapshot MCP es de **config** (pending). El status connected/failed real llega en `chat.mcp.status` al turn. Eso basta para la UI “qué hay en el repo”.

- [ ] Crear `cli/src/commands/skills.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

export async function skillsCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "list" || !action) {
    const data = await apiFetch<{ skills: Array<{ name: string; enabled: boolean; description: string }> }>(
      "/skills",
      {},
      token(),
    );
    for (const s of data.skills) {
      console.log(`${s.enabled ? "on " : "off"} ${s.name}  ${s.description}`);
    }
    if (!data.skills.length) console.log("0 skills");
    return;
  }
  if (action === "add") {
    const name = rest[0];
    const description = rest[1];
    const body = rest.slice(2).join(" ");
    if (!name || !description || !body) {
      throw new Error("Uso: chavez skills add <name> <description> <body…>");
    }
    const res = await apiFetch("/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body }),
    }, token());
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (action === "rm") {
    const id = rest[0];
    if (!id) throw new Error("Uso: chavez skills rm <id>");
    await apiFetch(`/skills/${id}`, { method: "DELETE" }, token());
    console.log("deleted");
    return;
  }
  throw new Error("Uso: chavez skills list|add|rm");
}
```

`apiFetch` ya pone `Content-Type` en otros commands; si no, añadir header JSON.

- [ ] En `cli/src/index.ts`: case `"skills"`: `await skillsCommand(rest);`. Usage: `chavez skills list|add|rm`.

- [ ] En `cli/src/commands/headless.ts` grupo nuevo `mcp` y `skills`:

```
chavez headless mcp status
chavez headless skills
```

Ambos: bind workspace cwd, `workspace.mcp.snapshot` / `workspace.skills.snapshot`, print JSON. Sin daemon → el error `NO_DAEMON_ERROR` tal cual.

- [ ] Watch: si `cli/src/llm/watch-format.ts` existe, añadir **antes** del generic `chat.tool.*`:

```
chat.mcp.status          →  mcp · failed: a, b · native tools continue
                         o  mcp · connected: a, b
chat.skill.activated     →  skill · {name} · {layer}
chat.subagent.start      →  subagent · {agentType} · running
chat.subagent.end        →  subagent · {agentType} · done|error
chat.capability.degraded →  degraded · {feature} · {message}
chat.tool.* kind=mcp     →  mcp · {canonical} · {status}
chat.tool.* kind=skill   →  skill · {name} · {status}
chat.tool.* parentToolCallId →  indentar con dos espacios  "  {line}"
```

Si `watch-format.ts` no existe, crear `cli/src/llm/watch-format.ts` con firma `formatWatchLine(msg: { type: string; data?: unknown }): string | null` y los cases de agent-tools Task 5 **más** estos. En `headless.ts` `chat watch`, si retorna string imprimir esa línea; si null, caer al JSON.

- [ ] Tests `watch-format-mcp.test.ts` y `skills-format.test.ts` (formatter de `on/off name desc` extraído).

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format-mcp.test.ts src/commands/skills-format.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/ws/daemon.ts cli/src/commands/headless.ts \
  cli/src/commands/skills.ts cli/src/commands/skills-format.test.ts \
  cli/src/index.ts cli/src/llm/watch-format.ts cli/src/llm/watch-format-mcp.test.ts
git commit -m "feat(cli): MCP snapshot, user skills CRUD, watch lines"
```

---

## Task 9: TUI — grupo de subagente, skill, banner MCP, tecla `k`

**Files:**

- Modify: `tui/src/App.tsx`
- Test: `tui/src/mcp-view.test.ts` (helpers puros extraídos; Ink no se monta)

- [ ] Extender `type Message`:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
};
```

Si el plan 2 ya lo hizo, no pises. Al pintar `role === "tool"`:

```
kind=subagent  →  "subagent · {agentType} · {status}"
kind=skill     →  "skill · {name} · {status}"
kind=mcp       →  "mcp · {canonical} · {status}"
parentToolCallId →  indent  "  {line}"  (máx. 2 niveles)
```

Agrupar en memoria: `Map<subagentId, childIds>`. Un hijo cuyo padre aún no llegó se lista plano (no se pierde).

- [ ] Banner sobre el chat cuando el último `chat.mcp.status` tenga failed:

```
MCP failed: foo, bar — native tools continue
```

Degraded: línea `degraded · skill · Cursor does not load skill "pdf"…`.

- [ ] Tecla `k` en command mode (no compose, no busy-lock de navegación): overlay `skills` con counts user/project/local y titles de `applied` (RPC `workspace.skills.snapshot`). Sin daemon: muestra el `NO_DAEMON_ERROR`. Escape cierra el overlay; **no** mata la TUI (si plan 16 ya cambió Escape a cancel, respétalo: Escape en overlay cierra overlay; Escape sin overlay cancela turn).

Si `r` (rules) o `g` (git) existen, el overlay de `k` es el mismo patrón (un `overlay: null | "skills"`).

- [ ] `onPush`:

  - `chat.mcp.status` / `chat.skill.activated` / `chat.subagent.*` / `chat.capability.degraded` / `chat.tool.*` → actualizar messages o banners. Invalidar/recargar `chat.get` si el plan 2 aún recarga entero; si ya hay patch in-place, parchear.

- [ ] Extraer `formatTuiToolLine(meta, content)` y `indentIfChild(line, parentToolCallId)` a `tui/src/tool-line.ts` (o `cli/src/llm/tool-display.ts` si TUI ya importa CLI). Tests:

  - subagent running.
  - child indent.
  - mcp failed banner incluye `native tools continue`.
  - skill layer `local`.

- [ ] Correr:

```bash
cd tui && bun test src/mcp-view.test.ts
```

Si tui no tiene script test, añadir `"test": "bun test"` en `tui/package.json` sin quitar `start`/`dev`. Alternativa: poner el helper en `cli/src/llm/tui-tool-line.ts` y testear desde `cli`.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/tool-line.ts tui/src/mcp-view.test.ts tui/package.json \
  cli/src/llm/tui-tool-line.ts
git commit -m "feat(tui): nest subagent tools and show MCP/skill status"
```

---

## Task 10: Web — ToolCard MCP/skill, SubagentGroup, banner, página `/skills`

**Files:**

- Create: `web/src/lib/mcp-display.ts`
- Test: `web/src/lib/mcp-display.test.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Create: `web/src/components/SkillsPanel.tsx`
- Create: `web/src/pages/skills.astro`
- Modify: `web/src/layouts/BaseLayout.astro`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/package.json`

Web **no** importa `cli/`. Duplicar `canonicalMcpName` / labels en `web/src/lib/mcp-display.ts` con comentario `// keep-in-sync with cli/src/llm/mcp-names.ts`.

- [ ] Añadir `"test": "bun test"` en `web/package.json` si falta (dejar `dev`/`build`/`preview`).

- [ ] `web/src/lib/mcp-display.ts`:

```ts
export function canonicalMcpName(toolName: string): string {
  if (toolName === "Skill" || toolName === "skill") return "skill";
  if (toolName === "Task" || toolName === "Agent" || toolName === "task") return "subagent";
  const m = String(toolName).match(/^mcp__([^_]+)__(.+)$/);
  if (!m) return String(toolName).toLowerCase();
  if (m[1] === "chavez-skills") return "skill";
  if (m[1] === "chavez-git") return m[2];
  return `mcp:${m[1]}/${m[2]}`;
}

export function mcpFailedBanner(servers: Array<{ name: string; status: string }>): string | null {
  const failed = servers.filter((s) => s.status === "failed").map((s) => s.name);
  if (!failed.length) return null;
  return `MCP failed: ${failed.join(", ")} — native tools continue`;
}

export function groupToolsBySubagent<T extends { id: string; metadata?: Record<string, unknown> }>(
  messages: T[],
): { roots: T[]; childrenOf: Map<string, T[]> } {
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const m of messages) {
    const parent = String(m.metadata?.parentToolCallId || m.metadata?.subagentId || "");
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
```

- [ ] Tests: banner null si no hay failed; grouping anida un child; `mcp__linear__list_issues` → `mcp:linear/list_issues`.

- [ ] `queryKeys.skills: ["skills"]`.

- [ ] `hooks.ts`: `useSkills`, `useCreateSkill`, `useUpdateSkill`, `useDeleteSkill` (mismo patrón `useMe` / providers: `apiJson` + cookie). Types `UserSkill`.

- [ ] `ChatDetailPanel.tsx`:

  1. Estado `mcpServers` desde push `chat.mcp.status`. Banner rojo/muted con `mcpFailedBanner`.
  2. Push `chat.capability.degraded` → `<p className="muted">` con el message (no se finge la tool).
  3. Push `chat.skill.activated` → chip `skill · {name} · {layer}` sobre el assistant live.
  4. `ToolCard`: badge `mcp|skill|subagent|tool · {canonical} · {status}`. Input redactado ya viene de API. Si `kind==="subagent"` y status running, texto `running`; done muestra `summary`.
  5. Agrupar: para cada root subagent, `<details open={status==="running"}>` con summary el grupo y dentro los `childrenOf.get(toolCallId|subagentId)`.
  6. Botones approve/deny (plan 3/13) **también** en MCP mutable `awaiting_approval`. Una a una. Skills y reads: sin botones.
  7. `onPush` types nuevos: invalidar `queryKeys.chat(chatId)` igual que `chat.tool.*`.

- [ ] `SkillsPanel.tsx` + `pages/skills.astro`: lista de skills de cuenta (nombre, description, enabled, edit body, delete). POST valida en API; mostrar el error 400 tal cual. Sin daemon se puede CRUD. Copy: “Aplican en todos tus workspaces. Un SKILL.md del repo con el mismo name las anula.”

- [ ] `BaseLayout.astro` nav: `<a href="/skills">Skills</a>` junto a Providers.

- [ ] Correr:

```bash
cd web && bun test src/lib/mcp-display.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add web/src/lib/mcp-display.ts web/src/lib/mcp-display.test.ts \
  web/src/components/ChatDetailPanel.tsx web/src/components/SkillsPanel.tsx \
  web/src/pages/skills.astro web/src/layouts/BaseLayout.astro \
  web/src/lib/hooks.ts web/src/lib/query-keys.ts web/package.json
git commit -m "feat(web): timeline MCP/skills/subagents and user skills page"
```

---

## Task 11: Smoke Gherkin — los ocho escenarios, sin fingir paridad

**Files:**

- Create: `cli/scripts/mcp-skills-smoke.ts`
- Create: `cli/src/llm/gherkin-mcp.test.ts`
- Modify: `cli/package.json` (script opcional `"test:mcp-smoke": "bun run scripts/mcp-skills-smoke.ts"`)

No LLM vivo obligatorio: los escenarios de parse/gate/budget/codec se demuestran con `bun test`. El smoke de disco usa tmp + un MCP stdio **fake** (script node que implementa handshake mínimo **o** un command `false`/`/bin/true` para el caso fail).

- [ ] `cli/src/llm/gherkin-mcp.test.ts` — un describe por escenario:

**MCP del workspace se carga**

- tmp `.mcp.json` `{ mcpServers: { echo: { command: "node", args: ["-e", "process.stdin.resume()"] } } }`.
- `loadMcpFromDisk` → server `echo`.
- `canonicalMcpName("mcp__echo__ping")` → `mcp:echo/ping`.
- `gateMcpTool("ask", "mcp__echo__ping", { readOnly: false, destructive: false, openWorld: false })` → ask.
- `gateMcpTool("ask", "mcp__echo__get", { readOnly: true, destructive: false, openWorld: false })` → allow.

**MCP falla al arrancar**

- `.mcp.json` `{ mcpServers: { dead: { command: "mcp-server-does-not-exist-xyz" } } }` parsea (no throw).
- `formatMcpFailedSystem([{ name: "dead", status: "failed" }])` incluye `dead` y `Native tools continue`.
- `DEFAULT_CLAUDE_TOOLS` sigue teniendo `Read`.
- `shouldRetryWithoutProjectMcp(new Error("MCP server dead failed to connect")) === true`.

**Skills del proyecto**

- tmp `.claude/skills/pdf/SKILL.md` con frontmatter name/description.
- `loadSkillsFromDisk` applied contiene `pdf` layer project.
- `formatSkillsPrompt` menciona `pdf`.
- Activación: `canonicalMcpName("mcp__chavez-skills__skill") === "skill"`.

**Skills de usuario**

- user row `pdf` + project `pdf` → applied layer **project** (anula).
- user row `acct` only → applied layer user.
- `isSkillName("acct")` true. HTTP errors: ya en Task 4.

**Subagente**

- Fixture `task_started` + `tool_use` Read con `agent_id` → start grupo + child `parentToolCallId`.
- `groupToolsBySubagent` (duplicar 8 líneas en el test CLI o importar de un módulo `cli/src/llm/subagent-group.ts` extraído de la lógica web) anida.
- Status running → done vía `task_notification`.

**Presupuesto de subagentes**

- 8 `trySpawnSubagent` ok; 9º mensaje **exacto** `Subagent budget exceeded (max 8 per turn)`.
- `gateSubagentSpawn` deny no incrementa si usas el return `ok: false` (el caller no asigna `next`).

**Subagente en modo plan**

- `gateMcpTool("plan", "mcp__echo__write", emptyAnn)` → deny `PLAN_MCP_MUTATION_DENIED`.
- `gateClass` Write + plan → `PLAN_MUTATION_DENIED` (plan 3; si `execution-gate.ts` existe, llamarlo; si no, assert el string constante).
- Spawn Task en plan → allow (el hijo write es quien se deniega).

**Provider Claude vs Cursor**

- `CLAUDE_CAPS` todo true.
- `cursorCapsStatic().nestedSubagentTools === false`.
- `cursorSkillDegraded("pdf")` contiene `pdf` y `not faking` no hace falta: el string congelado `Cursor does not load skill "pdf" the same way as Claude — offering description only`.
- Un test que **prohíbe** sintetizar tool_start: `degradeEvents` retorna `{ kind: "capability_degraded" }` y **cero** `tool_start`.

- [ ] `cli/scripts/mcp-skills-smoke.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpFromDisk } from "../src/llm/mcp-load";
import { loadSkillsFromDisk } from "../src/llm/skills-load";
import { createSubagentBudget, trySpawnSubagent } from "../src/llm/subagent-budget";
import { CLAUDE_CAPS, cursorCapsStatic } from "../src/llm/provider-caps";

const dir = mkdtempSync(join(tmpdir(), "chavez-mcp-"));
writeFileSync(
  join(dir, ".mcp.json"),
  JSON.stringify({ mcpServers: { broken: { command: "__nope__" } } }),
);
mkdirSync(join(dir, ".claude/skills/demo"), { recursive: true });
writeFileSync(
  join(dir, ".claude/skills/demo/SKILL.md"),
  "---\nname: demo\ndescription: demo skill\n---\nDo the demo.\n",
);
const mcp = loadMcpFromDisk(dir);
if (mcp.servers.length !== 1) throw new Error("expected 1 mcp server config");
const skills = loadSkillsFromDisk(dir, [
  { name: "demo", description: "user", body: "user body", enabled: true },
]);
if (skills.applied[0]?.layer !== "project") {
  throw new Error("project should override user skill");
}
let b = createSubagentBudget();
for (let i = 0; i < 8; i++) {
  const r = trySpawnSubagent(b, 1);
  if (!r.ok) throw new Error("spawn should succeed");
  b = r.next;
}
if (trySpawnSubagent(b, 1).ok) throw new Error("9th spawn must fail");
if (!CLAUDE_CAPS.mcp || cursorCapsStatic().nestedSubagentTools) {
  throw new Error("caps mismatch");
}
console.log("mcp-skills-smoke ok", dir);
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/gherkin-mcp.test.ts
cd cli && bun run scripts/mcp-skills-smoke.ts
```

Esperado: tests verdes; smoke imprime `mcp-skills-smoke ok`.

- [ ] Commit:

```bash
git add cli/scripts/mcp-skills-smoke.ts cli/src/llm/gherkin-mcp.test.ts \
  cli/src/llm/subagent-group.ts cli/package.json
git commit -m "test(mcp): gherkin coverage for MCP, skills and subagents"
```

---

## Orden de implementación y riesgos

1. Tasks 1–3 son puras: se pueden mergear en paralelo con 4.
2. Task 5 depende de 1–2. Task 6 depende de 3+5 y de planes 2/3/7 (gate + git MCP). Task 7 puede ir en paralelo a 5 si los event names ya están congelados.
3. UI (8–10) depende del contrato WS de 6–7.
4. Riesgo: `createSdkMcpServer` + varios servers — mergear dict, nunca reemplazar `chavez-git`.
5. Riesgo: `query()` que throw por MCP — retry sin project MCP, nativas siguen.
6. Riesgo: Cursor types sin `customTools` — degradar, no `as any`.
7. Riesgo: subagente background que sobrevive al turn — `finally` espera `task_notification` o timeout `MCP_TOOL_TIMEOUT_MS` por hijo, luego `agent.turn.ended`. No segundo turn.
8. Riesgo: secretos en `env` MCP — redact en display; no loguear `toClaudeMcpServers` completo.
9. Marketplace (plan 36) instalará encima de `/skills` y `.mcp.json`; no adelantar catálogo remoto.

## Verificación rápida (implementador)

```bash
cd cli && bun test src/llm/mcp-names.test.ts src/llm/mcp-classify.test.ts \
  src/llm/mcp-parse.test.ts src/llm/mcp-load.test.ts src/llm/mcp-gate.test.ts \
  src/llm/skills-parse.test.ts src/llm/skills-merge.test.ts src/llm/skills-load.test.ts \
  src/llm/subagent-budget.test.ts src/llm/subagent-events.test.ts \
  src/llm/provider-caps.test.ts src/llm/gherkin-mcp.test.ts
cd api && bun test src/llm/skills-constants.test.ts src/routes/skills.test.ts \
  src/ws/mcp-protocol.test.ts
cd web && bun test src/lib/mcp-display.test.ts
```
