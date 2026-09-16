# Project rules Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, memoria entre chats (plan 31), slash `/rules` (plan 11), compact de contexto (plan 10), cola de turns (plan 29), ni skills/MCP (plan 19). Spec: [`plan.md`](./plan.md). Depende de tools ([`agent-tools`](../agent-tools/implementation.md)), modos ([`execution-modes`](../execution-modes/implementation.md)), git ([`git-workspace`](../git-workspace/implementation.md)) e ignore/secrets ([`ignore-secrets`](../ignore-secrets/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El agente recibe reglas en **tres capas** — usuario (cuenta Chavez, todas las máquinas), proyecto (AGENTS.md + nativos Claude/Cursor del repo, commiteables) y local (esta máquina/workspace, nunca git). Las tres se inyectan en cada turn. Si hay conflicto explícito, **local gana sobre proyecto, proyecto sobre usuario**. Faltar `AGENTS.md` no falla el turn. Web/TUI muestran cuántas reglas y de qué capa usó el turn (títulos; no el texto completo si es enorme). Una restricción local `disallowTools: [bash]` se respeta **además** del modo: en `auto`, bash queda `denied`.

**Architecture:** El filesystem de proyecto/local vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** lee el cwd: persiste reglas de **usuario** (tabla `user_rules`) y el toggle por workspace (`workspaces.user_rules_enabled`), reenvía RPCs `workspace.rules.*` al daemon bound y hace fan-out del metadata del turn. Chavez carga los nativos **él mismo** (`settingSources: []` se mantiene) para no duplicar CLAUDE.md, aplicar las tres capas con precedencia explícita, y poder mostrar qué se usó.

```
PUT /rules  (capa usuario, vault de la cuenta)
PUT /workspaces/:id/preferences { userRulesEnabled }
        |
        v
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API
        |  lee user_rules (si workspace.userRulesEnabled)
        |  dispatch { prompt, userRules, userRulesEnabled }
        v
  daemon / TUI
        |  loadProjectRules(cwd)   AGENTS.md + CLAUDE.md + .claude/ + .cursor/ + .cursorrules
        |  loadLocalRules(cwd)     CLAUDE.local.md + CHAVEZ.local.md + .chavez/rules.local.md
        |                          + ~/.chavez/workspaces/<hash>/rules.local.md
        |  missing files → []  (nunca throw)
        |  mergeLayers: local > project > user
        v
  query({
    settingSources: [],                          // no auto-load CLAUDE.md
    appendSystemPrompt: formatRulesPrompt(bundle),
    canUseTool: sandbox + mode + denyIfRuleDisallowed
  })
        |
        |  bash + local disallow  → deny RULE_TOOL_DENIED  (también en auto)
        |  chat.stream.end metadata.rules { counts, applied[] }  // títulos, no body
        v
  Web RulesChip · TUI tecla r · CLI watch  (mismo contrato)
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y `settingSources: []`. **No** hay `appendSystemPrompt`. Hoy `permissionMode` es `bypassPermissions`; planes 2–3 lo pasan a `default` + `canUseTool`. **No** volver a `bypassPermissions`.
- `cli/src/llm/publish-turn.ts` lee provider/model/effort de GET `/providers`. **No** carga reglas ni estampa `metadata.rules`.
- `cli/src/llm/history.ts` incluye `role=system` si aparece en DB. **No** persistir las reglas como mensaje `system` (duplicaría cada turn y inflaría el presupuesto). Solo `appendSystemPrompt` + metadata del assistant.
- `api/src/db/schema.ts` `user_preferences` tiene provider/model/effort (y `activeExecutionMode` si plan 3 aterrizó). **No** hay `user_rules`. `workspaces` **no** tiene `userRulesEnabled`.
- `api/src/ws/handlers.ts` despacha `agent.turn.request` **sin** user rules. `chat.stream.end` ya mergea `msg.metadata` en el assistant.
- Ignore (plan 8) clasifica `.chavez/` in-cwd como **vault**. El loader de reglas locales **sí** lee `.chavez/rules.local.md` (excepción explícita). Las tools del LLM **siguen** sin poder leer el vault.
- Git (plan 7) llama `gitCommitBlockedReason` / `assertCommitPathsAllowed`. Esta fase **añade** paths locales (`CHAVEZ.local.md`, `CLAUDE.local.md`) a esa guarda y escribe `.git/info/exclude` (no el `.gitignore` commiteable).
- Cursor `runnable: false` hasta el [plan 4](../cursor-provider/implementation.md). El bundle se calcula igual; `applyRulesToCursorPrompt` queda listo para cuando Cursor ejecute. No simular turns de Cursor.
- Web `ChatDetailPanel.tsx` pinta `role` + `content`. **No** hay chip de reglas. TUI `App.tsx` teclas `p` `[` `]` `{` `}` `m`. **No** hay `r`.
- CLI: no hay `chavez rules`. Headless no lista reglas.

**Tech Stack:** Bun, Hono + Drizzle (`user_rules` nueva, `workspaces.user_rules_enabled`), WebSocket hub + `createPendingMap` (reusar `api/src/ws/pending.ts` de attach-files), Claude Agent SDK `query` (`appendSystemPrompt`, `settingSources: []`, `permissionMode: "default"`, `canUseTool`), Ink TUI, Astro/React web. Sin paquete yaml nuevo: parser de frontmatter mínimo en `cli/src/llm/rules-parse.ts`. Sin isomorphic-git.

**Global Constraints:**

1. El filesystem de proyecto/local se lee y escribe **solo** en el daemon (cwd del workspace / `~/.chavez/workspaces/<hash>/`). API y browser no leen `AGENTS.md` del servidor ni del disco del API.
2. Sin daemon bound, `agent.turn.request` y `workspace.rules.*` fallan con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. Las reglas de **usuario** (HTTP `/rules`) **sí** funcionan sin daemon.
3. Tres capas, no un solo archivo. Precedencia de conflicto explícito: **local > proyecto > usuario**. El texto de las tres se inyecta (local al final). `disallowTools`/`allowTools` se fusionan con esa misma precedencia.
4. Capa proyecto = archivos del repo: `AGENTS.md` + nativos Claude/Cursor. El usuario **no** copia a mano. `settingSources` permanece `[]` para no doble-inyectar CLAUDE.md.
5. Capa local **no** se sube a git (plan 7): `.git/info/exclude` + `gitCommitBlockedReason`. Otra máquina no la ve (vive en cwd gitignored y/o `~/.chavez/workspaces/<hash>/`).
6. Capa usuario vive en la API (cuenta). Sigue entre workspaces. Se puede **desactivar por workspace** (`userRulesEnabled: false`); proyecto y local siguen aplicando.
7. Sin archivos de reglas el turn corre igual. **Cero** errores del tipo “falta AGENTS.md”.
8. Visible al terminar el turn: Web, TUI y `chat watch` muestran `counts` (user/project/local) y **títulos**. El body completo **no** viaja en `metadata` si supera `RULE_PREVIEW_CHARS`.
9. Lecturas (read/grep/glob) no piden confirmación. Write/edit/bash siguen el modo (plan 3) **y** `disallowTools` de las reglas. En `auto`, una regla local que desautoriza bash **deniega** la invocación (`RULE_TOOL_DENIED`). El disco no cambia.
10. Aprobaciones una a una (plan 11/13). Las reglas no introducen “siempre permitir”.
11. 1 turn por daemon. Cambiar reglas **no** cancela el turn en curso; aplica al **siguiente**.
12. Claude es el provider ejecutable. Cursor vinculado no ejecuta aquí; el mismo bundle se pasará a `runCursorTurn` cuando exista.
13. Un usuario = su vault. Las `user_rules` filtran por `eq(userId)`. Sin org ni roles.
14. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, memoria (plan 31), slash `/rules`, compact.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `RULE_LAYERS` | `"user"` \| `"project"` \| `"local"` |
| `USER_RULES_MAX` | `50` |
| `USER_RULE_TITLE_MAX` | `120` |
| `USER_RULE_BODY_MAX` | `32_000` |
| `RULE_BODY_MAX_CHARS` | `32_000` |
| `RULE_PREVIEW_CHARS` | `2_000` |
| `RULES_PROMPT_MAX_CHARS` | `80_000` |
| `RULE_PROJECT_FILES_MAX` | `40` |
| `RULES_RPC_TIMEOUT_MS` | `5_000` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `MISSING_AGENTS_OK` | no es un string de error — ausencia = lista vacía |
| `RULE_TOOL_DENIED` | `` `Rule (${layer} "${title}"): tool "${tool}" is disallowed` `` |
| `LOCAL_RULE_COMMIT_DENIED` | `` `Refusing to commit local rule file: ${path}` `` |
| `USER_RULES_CAP_ERROR` | `"Maximum 50 user rules"` |
| `USER_RULE_TITLE_ERROR` | `"title must be 1–120 characters"` |
| `USER_RULE_BODY_ERROR` | `"body must be 1–32000 characters"` |
| `INVALID_DISALLOW_ERROR` | `"disallowTools must be canonical tool names: read, write, edit, grep, glob, bash"` |
| `RULES_PREAMBLE` | `"Chavez project rules are in effect. Three layers apply: user, project, local. If they conflict, local overrides project, and project overrides user."` |
| `NO_RULES_LABEL` | `"0 reglas"` |
| `LOCAL_MACHINE_FILE` | `"rules.local.md"` (bajo `~/.chavez/workspaces/<hash>/`) |
| `LOCAL_CWD_FILES` | `CLAUDE.local.md`, `CHAVEZ.local.md`, `.chavez/rules.local.md` |
| `GITEXCLUDE_LINES` | `CHAVEZ.local.md`, `CLAUDE.local.md`, `.chavez/` |
| `CANONICAL_DISALLOW_TOOLS` | `"read"` \| `"write"` \| `"edit"` \| `"grep"` \| `"glob"` \| `"bash"` |

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `workspace.rules.snapshot` | cliente → API | Pedir titles de proyecto + local + body local editable. API espera al daemon. |
| `workspace.rules.local.set` | cliente → API | Escribir el archivo máquina `~/.chavez/workspaces/<hash>/rules.local.md`. |
| `workspace.rules.dispatch` | API → daemon | `{ requestId, action: "snapshot"\|"local.set", path, payload }` |
| `workspace.rules.result` | daemon → API | Completa el pending. |
| `workspace.rules.changed` | API → broadcast | `{ workspaceId, snapshot }` para que Web/TUI coincidan. |
| `rules.updated` | API → broadcast | Tras CRUD HTTP de capa usuario. |

HTTP:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/rules` | `{ rules: UserRule[] }` de **este** `userId`. 401 sin sesión. |
| `POST` | `/rules` | `{ title, body, enabled?, disallowTools?, allowTools? }`. 400 si cap/validación. |
| `PUT` | `/rules/:id` | Patch. 404 si no es del usuario. |
| `DELETE` | `/rules/:id` | 404 si no es del usuario. |
| `GET` | `/workspaces` | Cada row incluye `userRulesEnabled` (default `true`). |
| `PUT` | `/workspaces/:workspaceId/preferences` | `{ userRulesEnabled: boolean }`. 404 si no es del usuario. |

Tipos (congelados):

```ts
export const RULE_LAYERS = ["user", "project", "local"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

export const CANONICAL_DISALLOW_TOOLS = [
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "bash",
] as const;
export type CanonicalDisallowTool = (typeof CANONICAL_DISALLOW_TOOLS)[number];

export type RuleSource = {
  layer: RuleLayer;
  id?: string;          // user rule id, or hash of path
  title: string;
  body: string;
  path?: string;        // relative cwd, or "~/.chavez/workspaces/<hash>/rules.local.md"
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  chars: number;
  truncated: boolean;
  globs?: string[];     // from Cursor .mdc
  alwaysApply?: boolean;
};

export type RuleRef = Omit<RuleSource, "body">; // lo que viaja en metadata / UI

export type RulesBundle = {
  user: RuleSource[];
  project: RuleSource[];
  local: RuleSource[];
  userRulesEnabled: boolean;
  /** After merge: tools the gate must deny. */
  disallowedTools: CanonicalDisallowTool[];
};

export type RulesMetadata = {
  counts: { user: number; project: number; local: number; total: number };
  applied: RuleRef[];
};

export type UserRule = {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  createdAt: string;
  updatedAt: string;
};
```

Archivos nativos de **proyecto** (cwd; silent skip si no existen):

| Path | Título default |
|---|---|
| `AGENTS.md` | `AGENTS.md` |
| `CLAUDE.md` | `CLAUDE.md` |
| `.claude/CLAUDE.md` | `.claude/CLAUDE.md` |
| `.claude/rules/**/*.md` | basename |
| `.cursorrules` | `.cursorrules` |
| `.cursor/rules.md` | `.cursor/rules.md` |
| `.cursor/rules/**/*.{md,mdc}` | basename |

**No** son proyecto (van a **local**): `CLAUDE.local.md`, `CHAVEZ.local.md`, `.chavez/rules.local.md`. **No** se carga `~/.claude/CLAUDE.md` (eso es Claude Code en esta máquina, no la cuenta Chavez).

Capa **local** (orden de merge, el último gana entre locales):

1. `CLAUDE.local.md` (cwd)
2. `CHAVEZ.local.md` (cwd)
3. `.chavez/rules.local.md` (cwd)
4. `~/.chavez/workspaces/<hash>/rules.local.md` (canónico que escribe la UI)

Frontmatter soportado (YAML mínimo):

```yaml
---
disallowTools: [bash]
allowTools: [write]
alwaysApply: true
globs: ["src/**/*.ts"]
title: Optional title
---
```

---

## Task 1: Módulos puros — tipos, parse, merge, prompt, metadata

**Files:**

- Create: `cli/src/llm/rules-constants.ts`
- Create: `cli/src/llm/rules-parse.ts`
- Create: `cli/src/llm/rules-merge.ts`
- Test: `cli/src/llm/rules-parse.test.ts`
- Test: `cli/src/llm/rules-merge.test.ts`
- Modify: `cli/package.json`

Sin I/O de disco ni red. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Task 3 duplica el enum de tools canónicos y los errores HTTP.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/rules-constants.ts`:

```ts
export const RULE_LAYERS = ["user", "project", "local"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

export const CANONICAL_DISALLOW_TOOLS = [
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "bash",
] as const;
export type CanonicalDisallowTool =
  (typeof CANONICAL_DISALLOW_TOOLS)[number];

export const USER_RULES_MAX = 50;
export const USER_RULE_TITLE_MAX = 120;
export const USER_RULE_BODY_MAX = 32_000;
export const RULE_BODY_MAX_CHARS = 32_000;
export const RULE_PREVIEW_CHARS = 2_000;
export const RULES_PROMPT_MAX_CHARS = 80_000;
export const RULE_PROJECT_FILES_MAX = 40;
export const RULES_RPC_TIMEOUT_MS = 5_000;

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const USER_RULES_CAP_ERROR = "Maximum 50 user rules";
export const USER_RULE_TITLE_ERROR = "title must be 1–120 characters";
export const USER_RULE_BODY_ERROR = "body must be 1–32000 characters";
export const INVALID_DISALLOW_ERROR =
  "disallowTools must be canonical tool names: read, write, edit, grep, glob, bash";

export const RULES_PREAMBLE =
  "Chavez project rules are in effect. Three layers apply: user, project, local. If they conflict, local overrides project, and project overrides user.";

export const NO_RULES_LABEL = "0 reglas";

export function ruleToolDenied(
  layer: RuleLayer,
  title: string,
  tool: string,
): string {
  return `Rule (${layer} "${title}"): tool "${tool}" is disallowed`;
}

export function localRuleCommitDenied(path: string): string {
  return `Refusing to commit local rule file: ${path}`;
}

export const LOCAL_CWD_RELATIVE = [
  "CLAUDE.local.md",
  "CHAVEZ.local.md",
  ".chavez/rules.local.md",
] as const;

export const GITEXCLUDE_LINES = [
  "CHAVEZ.local.md",
  "CLAUDE.local.md",
  ".chavez/",
] as const;

export const PROJECT_ROOT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".cursor/rules.md",
  ".claude/CLAUDE.md",
] as const;

export function isCanonicalDisallowTool(
  v: unknown,
): v is CanonicalDisallowTool {
  return (
    typeof v === "string" &&
    (CANONICAL_DISALLOW_TOOLS as readonly string[]).includes(v)
  );
}

export function parseCanonicalToolList(
  v: unknown,
): CanonicalDisallowTool[] | null {
  if (v == null) return [];
  if (typeof v === "string") {
    const parts = v
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.some((p) => !isCanonicalDisallowTool(p))) return null;
    return parts as CanonicalDisallowTool[];
  }
  if (!Array.isArray(v)) return null;
  const out: CanonicalDisallowTool[] = [];
  for (const item of v) {
    const s = String(item).trim().toLowerCase();
    if (!isCanonicalDisallowTool(s)) return null;
    out.push(s);
  }
  return out;
}
```

Si `NO_DAEMON_ERROR` ya vive en `cli/src/llm/tool-names.ts`, reexportar el mismo literal (no duplicar otro wording).

- [ ] Crear `cli/src/llm/rules-parse.ts`. Parser de frontmatter mínimo (bloque `---` inicial, `key: value` o `key: [a, b]` o `key:` + lista `- item`). Extrae título: `frontmatter.title` → primer heading `# ` / `## ` → basename del path → `"Untitled rule"`. Trunca body a `RULE_BODY_MAX_CHARS`.

```ts
import {
  RULE_BODY_MAX_CHARS,
  USER_RULE_TITLE_MAX,
  parseCanonicalToolList,
  type CanonicalDisallowTool,
  type RuleLayer,
} from "./rules-constants";

export type ParsedRuleFile = {
  title: string;
  body: string;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  globs: string[];
  alwaysApply: boolean;
  truncated: boolean;
};

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseScalarList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s))
    .filter(Boolean);
}

export function parseFrontmatter(raw: string): {
  attrs: Record<string, unknown>;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { attrs: {}, body: text };
  const rest = text.slice(3);
  const nl = rest.startsWith("\n") || rest.startsWith("\r\n") ? rest : "";
  if (!nl && rest[0] !== "\n" && rest[0] !== "\r") {
    return { attrs: {}, body: text };
  }
  const end = rest.search(/\r?\n---[ \t]*\r?\n/);
  if (end < 0) return { attrs: {}, body: text };
  const fm = rest.slice(0, end).replace(/^\r?\n/, "");
  const after = rest.slice(end).replace(/^\r?\n---[ \t]*\r?\n/, "");
  const attrs: Record<string, unknown> = {};
  let pendingKey: string | null = null;
  for (const line of fm.split(/\r?\n/)) {
    const listItem = pendingKey && /^\s+-\s+(.+)$/.exec(line);
    if (listItem) {
      const arr = Array.isArray(attrs[pendingKey!])
        ? (attrs[pendingKey!] as unknown[])
        : [];
      arr.push(stripQuotes(listItem[1]!));
      attrs[pendingKey!] = arr;
      continue;
    }
    pendingKey = null;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.trim();
    if (val === "" || val === "|" || val === ">") {
      pendingKey = key;
      attrs[key] = [];
      continue;
    }
    if (val.startsWith("[")) {
      attrs[key] = parseScalarList(val);
      continue;
    }
    if (val === "true" || val === "false") {
      attrs[key] = val === "true";
      continue;
    }
    attrs[key] = stripQuotes(val);
  }
  return { attrs, body: after };
}

export function titleFromBodyOrPath(
  body: string,
  pathOrFallback: string,
  fmTitle?: unknown,
): string {
  if (typeof fmTitle === "string" && fmTitle.trim()) {
    return fmTitle.trim().slice(0, USER_RULE_TITLE_MAX);
  }
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(body);
  if (heading?.[1]) {
    return heading[1].trim().slice(0, USER_RULE_TITLE_MAX);
  }
  const base = pathOrFallback.replace(/\\/g, "/").split("/").pop() || "Untitled rule";
  return base.slice(0, USER_RULE_TITLE_MAX);
}

export function parseRuleFile(
  raw: string,
  pathOrFallback: string,
): ParsedRuleFile {
  const { attrs, body: parsedBody } = parseFrontmatter(raw);
  let body = parsedBody.replace(/^\s+/, "");
  let truncated = false;
  if (body.length > RULE_BODY_MAX_CHARS) {
    const over = body.length - RULE_BODY_MAX_CHARS;
    body = `${body.slice(0, RULE_BODY_MAX_CHARS)}\n\n[truncated ${over} chars]`;
    truncated = true;
  }
  const disallow =
    parseCanonicalToolList(attrs.disallowTools ?? attrs.disallow) ?? [];
  const allow = parseCanonicalToolList(attrs.allowTools ?? attrs.allow) ?? [];
  const globsRaw = attrs.globs;
  const globs = Array.isArray(globsRaw)
    ? globsRaw.map(String)
    : typeof globsRaw === "string"
      ? parseScalarList(globsRaw)
      : [];
  const alwaysApply =
    attrs.alwaysApply === undefined ? true : Boolean(attrs.alwaysApply);
  return {
    title: titleFromBodyOrPath(body, pathOrFallback, attrs.title),
    body,
    disallowTools: disallow,
    allowTools: allow,
    globs,
    alwaysApply,
    truncated,
  };
}

export function toRuleSource(
  layer: RuleLayer,
  parsed: ParsedRuleFile,
  opts: { id?: string; path?: string; enabled?: boolean },
): import("./rules-merge").RuleSource {
  return {
    layer,
    id: opts.id,
    title: parsed.title,
    body: parsed.body,
    path: opts.path,
    enabled: opts.enabled !== false,
    disallowTools: parsed.disallowTools,
    allowTools: parsed.allowTools,
    chars: parsed.body.length,
    truncated: parsed.truncated,
    globs: parsed.globs,
    alwaysApply: parsed.alwaysApply,
  };
}
```

- [ ] Crear `cli/src/llm/rules-merge.ts`:

```ts
import {
  NO_RULES_LABEL,
  RULES_PREAMBLE,
  RULES_PROMPT_MAX_CHARS,
  ruleToolDenied,
  type CanonicalDisallowTool,
  type RuleLayer,
} from "./rules-constants";

export type RuleSource = {
  layer: RuleLayer;
  id?: string;
  title: string;
  body: string;
  path?: string;
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  chars: number;
  truncated: boolean;
  globs?: string[];
  alwaysApply?: boolean;
};

export type RuleRef = Omit<RuleSource, "body">;

export type RulesBundle = {
  user: RuleSource[];
  project: RuleSource[];
  local: RuleSource[];
  userRulesEnabled: boolean;
  disallowedTools: CanonicalDisallowTool[];
};

export type RulesMetadata = {
  counts: { user: number; project: number; local: number; total: number };
  applied: RuleRef[];
};

export function enabledOnly(rules: RuleSource[]): RuleSource[] {
  return rules.filter((r) => r.enabled && (r.body.trim() || r.disallowTools.length || r.allowTools.length));
}

/**
 * Apply layers in order user → project → local.
 * Each layer unions its disallowTools, then subtracts its allowTools.
 * Later layer wins on explicit conflict (allow in local undoes user/project disallow).
 */
export function mergeDisallowedTools(
  user: RuleSource[],
  project: RuleSource[],
  local: RuleSource[],
): CanonicalDisallowTool[] {
  const set = new Set<CanonicalDisallowTool>();
  const apply = (rules: RuleSource[]) => {
    for (const r of rules) {
      for (const t of r.disallowTools) set.add(t);
      for (const t of r.allowTools) set.delete(t);
    }
  };
  apply(user);
  apply(project);
  apply(local);
  return [...set];
}

export function assembleBundle(input: {
  user: RuleSource[];
  project: RuleSource[];
  local: RuleSource[];
  userRulesEnabled: boolean;
}): RulesBundle {
  const user = input.userRulesEnabled ? enabledOnly(input.user) : [];
  const project = enabledOnly(input.project);
  const local = enabledOnly(input.local);
  return {
    user,
    project,
    local,
    userRulesEnabled: input.userRulesEnabled,
    disallowedTools: mergeDisallowedTools(user, project, local),
  };
}

export function toRuleRef(r: RuleSource): RuleRef {
  const { body: _body, ...ref } = r;
  return ref;
}

export function rulesMetadata(bundle: RulesBundle): RulesMetadata {
  const applied = [...bundle.user, ...bundle.project, ...bundle.local].map(
    toRuleRef,
  );
  return {
    counts: {
      user: bundle.user.length,
      project: bundle.project.length,
      local: bundle.local.length,
      total: applied.length,
    },
    applied,
  };
}

export function formatRulesPrompt(bundle: RulesBundle): string | undefined {
  const sections: string[] = [];
  const pushLayer = (label: string, rules: RuleSource[]) => {
    if (!rules.length) return;
    sections.push(`## ${label}`);
    for (const r of rules) {
      const where = r.path ? ` (\`${r.path}\`)` : "";
      const globs =
        r.globs && r.globs.length
          ? `\nGlobs: ${r.globs.join(", ")}`
          : "";
      const tools =
        r.disallowTools.length || r.allowTools.length
          ? `\nStructured: disallowTools=[${r.disallowTools.join(",")}] allowTools=[${r.allowTools.join(",")}]`
          : "";
      sections.push(`### ${r.title}${where}${globs}${tools}\n\n${r.body}`);
    }
  };
  pushLayer("User rules", bundle.user);
  pushLayer("Project rules", bundle.project);
  pushLayer("Local rules (highest precedence)", bundle.local);
  if (!sections.length && !bundle.disallowedTools.length) return undefined;

  const extra = bundle.disallowedTools.length
    ? `\n\nHard tool restrictions (enforced by the host, not only this text): disallowed tools = ${bundle.disallowedTools.join(", ")}.`
    : "";
  let text = `${RULES_PREAMBLE}\n\n${sections.join("\n\n")}${extra}`;
  if (text.length > RULES_PROMPT_MAX_CHARS) {
    text = `${text.slice(0, RULES_PROMPT_MAX_CHARS)}\n\n[rules prompt truncated]`;
  }
  return text;
}

export function findDisallowingRule(
  bundle: RulesBundle,
  tool: CanonicalDisallowTool,
): RuleSource | null {
  // Highest layer that still disallows after merge: search local → project → user
  for (const r of [...bundle.local].reverse()) {
    if (r.allowTools.includes(tool)) return null;
    if (r.disallowTools.includes(tool)) return r;
  }
  for (const r of [...bundle.project].reverse()) {
    if (r.allowTools.includes(tool)) return null;
    if (r.disallowTools.includes(tool)) return r;
  }
  for (const r of [...bundle.user].reverse()) {
    if (r.allowTools.includes(tool)) return null;
    if (r.disallowTools.includes(tool)) return r;
  }
  return null;
}

export function denyIfRuleDisallowed(
  bundle: RulesBundle,
  canonicalTool: string,
): { behavior: "deny"; message: string } | null {
  const tool = canonicalTool as CanonicalDisallowTool;
  if (!bundle.disallowedTools.includes(tool)) return null;
  const rule = findDisallowingRule(bundle, tool);
  const layer = rule?.layer ?? "local";
  const title = rule?.title ?? "rule";
  return {
    behavior: "deny",
    message: ruleToolDenied(layer, title, tool),
  };
}

export function rulesWatchLine(meta: RulesMetadata): string {
  const { counts } = meta;
  if (counts.total === 0) return NO_RULES_LABEL;
  return `rules: ${counts.total} (user=${counts.user} project=${counts.project} local=${counts.local})`;
}
```

- [ ] Crear `cli/src/llm/rules-parse.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseFrontmatter, parseRuleFile, titleFromBodyOrPath } from "./rules-parse";

describe("parseFrontmatter", () => {
  test("no fence returns whole body", () => {
    const r = parseFrontmatter("hola\n");
    expect(r.attrs).toEqual({});
    expect(r.body).toBe("hola\n");
  });

  test("extracts disallowTools list and title", () => {
    const raw = `---
title: No bash
disallowTools: [bash]
alwaysApply: true
---
No uses bash en este workspace.
`;
    const parsed = parseRuleFile(raw, "CHAVEZ.local.md");
    expect(parsed.title).toBe("No bash");
    expect(parsed.disallowTools).toEqual(["bash"]);
    expect(parsed.body).toContain("No uses bash");
    expect(parsed.truncated).toBe(false);
  });

  test("mdc globs list", () => {
    const raw = `---
globs:
  - src/**/*.ts
alwaysApply: false
---
# RPC style
use bun
`;
    const parsed = parseRuleFile(raw, ".cursor/rules/rpc.mdc");
    expect(parsed.globs).toEqual(["src/**/*.ts"]);
    expect(parsed.alwaysApply).toBe(false);
    expect(parsed.title).toBe("RPC style");
  });

  test("heading fallback when no fm title", () => {
    expect(titleFromBodyOrPath("# Hola mundo\n\nbody", "AGENTS.md")).toBe(
      "Hola mundo",
    );
  });

  test("invalid disallowTools ignored (empty, not throw)", () => {
    const parsed = parseRuleFile(
      "---\ndisallowTools: [laser]\n---\nbody\n",
      "x.md",
    );
    expect(parsed.disallowTools).toEqual([]);
  });
});
```

- [ ] Crear `cli/src/llm/rules-merge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  assembleBundle,
  denyIfRuleDisallowed,
  formatRulesPrompt,
  mergeDisallowedTools,
  rulesMetadata,
  rulesWatchLine,
  type RuleSource,
} from "./rules-merge";
import { RULES_PREAMBLE } from "./rules-constants";

function rule(
  layer: RuleSource["layer"],
  title: string,
  extra: Partial<RuleSource> = {},
): RuleSource {
  return {
    layer,
    title,
    body: extra.body ?? `${title} body`,
    enabled: extra.enabled ?? true,
    disallowTools: extra.disallowTools ?? [],
    allowTools: extra.allowTools ?? [],
    chars: (extra.body ?? `${title} body`).length,
    truncated: false,
    ...extra,
  };
}

describe("mergeDisallowedTools", () => {
  test("local allow undoes user disallow (explicit conflict)", () => {
    const user = [rule("user", "u", { disallowTools: ["bash"] })];
    const local = [rule("local", "l", { allowTools: ["bash"] })];
    expect(mergeDisallowedTools(user, [], local)).toEqual([]);
  });

  test("local disallow wins over user allow", () => {
    const user = [rule("user", "u", { allowTools: ["bash"] })];
    const local = [rule("local", "l", { disallowTools: ["bash"] })];
    expect(mergeDisallowedTools(user, [], local)).toEqual(["bash"]);
  });

  test("project disallow stays if local silent", () => {
    const project = [rule("project", "p", { disallowTools: ["write"] })];
    expect(mergeDisallowedTools([], project, [])).toEqual(["write"]);
  });
});

describe("assembleBundle", () => {
  test("userRulesEnabled false drops user layer", () => {
    const b = assembleBundle({
      user: [rule("user", "español", { body: "responde en español" })],
      project: [rule("project", "AGENTS.md", { path: "AGENTS.md" })],
      local: [],
      userRulesEnabled: false,
    });
    expect(b.user).toHaveLength(0);
    expect(b.project).toHaveLength(1);
  });

  test("disabled rule dropped", () => {
    const b = assembleBundle({
      user: [rule("user", "off", { enabled: false })],
      project: [],
      local: [],
      userRulesEnabled: true,
    });
    expect(b.user).toHaveLength(0);
  });
});

describe("formatRulesPrompt", () => {
  test("undefined when nothing", () => {
    expect(
      formatRulesPrompt(
        assembleBundle({
          user: [],
          project: [],
          local: [],
          userRulesEnabled: true,
        }),
      ),
    ).toBeUndefined();
  });

  test("includes all three layers and preamble", () => {
    const text = formatRulesPrompt(
      assembleBundle({
        user: [rule("user", "español", { body: "responde en español" })],
        project: [rule("project", "AGENTS.md", { path: "AGENTS.md", body: "use bun" })],
        local: [
          rule("local", "No bash", {
            path: "CHAVEZ.local.md",
            body: "no uses bash",
            disallowTools: ["bash"],
          }),
        ],
        userRulesEnabled: true,
      }),
    );
    expect(text).toContain(RULES_PREAMBLE);
    expect(text).toContain("responde en español");
    expect(text).toContain("use bun");
    expect(text).toContain("no uses bash");
    expect(text).toContain("disallowed tools = bash");
  });
});

describe("denyIfRuleDisallowed", () => {
  test("auto-equivalent: bash denied by local", () => {
    const b = assembleBundle({
      user: [],
      project: [],
      local: [
        rule("local", "No bash", { disallowTools: ["bash"] }),
      ],
      userRulesEnabled: true,
    });
    const d = denyIfRuleDisallowed(b, "bash");
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toContain("No bash");
    expect(d?.message).toContain("bash");
    expect(denyIfRuleDisallowed(b, "read")).toBeNull();
  });
});

describe("rulesMetadata", () => {
  test("titles without bodies", () => {
    const b = assembleBundle({
      user: [rule("user", "español", { body: "x".repeat(5000) })],
      project: [],
      local: [],
      userRulesEnabled: true,
    });
    const meta = rulesMetadata(b);
    expect(meta.counts).toEqual({
      user: 1,
      project: 0,
      local: 0,
      total: 1,
    });
    expect(meta.applied[0]).not.toHaveProperty("body");
    expect(meta.applied[0]!.title).toBe("español");
    expect(rulesWatchLine(meta)).toBe(
      "rules: 1 (user=1 project=0 local=0)",
    );
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/rules-parse.test.ts src/llm/rules-merge.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/rules-constants.ts cli/src/llm/rules-parse.ts \
  cli/src/llm/rules-merge.ts cli/src/llm/rules-parse.test.ts \
  cli/src/llm/rules-merge.test.ts cli/package.json
git commit -m "feat(rules): parse frontmatter and merge user/project/local layers"
```

---

## Task 2: Loaders de disco — proyecto, local, git exclude

**Files:**

- Create: `cli/src/llm/rules-load.ts`
- Create: `cli/src/llm/rules-git-exclude.ts`
- Test: `cli/src/llm/rules-load.test.ts`
- Test: `cli/src/llm/rules-git-exclude.test.ts`

I/O de disco **local** (cwd del test / daemon). Sin red. El loader **nunca** throw por archivo ausente.

- [ ] Crear `cli/src/llm/rules-load.ts`:

```ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { workspaceHash } from "../workspace";
import {
  LOCAL_CWD_RELATIVE,
  PROJECT_ROOT_FILES,
  RULE_PROJECT_FILES_MAX,
} from "./rules-constants";
import { parseRuleFile, toRuleSource } from "./rules-parse";
import type { RuleSource } from "./rules-merge";

function readUtf8IfFile(abs: string): string | null {
  try {
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function listRuleFiles(dirAbs: string, exts: Set<string>): string[] {
  if (!existsSync(dirAbs)) return [];
  let st;
  try {
    st = statSync(dirAbs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let ents: string[] = [];
    try {
      ents = readdirSync(d);
    } catch {
      return;
    }
    for (const name of ents) {
      if (name.startsWith(".") && name !== ".") continue;
      const p = join(d, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) {
        const lower = name.toLowerCase();
        const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
        if (exts.has(ext)) out.push(p);
      }
    }
  };
  walk(dirAbs);
  return out.sort();
}

function relPosix(cwd: string, abs: string): string {
  return relative(cwd, abs).split(sep).join("/");
}

export function localMachineRulesPath(cwd: string): string {
  return join(
    homedir(),
    ".chavez",
    "workspaces",
    workspaceHash(cwd),
    "rules.local.md",
  );
}

export function loadProjectRules(cwd: string): RuleSource[] {
  const out: RuleSource[] = [];
  const seen = new Set<string>();
  const add = (abs: string, rel: string) => {
    if (seen.has(rel)) return;
    const raw = readUtf8IfFile(abs);
    if (raw == null) return;
    seen.add(rel);
    const parsed = parseRuleFile(raw, rel);
    out.push(
      toRuleSource("project", parsed, { id: `project:${rel}`, path: rel }),
    );
  };

  for (const rel of PROJECT_ROOT_FILES) {
    add(join(cwd, rel), rel);
  }
  const extraDirs = [
    join(cwd, ".claude", "rules"),
    join(cwd, ".cursor", "rules"),
  ];
  for (const dir of extraDirs) {
    const files = listRuleFiles(dir, new Set([".md", ".mdc"]));
    for (const abs of files) {
      if (out.length >= RULE_PROJECT_FILES_MAX) break;
      add(abs, relPosix(cwd, abs));
    }
  }
  return out.slice(0, RULE_PROJECT_FILES_MAX);
}

export function loadLocalRules(cwd: string): RuleSource[] {
  const out: RuleSource[] = [];
  for (const rel of LOCAL_CWD_RELATIVE) {
    const raw = readUtf8IfFile(join(cwd, rel));
    if (raw == null) continue;
    const parsed = parseRuleFile(raw, rel);
    out.push(toRuleSource("local", parsed, { id: `local:${rel}`, path: rel }));
  }
  const machine = localMachineRulesPath(cwd);
  const rawM = readUtf8IfFile(machine);
  if (rawM != null) {
    const rel = `~/.chavez/workspaces/${workspaceHash(cwd)}/rules.local.md`;
    const parsed = parseRuleFile(rawM, rel);
    out.push(
      toRuleSource("local", parsed, { id: "local:machine", path: rel }),
    );
  }
  return out;
}

export function writeLocalMachineRules(cwd: string, content: string): string {
  const abs = localMachineRulesPath(cwd);
  mkdirSync(join(abs, ".."), { recursive: true });
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(abs, content, { encoding: "utf8", mode: 0o600 });
  return abs;
}
```

Usar `import { writeFileSync } from "node:fs"` arriba (no `require`). Ajustar `writeLocalMachineRules` para el import estático.

El loader de `.chavez/rules.local.md` **sí** lee ese path aunque plan 8 lo clasifique vault: es el host, no una tool. Las tools del LLM siguen denegadas por vault.

- [ ] Crear `cli/src/llm/rules-git-exclude.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITEXCLUDE_LINES, localRuleCommitDenied } from "./rules-constants";

export function isLocalRuleRelPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (n === "CHAVEZ.local.md" || n === "CLAUDE.local.md") return true;
  if (n === ".chavez/rules.local.md") return true;
  if (n === ".chavez" || n.startsWith(".chavez/")) return true;
  return false;
}

export function gitExcludePath(cwd: string): string {
  return join(cwd, ".git", "info", "exclude");
}

/** No-op if cwd is not a git repo. Never writes .gitignore (that would be a commit). */
export function ensureLocalRulesGitExcluded(cwd: string): void {
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) return;
  const infoDir = join(gitDir, "info");
  mkdirSync(infoDir, { recursive: true });
  const file = gitExcludePath(cwd);
  let existing = "";
  try {
    existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    existing = "";
  }
  const have = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const missing = GITEXCLUDE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return;
  const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
  const block = `${prefix}# Chavez local rules (do not commit)\n${missing.join("\n")}\n`;
  writeFileSync(file, existing + block, "utf8");
}

export function localRuleCommitBlockedReason(relPath: string): string | null {
  if (!isLocalRuleRelPath(relPath)) return null;
  return localRuleCommitDenied(relPath.replace(/\\/g, "/"));
}
```

Importar `localRuleCommitDenied` desde `rules-constants.ts` (ya exportada como función).

- [ ] Tests `cli/src/llm/rules-load.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalRules, loadProjectRules } from "./rules-load";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "chavez-rules-")));
}

describe("loadProjectRules", () => {
  test("missing AGENTS.md returns [] and does not throw", () => {
    const cwd = tmp();
    expect(loadProjectRules(cwd)).toEqual([]);
  });

  test("loads AGENTS.md and CLAUDE.md and cursor rules", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nuse bun\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "# Claude\nno force push\n");
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(
      join(cwd, ".cursor", "rules", "ts.mdc"),
      "---\nglob: src/**/*.ts\nalwaysApply: true\n---\n# TS\nprefer type imports\n",
    );
    const rules = loadProjectRules(cwd);
    const titles = rules.map((r) => r.title);
    expect(titles).toContain("Agents");
    expect(titles).toContain("Claude");
    expect(rules.some((r) => r.path === ".cursor/rules/ts.mdc")).toBe(true);
    expect(rules.every((r) => r.layer === "project")).toBe(true);
  });

  test("CLAUDE.local.md is NOT project", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.local.md"), "local only\n");
    writeFileSync(join(cwd, "AGENTS.md"), "proj\n");
    const project = loadProjectRules(cwd);
    expect(project.some((r) => r.path === "CLAUDE.local.md")).toBe(false);
  });
});

describe("loadLocalRules", () => {
  test("loads CHAVEZ.local.md", () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, "CHAVEZ.local.md"),
      "---\ndisallowTools: [bash]\n---\nno uses bash\n",
    );
    const local = loadLocalRules(cwd);
    expect(local).toHaveLength(1);
    expect(local[0]!.layer).toBe("local");
    expect(local[0]!.disallowTools).toEqual(["bash"]);
  });
});
```

- [ ] Tests `cli/src/llm/rules-git-exclude.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLocalRulesGitExcluded,
  isLocalRuleRelPath,
  localRuleCommitBlockedReason,
} from "./rules-git-exclude";

describe("isLocalRuleRelPath", () => {
  test("matches local files only", () => {
    expect(isLocalRuleRelPath("CHAVEZ.local.md")).toBe(true);
    expect(isLocalRuleRelPath("CLAUDE.local.md")).toBe(true);
    expect(isLocalRuleRelPath(".chavez/rules.local.md")).toBe(true);
    expect(isLocalRuleRelPath("AGENTS.md")).toBe(false);
    expect(isLocalRuleRelPath("CLAUDE.md")).toBe(false);
    expect(isLocalRuleRelPath("src/a.ts")).toBe(false);
  });
});

describe("ensureLocalRulesGitExcluded", () => {
  test("no-op without .git", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-nogit-")));
    expect(() => ensureLocalRulesGitExcluded(cwd)).not.toThrow();
  });

  test("appends to .git/info/exclude once", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-gitex-")));
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(join(cwd, ".git", "info", "exclude"), "# pre\n");
    ensureLocalRulesGitExcluded(cwd);
    ensureLocalRulesGitExcluded(cwd);
    const text = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(text).toContain("CHAVEZ.local.md");
    expect(text).toContain("CLAUDE.local.md");
    expect(text).toContain(".chavez/");
    expect(text.match(/CHAVEZ\.local\.md/g)?.length).toBe(1);
  });
});

describe("localRuleCommitBlockedReason", () => {
  test("blocks local, allows AGENTS.md", () => {
    expect(localRuleCommitBlockedReason("CHAVEZ.local.md")).toMatch(
      /local rule file/,
    );
    expect(localRuleCommitBlockedReason("AGENTS.md")).toBeNull();
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/rules-load.test.ts src/llm/rules-git-exclude.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/rules-load.ts cli/src/llm/rules-git-exclude.ts \
  cli/src/llm/rules-load.test.ts cli/src/llm/rules-git-exclude.test.ts
git commit -m "feat(rules): load AGENTS/native files and gitexclude local rules"
```

---

## Task 3: API — `user_rules`, toggle por workspace, HTTP

**Files:**

- Create: `api/src/llm/rules-constants.ts`
- Test: `api/src/llm/rules-constants.test.ts`
- Create: `api/src/routes/rules.ts`
- Create: `api/drizzle/0009_project_rules.sql`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API es la fuente de verdad de la capa **usuario**. Proyecto/local no se guardan aquí.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta.

- [ ] Crear `api/src/llm/rules-constants.ts` copiando `CANONICAL_DISALLOW_TOOLS`, `USER_RULES_MAX`, `USER_RULE_TITLE_MAX`, `USER_RULE_BODY_MAX`, los cuatro `*_ERROR` y `isCanonicalDisallowTool` / `parseCanonicalToolList` (no importar `cli/`).

- [ ] Test: reject `laser`, accept `bash`, cap 50, title vacío → error.

- [ ] En `api/src/db/schema.ts` añadir tabla y columna:

```ts
export const userRules = pgTable(
  "user_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    disallowTools: jsonb("disallow_tools").$type<string[]>().notNull().default([]),
    allowTools: jsonb("allow_tools").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_rules_user_id_id_uidx").on(table.userId, table.id)],
);
```

En `workspaces` añadir:

```ts
userRulesEnabled: boolean("user_rules_enabled").notNull().default(true),
```

No tocar el unique `(userId, path)`.

- [ ] Crear `api/drizzle/0009_project_rules.sql`:

```sql
CREATE TABLE IF NOT EXISTS "user_rules" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "disallow_tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "allow_tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_rules_user_id_id_uidx"
  ON "user_rules" ("user_id", "id");

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "user_rules_enabled" boolean NOT NULL DEFAULT true;
```

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

Si `DATABASE_URL` no está, fallar con el error de drizzle. No editar `docker-compose.yml`.

- [ ] Crear `api/src/routes/rules.ts`:

```ts
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userRules } from "../db/schema";
import { hub } from "../ws/hub";
import type { Session } from "../auth";
import {
  INVALID_DISALLOW_ERROR,
  USER_RULES_CAP_ERROR,
  USER_RULES_MAX,
  USER_RULE_BODY_ERROR,
  USER_RULE_BODY_MAX,
  USER_RULE_TITLE_ERROR,
  USER_RULE_TITLE_MAX,
  parseCanonicalToolList,
} from "../llm/rules-constants";

function publicRule(row: typeof userRules.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    enabled: row.enabled,
    disallowTools: row.disallowTools ?? [],
    allowTools: row.allowTools ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseBodyFields(body: {
  title?: unknown;
  body?: unknown;
  enabled?: unknown;
  disallowTools?: unknown;
  allowTools?: unknown;
}, opts: { partial: boolean }) {
  const out: {
    title?: string;
    body?: string;
    enabled?: boolean;
    disallowTools?: string[];
    allowTools?: string[];
  } = {};
  if (body.title !== undefined || !opts.partial) {
    const title = String(body.title ?? "").trim();
    if (title.length < 1 || title.length > USER_RULE_TITLE_MAX) {
      throw new Error(USER_RULE_TITLE_ERROR);
    }
    out.title = title;
  }
  if (body.body !== undefined || !opts.partial) {
    const text = String(body.body ?? "");
    if (text.length < 1 || text.length > USER_RULE_BODY_MAX) {
      throw new Error(USER_RULE_BODY_ERROR);
    }
    out.body = text;
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  if (body.disallowTools !== undefined) {
    const list = parseCanonicalToolList(body.disallowTools);
    if (list == null) throw new Error(INVALID_DISALLOW_ERROR);
    out.disallowTools = list;
  }
  if (body.allowTools !== undefined) {
    const list = parseCanonicalToolList(body.allowTools);
    if (list == null) throw new Error(INVALID_DISALLOW_ERROR);
    out.allowTools = list;
  }
  return out;
}

export function createRuleRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rows = await db
      .select()
      .from(userRules)
      .where(eq(userRules.userId, session.user.id));
    return c.json({ rules: rows.map(publicRule) });
  });

  app.post("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const json = await c.req.json().catch(() => ({}));
    let fields;
    try {
      fields = parseBodyFields(json, { partial: false });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const existing = await db
      .select({ id: userRules.id })
      .from(userRules)
      .where(eq(userRules.userId, session.user.id));
    if (existing.length >= USER_RULES_MAX) {
      return c.json({ error: USER_RULES_CAP_ERROR }, 400);
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      title: fields.title!,
      body: fields.body!,
      enabled: fields.enabled ?? true,
      disallowTools: fields.disallowTools ?? [],
      allowTools: fields.allowTools ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userRules).values(row);
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("rules.updated", { rules: [publicRule(row)], op: "create" }),
    );
    return c.json({ rule: publicRule(row) }, 201);
  });

  app.put("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const json = await c.req.json().catch(() => ({}));
    let fields;
    try {
      fields = parseBodyFields(json, { partial: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const found = await db
      .select()
      .from(userRules)
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Rule not found" }, 404);
    const now = new Date();
    await db
      .update(userRules)
      .set({ ...fields, updatedAt: now })
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)));
    const updated = { ...found[0], ...fields, updatedAt: now };
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("rules.updated", { rules: [publicRule(updated)], op: "update" }),
    );
    return c.json({ rule: publicRule(updated) });
  });

  app.delete("/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const id = c.req.param("id");
    const found = await db
      .select()
      .from(userRules)
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)))
      .limit(1);
    if (!found[0]) return c.json({ error: "Rule not found" }, 404);
    await db
      .delete(userRules)
      .where(and(eq(userRules.id, id), eq(userRules.userId, session.user.id)));
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("rules.updated", { id, op: "delete" }),
    );
    return c.json({ ok: true });
  });

  return app;
}
```

Un usuario **no** ve ni edita las reglas de otro (`eq(userId)` en todos los queries). 401 sin sesión.

- [ ] En `api/src/index.ts`:

  1. `app.use("/rules", corsMiddleware);` y `app.use("/rules/*", corsMiddleware);`
  2. `app.route("/rules", createRuleRoutes(requireSession));`

- [ ] En `api/src/routes/workspaces.ts`:

  1. GET `/` ya hace spread de rows: el nuevo `userRulesEnabled` sale solo. Mapear explícitamente si el GET construye un objeto a mano: incluir `userRulesEnabled: w.userRulesEnabled !== false`.
  2. Añadir:

```ts
app.put("/:workspaceId/preferences", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const workspaceId = c.req.param("workspaceId");
  const body = await c.req.json<{ userRulesEnabled?: boolean }>().catch(() => ({}));
  if (typeof body.userRulesEnabled !== "boolean") {
    return c.json({ error: "userRulesEnabled must be boolean" }, 400);
  }
  const ws = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.userId, session.user.id),
      ),
    )
    .limit(1);
  if (!ws[0]) return c.json({ error: "Workspace not found" }, 404);
  await db
    .update(workspaces)
    .set({ userRulesEnabled: body.userRulesEnabled, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  hub.broadcastToUser(
    session.user.id,
    hub.pushEvent("workspace.prefs.updated", {
      workspaceId,
      userRulesEnabled: body.userRulesEnabled,
    }),
  );
  return c.json({
    workspaceId,
    userRulesEnabled: body.userRulesEnabled,
  });
});
```

Declarar esta ruta **antes** de `GET /:workspaceId/sessions` si el router pudiera capturar `preferences` como id; el path es `/:workspaceId/preferences` — no choca con `/:workspaceId/sessions`.

- [ ] En `api/src/ws/handlers.ts` caso `agent.turn.request`, **después** de resolver `workspace` y **antes** de `hub.sendTo`:

```ts
import { userRules } from "../db/schema";

const userRuleRows =
  workspace?.userRulesEnabled === false
    ? []
    : await db
        .select()
        .from(userRules)
        .where(eq(userRules.userId, userId));

hub.sendTo(
  daemon.connectionId,
  hub.pushEvent("agent.turn.dispatch", {
    chatId: msg.chatId,
    prompt: msg.prompt.trim(),
    requestId: id,
    workspaceId: ctx.workspaceId,
    path: workspace?.path || daemon.path,
    sessionId: ctx.session.id,
    requesterConnectionId: connectionId,
    userRulesEnabled: workspace?.userRulesEnabled !== false,
    userRules: userRuleRows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      enabled: r.enabled,
      disallowTools: r.disallowTools ?? [],
      allowTools: r.allowTools ?? [],
    })),
  }),
);
```

El daemon **no** relee `/rules` por su cuenta para el turn: usa el stamp del dispatch (misma regla que `executionMode` en plan 3).

- [ ] Extender `api/src/ws/protocol.ts` `ClientMessage` con campos opcionales usados por Task 7 (`action?: string`, `payload?: Record<string, unknown>`). Si ya existen por attach-files/git, no duplicar.

- [ ] OpenAPI: tag `Rules`; documentar GET/POST/PUT/DELETE `/rules` y PUT `/workspaces/{workspaceId}/preferences`. Schema `UserRule`.

- [ ] Correr:

```bash
cd api && bun test src/llm/rules-constants.test.ts
```

- [ ] Commit:

```bash
git add api/src/llm/rules-constants.ts api/src/llm/rules-constants.test.ts \
  api/src/routes/rules.ts api/src/db/schema.ts api/drizzle/0009_project_rules.sql \
  api/src/routes/workspaces.ts api/src/index.ts api/src/ws/handlers.ts \
  api/src/ws/protocol.ts api/openapi/openapi.yaml api/package.json
git commit -m "feat(rules): persist user rules and per-workspace disable toggle"
```

---

## Task 4: Inyección en el turn — `appendSystemPrompt` + metadata

**Files:**

- Create: `cli/src/llm/rules-inject.ts`
- Test: `cli/src/llm/rules-inject.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx` (solo el dispatch: pasar `userRules` del push; el overlay es Task 9)

`settingSources: []` **se mantiene**. No persistir un `chat.append` `role=system` con el texto de las reglas.

- [ ] Crear `cli/src/llm/rules-inject.ts`:

```ts
import { parseRuleFile, toRuleSource } from "./rules-parse";
import {
  assembleBundle,
  formatRulesPrompt,
  rulesMetadata,
  type RuleSource,
  type RulesBundle,
  type RulesMetadata,
} from "./rules-merge";
import { loadLocalRules, loadProjectRules } from "./rules-load";
import { ensureLocalRulesGitExcluded } from "./rules-git-exclude";
import type { CanonicalDisallowTool } from "./rules-constants";

export type DispatchUserRule = {
  id: string;
  title: string;
  body: string;
  enabled?: boolean;
  disallowTools?: string[];
  allowTools?: string[];
};

export function userRulesFromDispatch(
  rows: DispatchUserRule[] | undefined,
): RuleSource[] {
  if (!rows?.length) return [];
  return rows.map((r) => {
    const parsed = parseRuleFile(
      r.body.startsWith("---") ? r.body : `---\ntitle: ${r.title}\n---\n${r.body}`,
      r.title,
    );
    return toRuleSource("user", parsed, {
      id: r.id,
      enabled: r.enabled !== false,
    });
  }).map((src, i) => ({
    ...src,
    title: rows[i]!.title || src.title,
    disallowTools: (rows[i]!.disallowTools as CanonicalDisallowTool[]) ?? src.disallowTools,
    allowTools: (rows[i]!.allowTools as CanonicalDisallowTool[]) ?? src.allowTools,
  }));
}

export function loadTurnRules(input: {
  cwd: string;
  userRules?: DispatchUserRule[];
  userRulesEnabled?: boolean;
}): { bundle: RulesBundle; metadata: RulesMetadata; appendSystemPrompt?: string } {
  try {
    ensureLocalRulesGitExcluded(input.cwd);
  } catch {
    // exclude is best-effort; never fail the turn
  }
  let project: RuleSource[] = [];
  let local: RuleSource[] = [];
  try {
    project = loadProjectRules(input.cwd);
  } catch {
    project = [];
  }
  try {
    local = loadLocalRules(input.cwd);
  } catch {
    local = [];
  }
  const bundle = assembleBundle({
    user: userRulesFromDispatch(input.userRules),
    project,
    local,
    userRulesEnabled: input.userRulesEnabled !== false,
  });
  return {
    bundle,
    metadata: rulesMetadata(bundle),
    appendSystemPrompt: formatRulesPrompt(bundle),
  };
}

export function applyRulesToClaudeOptions(
  options: Record<string, unknown>,
  append: string | undefined,
): Record<string, unknown> {
  const next = { ...options, settingSources: [] as string[] };
  if (append) next.appendSystemPrompt = append;
  return next;
}

/** Cursor SDK replaces systemPrompt wholesale — prepend a block to the user prompt instead. */
export function applyRulesToCursorPrompt(
  prompt: string,
  append: string | undefined,
): string {
  if (!append) return prompt;
  return `${append}\n\n---\n\n${prompt}`;
}
```

- [ ] Test `rules-inject.test.ts`: cwd vacío → `appendSystemPrompt` undefined, `counts.total === 0`, no throw. Cwd con AGENTS + user rule → prompt contiene ambos. `userRulesEnabled: false` omite la de usuario. `applyRulesToClaudeOptions` siempre deja `settingSources: []`.

- [ ] Ampliar `RunClaudeTurnInput` en `cli/src/llm/claude-runner.ts`:

```ts
appendSystemPrompt?: string;
rulesBundle?: import("./rules-merge").RulesBundle;
```

En las options de `query`:

```ts
const options: Record<string, unknown> = applyRulesToClaudeOptions(
  {
    model: input.model,
    cwd: input.cwd,
    env: cleanEnv,
    settingSources: [],
    permissionMode: /* existing: "default" if plan 2/3 landed, else keep current and do NOT add bypassPermissions back */,
  },
  input.appendSystemPrompt,
);
```

Si plan 2 ya puso `tools` / `canUseTool` / `permissionMode: "default"`, **dejarlos**. Solo añadir `appendSystemPrompt` cuando hay texto.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Ampliar input con `userRules?: DispatchUserRule[]` y `userRulesEnabled?: boolean`.
  2. **Antes** de `runClaudeTurn`, `const loaded = loadTurnRules({ cwd, userRules: input.userRules, userRulesEnabled: input.userRulesEnabled })`.
  3. Pasar `appendSystemPrompt: loaded.appendSystemPrompt` y `rulesBundle: loaded.bundle` al runner.
  4. En `chat.stream.end`, enviar `metadata: { rules: loaded.metadata }`. El handler de API ya hace `...(msg.metadata || {})` sobre el assistant.

```ts
await client.request(
  {
    type: "chat.stream.end",
    chatId,
    streamId,
    content: result,
    metadata: { rules: loaded.metadata },
  },
  60_000,
);
```

Si el turn falla antes de llamar al LLM (provider no runnable), **no** exigir metadata de reglas.

- [ ] En `cli/src/ws/daemon.ts`, el payload de `agent.turn.dispatch` ahora trae `userRules` y `userRulesEnabled`. Pasarlos a `publishAgentTurn`. Llamar `ensureLocalRulesGitExcluded(path)` una vez al arrancar el daemon (después del bind), swallow errors.

- [ ] En `tui/src/App.tsx`, el `onPush` de `agent.turn.dispatch` y `sendWithLlm` pasan `userRules` / `userRulesEnabled` del push (dispatch) o, para el compose local, GET `/rules` + el flag del workspace (Task 9 los cachea; aquí si aún no hay state, GET `/rules` en `sendWithLlm` y default `userRulesEnabled: true`).

Para el compose local de TUI en esta task, añadir al efecto de providers un GET `/rules` guardado en state `userRules` (array) y pasarlos a `publishAgentTurn`. El toggle por workspace llega en Task 9; default `true`.

- [ ] Si `cli/src/llm/cursor-runner.ts` ya existe (plan 4), pasar `prompt: applyRulesToCursorPrompt(prompt, loaded.appendSystemPrompt)` y el mismo `metadata.rules`. Si **no** existe, no crearlo.

- [ ] Commit:

```bash
git add cli/src/llm/rules-inject.ts cli/src/llm/rules-inject.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/claude-runner.ts \
  cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(rules): inject three layers via appendSystemPrompt and stamp metadata"
```

---

## Task 5: Gate duro — `disallowTools` además del modo

**Files:**

- Modify: `cli/src/llm/claude-runner.ts` (o `cli/src/llm/can-use-tool.ts` / `cli/src/llm/execution-gate.ts` si plan 3 los creó)
- Test: `cli/src/llm/rules-gate.test.ts`

El modo `auto` **permite** bash (plan 3). Una regla local que lo desautoriza **deniega** igual. Orden del `canUseTool` (si un paso ya denegó, no seguir):

1. `denyIfEscapes` (plan 2)
2. `denyIfIgnored` (plan 8, si existe)
3. `gateGitTool` (plan 7, si existe)
4. **`denyIfRuleDisallowed(bundle, canonicalToolName)`**
5. `gateMutation(mode)` (plan 3)

Mapear SDK → canónico con `canonicalToolName` de `cli/src/llm/tool-names.ts` si existe; si no:

```ts
function canonicalForRules(sdkName: string): string {
  const n = sdkName.toLowerCase();
  if (n === "shell" || n === "bash") return "bash";
  if (n === "notebookedit") return "edit";
  if (n === "ls") return "glob";
  if (n.startsWith("mcp__chavez-git__")) return n.slice("mcp__chavez-git__".length);
  return n;
}
```

- [ ] En el callback `canUseTool` (inline o `decideCanUseTool`), **después** de sandbox/ignore/git y **antes** (o junto) al gate de modo:

```ts
if (input.rulesBundle) {
  const denied = denyIfRuleDisallowed(
    input.rulesBundle,
    canonicalForRules(toolName),
  );
  if (denied) return denied;
}
```

Pasar `rulesBundle` en `RunClaudeTurnInput` (Task 4). Si el bundle es undefined, no-op.

Lecturas: una regla **puede** listar `read` en `disallowTools` (explícito). Sin frontmatter, el texto “no uses bash” **no** es un deny duro — el escenario Gherkin se cubre con frontmatter `disallowTools: [bash]` en el archivo local (Task 2/11). El modelo igual ve el texto.

- [ ] Crear `cli/src/llm/rules-gate.test.ts` que prueba `denyIfRuleDisallowed` + el orden mental: bundle con bash disallow + `canonicalForRules("Bash")` → deny; `"Read"` → null. No hace falta mockear el SDK.

Si `decideCanUseTool` existe, añadir un test en `cli/src/llm/can-use-tool.test.ts` (o el de execution-gate): mode `auto` + bundle local bash-disallow + tool `Bash` → `{ behavior: "deny", message: /disallowed/ }`. El archivo **no** se “escribe”: el test no toca disco.

- [ ] Correr:

```bash
cd cli && bun test src/llm/rules-gate.test.ts src/llm/rules-merge.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/claude-runner.ts cli/src/llm/can-use-tool.ts \
  cli/src/llm/execution-gate.ts cli/src/llm/rules-gate.test.ts \
  cli/src/llm/can-use-tool.test.ts
git commit -m "feat(rules): deny disallowed tools even when execution mode is auto"
```

Añadir al `git add` solo los archivos que existan / hayas modificado.

---

## Task 6: Git no commitea reglas locales

**Files:**

- Modify: `cli/src/llm/git-secret-guard.ts` (si plan 8/7 lo creó; si no, crear con el API de abajo)
- Test: `cli/src/llm/git-secret-guard.test.ts` (extender) o `cli/src/llm/rules-git-exclude.test.ts`
- Modify: `cli/src/llm/git-commit.ts` / MCP git (solo si ya existe `assertCommitPathsAllowed` — no implementar git)

- [ ] Si `cli/src/llm/git-secret-guard.ts` existe, al inicio de `gitCommitBlockedReason`:

```ts
import { localRuleCommitBlockedReason } from "./rules-git-exclude";

export function gitCommitBlockedReason(
  cwd: string,
  relPath: string,
  set?: IgnoreSet,
): string | null {
  const local = localRuleCommitBlockedReason(relPath);
  if (local) return local;
  // … resto vault/secret existente …
}
```

El string de vault (`.chavez/config.json`) puede seguir siendo `Refusing to commit secret path: …`. El de `CHAVEZ.local.md` es `Refusing to commit local rule file: CHAVEZ.local.md`. Ambos bloquean el commit.

- [ ] Si `git-secret-guard.ts` **no** existe, crear uno mínimo:

```ts
import { localRuleCommitBlockedReason } from "./rules-git-exclude";

export function gitCommitBlockedReason(
  _cwd: string,
  relPath: string,
): string | null {
  return localRuleCommitBlockedReason(relPath);
}

export function assertCommitPathsAllowed(cwd: string, paths: string[]): void {
  const blocked = paths
    .map((p) => gitCommitBlockedReason(cwd, p))
    .filter((x): x is string => Boolean(x));
  if (blocked.length) throw new Error(blocked.join("; "));
}
```

Cuando plan 8 aterrice, **su** cuerpo se fusiona: llamar `localRuleCommitBlockedReason` **primero**.

- [ ] Test: `assertCommitPathsAllowed(cwd, ["CHAVEZ.local.md"])` throw; `["AGENTS.md"]` no throw; `["CLAUDE.local.md"]` throw; `["src/a.ts"]` no.

- [ ] `ensureLocalRulesGitExcluded` ya se llama al abrir daemon (Task 4). Un `git add CHAVEZ.local.md` sin `-f` no lo ve (exclude). Con `-f`, la guarda del commit lo rechaza.

- [ ] Correr:

```bash
cd cli && bun test src/llm/rules-git-exclude.test.ts src/llm/git-secret-guard.test.ts
```

Si el segundo archivo no existe, solo el primero.

- [ ] Commit:

```bash
git add cli/src/llm/git-secret-guard.ts cli/src/llm/git-secret-guard.test.ts \
  cli/src/llm/rules-git-exclude.ts
git commit -m "feat(rules): keep local rule files out of git commit and PR"
```

---

## Task 7: RPC Web — snapshot de proyecto/local y edición local

**Files:**

- Modify: `api/src/ws/pending.ts` (crear idéntico a attach-files Task 3 si no existe)
- Test: `api/src/ws/pending.test.ts` (solo si lo creas aquí)
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/ws/client.ts` (`WsRequest` campos `action?`, `payload?`)
- Test: `cli/src/llm/rules-snapshot.test.ts`

Web no lee el cwd. TUI/CLI en la máquina del workspace **pueden** leer directo; este RPC es para la consola Web (y para que TUI se sincronice si otro cliente escribe).

- [ ] Si `api/src/ws/pending.ts` no existe, copiar `createPendingMap` de attach-files (timeout usa `NO_DAEMON_ERROR`). Declarar en handlers:

```ts
const rulesPending = createPendingMap(5_000);
```

No reusar el mapa de `fs.complete` si su timeout es distinto; 5s coincide, así que **se puede** reusar el mismo mapa (`fsPending`) porque los `id` de request no colisionan. Preferir un mapa `rulesPending` dedicado para no acoplar.

- [ ] En `handlers.ts` añadir casos:

```ts
case "workspace.rules.snapshot":
case "workspace.rules.local.set": {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const action =
    type === "workspace.rules.local.set" ? "local.set" : "snapshot";
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.rules.dispatch", {
      requestId: id,
      action,
      path: daemon.path,
      payload: msg.payload ?? { content: msg.content },
      workspaceId,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return await rulesPending.wait(id, type);
}

case "workspace.rules.result": {
  const data = (msg as ClientMessage & { data?: unknown }).data
    ?? msg.metadata
    ?? {};
  const requestId = String(
    (data as { requestId?: string }).requestId || msg.id,
  );
  const okFlag = (msg as { ok?: boolean }).ok !== false && msg.status !== "error";
  const reply = okFlag
    ? ok("workspace.rules.result", requestId, data)
    : fail(
        "workspace.rules.result",
        requestId,
        String((data as { error?: string }).error || msg.content || "rules rpc failed"),
      );
  if (!rulesPending.complete(requestId, reply)) {
    return fail(type, id, "No pending rules request");
  }
  const snap = (data as { snapshot?: unknown }).snapshot;
  if (okFlag && snap) {
    const conn = hub.get(connectionId);
    broadcast(userId, "workspace.rules.changed", {
      workspaceId: conn?.workspaceId,
      snapshot: snap,
    });
  }
  return ok(type, id, { completed: true });
}
```

Ajustar el shape al estilo de attach-files `fs.result` si ese patrón ya aterrizó: **mismo** `requestId` / `complete`. No inventar un tercer protocolo.

- [ ] En `cli/src/ws/daemon.ts`, el `onPush` debe atender `workspace.rules.dispatch` **sin** exigir `turnBusy` (lectura/escritura de reglas no es un turn). Si `turnBusy`, snapshot **sí** se sirve; `local.set` también (archivo máquina fuera del cwd git).

```ts
if (msg.type === "workspace.rules.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    action?: string;
    path?: string;
    payload?: { content?: string };
    workspaceId?: string;
  };
  const cwd = data.path || path;
  try {
    ensureLocalRulesGitExcluded(cwd);
    if (data.action === "local.set") {
      writeLocalMachineRules(cwd, String(data.payload?.content ?? ""));
    }
    const project = loadProjectRules(cwd).map(toRuleRef);
    const local = loadLocalRules(cwd).map(toRuleRef);
    const machine = localMachineRulesPath(cwd);
    let localContent = "";
    try {
      localContent = existsSync(machine) ? readFileSync(machine, "utf8") : "";
    } catch {
      localContent = "";
    }
    const snapshot = {
      project,
      local,
      localContent,
      localPath: `~/.chavez/workspaces/${workspaceHash(cwd)}/rules.local.md`,
    };
    await client.request({
      type: "workspace.rules.result",
      metadata: {
        requestId: data.requestId,
        snapshot,
      },
    });
  } catch (err) {
    await client.request({
      type: "workspace.rules.result",
      status: "error",
      metadata: {
        requestId: data.requestId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  return;
}
```

Importar `toRuleRef` desde `rules-merge.ts`. El `localContent` es el archivo **máquina** (el que edita la UI), no la concatenación de CLAUDE.local.md.

- [ ] Test unitario `rules-snapshot.test.ts`: `loadProjectRules` + `toRuleRef` no incluye `body`. `writeLocalMachineRules` + `loadLocalRules` ve la regla.

- [ ] Commit:

```bash
git add api/src/ws/pending.ts api/src/ws/pending.test.ts \
  api/src/ws/handlers.ts api/src/ws/protocol.ts \
  cli/src/ws/daemon.ts cli/src/ws/client.ts \
  cli/src/llm/rules-snapshot.test.ts
git commit -m "feat(rules): daemon RPC for project snapshot and local rule edits"
```

---

## Task 8: CLI — `chavez rules` y `headless rules`

**Files:**

- Create: `cli/src/commands/rules.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/commands/headless.ts`

Capa usuario **no** necesita daemon. Proyecto/local usan el cwd (misma máquina).

- [ ] Crear `cli/src/commands/rules.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

export async function rulesCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const data = await apiFetch<{ rules: unknown[] }>("/rules", {}, token());
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "add") {
    const title = rest[0];
    const body = rest.slice(1).join(" ");
    if (!title || !body) {
      throw new Error('Uso: chavez rules add <title> <body…>');
    }
    const data = await apiFetch(
      "/rules",
      { method: "POST", body: JSON.stringify({ title, body, enabled: true }) },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "disable" || action === "enable") {
    const id = rest[0];
    if (!id) throw new Error(`Uso: chavez rules ${action} <id>`);
    const data = await apiFetch(
      `/rules/${id}`,
      { method: "PUT", body: JSON.stringify({ enabled: action === "enable" }) },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "rm") {
    const id = rest[0];
    if (!id) throw new Error("Uso: chavez rules rm <id>");
    const data = await apiFetch(`/rules/${id}`, { method: "DELETE" }, token());
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("Uso: chavez rules list|add|enable|disable|rm");
}
```

- [ ] En `cli/src/index.ts` añadir `case "rules": await rulesCommand(rest);` y en `usage()`:

```
  chavez rules list|add|enable|disable|rm
  chavez headless rules project|local|workspace
```

- [ ] En `cli/src/commands/headless.ts`, grupo `rules`:

```ts
if (group === "rules") {
  const cwd = cwdPath();
  if (action === "project") {
    const rows = loadProjectRules(cwd).map(toRuleRef);
    console.log(JSON.stringify({ project: rows }, null, 2));
    return;
  }
  if (action === "local") {
    const sub = rest[0] || "get";
    if (sub === "get") {
      const rows = loadLocalRules(cwd).map(toRuleRef);
      const machine = localMachineRulesPath(cwd);
      const content = existsSync(machine) ? readFileSync(machine, "utf8") : "";
      console.log(JSON.stringify({ local: rows, content }, null, 2));
      return;
    }
    if (sub === "set") {
      const content = rest.slice(1).join(" ") || await Bun.stdin.text();
      writeLocalMachineRules(cwd, content);
      ensureLocalRulesGitExcluded(cwd);
      console.log("local rules written");
      return;
    }
    throw new Error("Uso: chavez headless rules local get|set [content]");
  }
  if (action === "workspace") {
    const flag = rest[0];
    const st = readWorkspaceState(cwd);
    if (!st?.workspaceId) {
      throw new Error("Workspace no abierto. chavez headless workspace open");
    }
    if (flag !== "on" && flag !== "off") {
      throw new Error("Uso: chavez headless rules workspace on|off");
    }
    const data = await apiFetch(
      `/workspaces/${st.workspaceId}/preferences`,
      {
        method: "PUT",
        body: JSON.stringify({ userRulesEnabled: flag === "on" }),
      },
      requireAuth(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("Uso: chavez headless rules project|local|workspace");
}
```

Actualizar el error de grupo desconocido para incluir `rules`.

- [ ] En `chat watch` (`headless.ts` `onPush`): si `msg.type === "chat.stream.end"`, leer `data.message.metadata.rules` y `console.error(rulesWatchLine(meta))` además del JSON. Importar `rulesWatchLine`. Si no hay `metadata.rules`, no imprimir error.

- [ ] Commit:

```bash
git add cli/src/commands/rules.ts cli/src/index.ts cli/src/commands/headless.ts
git commit -m "feat(rules): CLI user CRUD and headless project/local commands"
```

---

## Task 9: TUI — tecla `r`, chip en el assistant, toggle por workspace

**Files:**

- Modify: `tui/src/App.tsx`

- [ ] Ampliar `type Message` con `metadata?: Record<string, unknown>`.

- [ ] State nuevo:

```ts
const [rulesOverlay, setRulesOverlay] = useState(false);
const [userRules, setUserRules] = useState<UserRule[]>([]);
const [userRulesEnabled, setUserRulesEnabled] = useState(true);
const [projectRuleRefs, setProjectRuleRefs] = useState<RuleRef[]>([]);
const [localRuleRefs, setLocalRuleRefs] = useState<RuleRef[]>([]);
```

Tras bind, GET `/rules` y `loadProjectRules(cwd)` / `loadLocalRules(cwd)` (TUI **es** el daemon: lee disco directo). Guardar refs.

Escuchar push `rules.updated` y `workspace.prefs.updated` / `workspace.rules.changed` para refrescar.

- [ ] En `useInput`, **antes** de `q` / escape global:

  - Si `rulesOverlay` y `key.escape`: cerrar overlay, no exit.
  - Si `rulesOverlay` y `ch === "u"`: PUT `/workspaces/${workspaceId}/preferences` `{ userRulesEnabled: !userRulesEnabled }`, flip state, log `user rules → on|off`.
  - Si no overlay y `ch === "r"`: abrir overlay.

No interceptar `r` en modo compose (es texto).

- [ ] Overlay (cuando `rulesOverlay`): un `Box` extra:

```
Reglas  user=${n} project=${n} local=${n}  usuario en este workspace: on|off
[u] toggle usuario   [esc] cerrar
- user: {title} {enabled? ""}
- project: {title} ({path})
- local: {title} ({path})
```

Sin volcar bodies. Si un `truncated`, marcar `…`.

- [ ] En la lista de Messages, si `m.role === "assistant"` y `m.metadata?.rules`:

```ts
const rules = m.metadata.rules as RulesMetadata;
<Text dimColor>{rulesWatchLine(rules)}</Text>
```

Pintar esa línea **debajo** del preview de 100 chars.

- [ ] Help line: añadir `[r] reglas`.

- [ ] `sendWithLlm` / dispatch: pasar `userRules` (solo `enabled`) y `userRulesEnabled` a `publishAgentTurn`.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(rules): TUI overlay and per-turn rule counts"
```

---

## Task 10: Web — página `/rules`, panel de workspace, chip en el chat

**Files:**

- Create: `web/src/components/RulesPanel.tsx`
- Create: `web/src/pages/rules.astro`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/ws-hooks.ts`

Web **no** importa `cli/src`. Duplicar `rulesWatchLine` mínimo:

```ts
export function rulesWatchLine(counts: {
  user: number; project: number; local: number; total: number;
}): string {
  if (!counts.total) return "0 reglas";
  return `rules: ${counts.total} (user=${counts.user} project=${counts.project} local=${counts.local})`;
}
```

Ponerlo en `web/src/lib/rules-display.ts`.

- [ ] `queryKeys.userRules = ["userRules"]`, `queryKeys.workspaceRules = (id) => ["workspaceRules", id]`.

- [ ] Hooks en `hooks.ts`:

```ts
export function useUserRules(enabled = true) {
  return useQuery({
    queryKey: queryKeys.userRules,
    queryFn: () => apiJson<{ rules: UserRule[] }>("/rules"),
    enabled,
  });
}
export function useCreateUserRule() { /* POST /rules, invalidate userRules */ }
export function usePatchUserRule() { /* PUT /rules/:id */ }
export function useDeleteUserRule() { /* DELETE */ }
export function useWorkspaceUserRulesEnabled(workspaceId: string) {
  return useMutation({
    mutationFn: (userRulesEnabled: boolean) =>
      apiJson(`/workspaces/${workspaceId}/preferences`, {
        method: "PUT",
        body: JSON.stringify({ userRulesEnabled }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      void qc.invalidateQueries({ queryKey: queryKeys.workspaceSessions(workspaceId) });
    },
  });
}
```

Tipar `UserRule` como en Task 1 (sin importar CLI).

- [ ] `useWsRulesSnapshot` y `useWsRulesLocalSet` en `ws-hooks.ts` (request `workspace.rules.snapshot` / `workspace.rules.local.set` con `payload: { content }`).

- [ ] `RulesPanel.tsx` (página cuenta): lista títulos, body en `<textarea>` al editar **una** (no las 50 a la vez), checkbox enabled, input `disallowTools` (comma: `bash`). Botón crear. Sin daemon.

- [ ] `web/src/pages/rules.astro` igual que providers: `RulesPanel client:only="react"`.

- [ ] `HubPanel.tsx`: enlace `<a href="/rules">Reglas de usuario</a>` junto a providers.

- [ ] `WorkspaceDetailPanel.tsx`: sección “Reglas”:

  1. Checkbox “Aplicar reglas de usuario en este workspace” → PUT preferences.
  2. Lista proyecto/local vía snapshot RPC (tras `ensureBound`). Sin daemon: texto `"No daemon bound for this workspace. Run: chavez headless workspace open"` (mismo string).
  3. Textarea “Reglas locales (esta máquina)” bound a `localContent`; guardar → `workspace.rules.local.set`. Placeholder con frontmatter de ejemplo:

```
---
disallowTools: [bash]
---
No uses bash en este workspace.
```

Mostrar `hostname` no hace falta aquí (el bind ya es de este workspace). Sí mostrar `localPath` del snapshot.

- [ ] `ChatDetailPanel.tsx`: en mensajes `assistant`, si `metadata.rules`:

```tsx
const rules = (m.metadata as { rules?: RulesMetadata })?.rules;
{rules && (
  <details>
    <summary className="muted">{rulesWatchLine(rules.counts)}</summary>
    <ul>
      {rules.applied.map((r) => (
        <li key={`${r.layer}-${r.id ?? r.path ?? r.title}`}>
          <span className="badge">{r.layer}</span> {r.title}
          {r.path ? <code> {r.path}</code> : null}
          {r.truncated ? " …" : null}
        </li>
      ))}
    </ul>
  </details>
)}
```

**No** pintar `body`. Si el usuario abre el `<details>`, solo títulos/paths/capa.

Invalidar `queryKeys.chat` ya ocurre en `chat.stream.end`.

- [ ] Commit:

```bash
git add web/src/components/RulesPanel.tsx web/src/pages/rules.astro \
  web/src/components/WorkspaceDetailPanel.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/components/HubPanel.tsx web/src/lib/hooks.ts web/src/lib/query-keys.ts \
  web/src/lib/ws-hooks.ts web/src/lib/rules-display.ts
git commit -m "feat(rules): Web editor, workspace toggle, and timeline rule chip"
```

---

## Task 11: Smoke Gherkin — las siete cláusulas

**Files:**

- Create: `cli/scripts/rules-smoke.ts`
- Modify: `cli/package.json` (script opcional `"test:rules": "bun run scripts/rules-smoke.ts"`)

Cubre los siete escenarios con asserts concretos. La parte live (turn + Claude) se salta con exit 0 y un log si no hay token/daemon; los loaders y el merge **siempre** corren.

- [ ] Crear `cli/scripts/rules-smoke.ts`:

```ts
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBundle, denyIfRuleDisallowed, formatRulesPrompt, rulesMetadata } from "../src/llm/rules-merge";
import { loadLocalRules, loadProjectRules } from "../src/llm/rules-load";
import { parseRuleFile, toRuleSource } from "../src/llm/rules-parse";
import {
  ensureLocalRulesGitExcluded,
  localRuleCommitBlockedReason,
} from "../src/llm/rules-git-exclude";
import { loadTurnRules } from "../src/llm/rules-inject";

function assertCond(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-p9-")));

// Escenario: Sin archivos de reglas → no throw
{
  const empty = loadTurnRules({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "chavez-p9e-"))) });
  assert.equal(empty.metadata.counts.total, 0);
  assert.equal(empty.appendSystemPrompt, undefined);
  console.log("ok  missing AGENTS.md does not fail");
}

writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nuse bun test\n");
writeFileSync(join(cwd, "CLAUDE.md"), "# Claude native\nno force-push\n");
mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
writeFileSync(
  join(cwd, ".cursor", "rules", "ts.mdc"),
  "---\nalwaysApply: true\n---\n# Cursor TS\nprefer type imports\n",
);
writeFileSync(
  join(cwd, "CHAVEZ.local.md"),
  "---\ndisallowTools: [bash]\ntitle: No bash\n---\nno uses bash\n",
);

// Escenario: Proyecto carga AGENTS y nativos
{
  const project = loadProjectRules(cwd);
  const paths = project.map((r) => r.path);
  assertCond(paths.includes("AGENTS.md"), "AGENTS.md not loaded");
  assertCond(paths.includes("CLAUDE.md"), "CLAUDE.md not loaded");
  assertCond(paths.includes(".cursor/rules/ts.mdc"), "cursor native not loaded");
  assertCond(!paths.includes("CHAVEZ.local.md"), "local leaked into project");
  console.log("ok  project loads AGENTS + natives, not local");
}

// Escenario: Las tres capas se inyectan; local gana
{
  const user = [
    toRuleSource(
      "user",
      parseRuleFile("responde en español", "user"),
      { id: "u1", enabled: true },
    ),
  ];
  user[0]!.title = "español";
  const loaded = loadTurnRules({
    cwd,
    userRules: [
      {
        id: "u1",
        title: "español",
        body: "responde en español",
        enabled: true,
      },
    ],
    userRulesEnabled: true,
  });
  const text = loaded.appendSystemPrompt || "";
  assert.match(text, /responde en español/);
  assert.match(text, /use bun test/);
  assert.match(text, /no uses bash/);
  assert.match(text, /local overrides project/);
  assert.equal(loaded.bundle.disallowedTools.includes("bash"), true);
  // conflicto explícito: user allow bash, local disallow → local gana
  const conflict = assembleBundle({
    user: [
      toRuleSource("user", parseRuleFile("---\nallowTools: [bash]\n---\nok bash\n", "u"), {
        enabled: true,
      }),
    ],
    project: loadProjectRules(cwd),
    local: loadLocalRules(cwd),
    userRulesEnabled: true,
  });
  assert.equal(conflict.disallowedTools.includes("bash"), true);
  console.log("ok  three layers injected; local wins conflict");
}

// Escenario: Usuario sigue entre workspaces + se puede desactivar
{
  const other = loadTurnRules({
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "chavez-p9w-"))),
    userRules: [
      { id: "u1", title: "español", body: "responde en español", enabled: true },
    ],
    userRulesEnabled: true,
  });
  assert.match(other.appendSystemPrompt || "", /responde en español/);
  const disabled = loadTurnRules({
    cwd,
    userRules: [
      { id: "u1", title: "español", body: "responde en español", enabled: true },
    ],
    userRulesEnabled: false,
  });
  assert.doesNotMatch(disabled.appendSystemPrompt || "", /responde en español/);
  assert.match(disabled.appendSystemPrompt || "", /use bun test/);
  console.log("ok  user rules follow workspaces and can be disabled");
}

// Escenario: Visible títulos, no body enorme
{
  const meta = loadTurnRules({ cwd }).metadata;
  assert.ok(meta.counts.project >= 2);
  assert.ok(meta.counts.local >= 1);
  for (const a of meta.applied) {
    assert.ok(a.title);
    assert.equal("body" in a, false);
  }
  console.log("ok  metadata titles only");
}

// Escenario: Local no se sube a git
{
  mkdirSync(join(cwd, ".git", "info"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  ensureLocalRulesGitExcluded(cwd);
  const ex = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
  assert.match(ex, /CHAVEZ\.local\.md/);
  assert.match(ex, /CLAUDE\.local\.md/);
  assert.match(ex, /\.chavez\//);
  assert.ok(localRuleCommitBlockedReason("CHAVEZ.local.md"));
  assert.equal(localRuleCommitBlockedReason("AGENTS.md"), null);
  console.log("ok  local not commited");
}

// Escenario: Regla local no-bash + auto → deny
{
  const loaded = loadTurnRules({ cwd });
  const denied = denyIfRuleDisallowed(loaded.bundle, "bash");
  assert.equal(denied?.behavior, "deny");
  assert.match(denied?.message || "", /bash/);
  assert.equal(denyIfRuleDisallowed(loaded.bundle, "read"), null);
  console.log("ok  local bash disallow denies even when mode would allow");
}

console.log("rules smoke unit OK", cwd);
```

No llamar a Claude en el bloque unitario.

- [ ] Opcional live (después del unitario, mismo archivo): si `CHAVEZ_ACCESS_TOKEN` o `loadConfig().accessToken` existe, POST `/rules` `{ title: "español", body: "responde en español" }`, GET y assert, DELETE al final. Si 401, log `skip live HTTP` y **no** fallar. No exigir un turn real contra el LLM para cerrar el smoke: los escenarios de inyección ya están cubiertos con `loadTurnRules`.

- [ ] Correr:

```bash
cd cli && bun run scripts/rules-smoke.ts
```

Esperado: siete `ok` + `rules smoke unit OK`.

- [ ] Commit:

```bash
git add cli/scripts/rules-smoke.ts cli/package.json
git commit -m "test(rules): gherkin smoke for layered user/project/local rules"
```

---

## Orden de ejecución

1. Task 1 (parse/merge) — base. Nada más depende de red.
2. Task 2 (loaders + gitexclude) — depende de 1.
3. Task 3 (API) — paralelizables con 2.
4. Task 4 (inyectar turn) — depende de 1–3.
5. Task 5 (gate) — depende de 4 (bundle en el runner).
6. Task 6 (git guard) — depende de 2; paralelizable con 4/5.
7. Task 7 (RPC) — depende de 2–3.
8. Task 8 (CLI) — depende de 3 y 2.
9. Task 9 (TUI) — depende de 4.
10. Task 10 (Web) — depende de 3 y 7.
11. Task 11 (smoke) — al final; el bloque unitario puede correrse tras 2+4.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Las tres capas se inyectan; local gana | Task 1 merge + Task 4 `appendSystemPrompt` + Task 11 smoke |
| Proyecto carga AGENTS y nativos | Task 2 `loadProjectRules` + smoke |
| Local no se sube a git; otra máquina no las ve | Task 2 exclude + Task 6 `gitCommitBlockedReason` + archivo máquina `~/.chavez/…` |
| Usuario sigue entre workspaces; se desactiva por workspace | Task 3 `/rules` + `userRulesEnabled` + Task 4 omite user layer + Task 8/9/10 toggle |
| Visible cuántas y de qué capa (títulos) | Task 1 `rulesMetadata` (sin `body`) + Task 4 `chat.stream.end` + Task 8 watch + Task 9/10 UI |
| Sin AGENTS.md el turn corre | Task 2 empty `[]` + Task 4 try/catch + Task 11 primer bloque |
| Regla local no-bash en auto → denied | Task 5 `denyIfRuleDisallowed` **antes** de ejecutar bash + Task 11 |

## Fuera de este plan (no implementar)

- Memoria entre chats (facts, no instrucciones) → [memory](../memory/plan.md).
- Slash `/rules` → [slash-commands](../slash-commands/plan.md). TUI usa `r`; CLI usa `chavez rules`.
- Compact del prompt de reglas → [context-compact](../context-compact/plan.md). Esta fase solo trunca a `RULES_PROMPT_MAX_CHARS`.
- Cursor ejecutable → [cursor-provider](../cursor-provider/plan.md). `applyRulesToCursorPrompt` queda listo; no simular turns.
- Skills / MCP / subagentes → [mcp-skills-subagents](../mcp-skills-subagents/plan.md).
- Editar `AGENTS.md` con un editor rico en Web (escribir el archivo del repo) — fuera. El usuario lo edita en git; el loader lo recarga en el **siguiente** turn.
- Cargar `~/.claude/CLAUDE.md` como capa usuario (no viaja de máquina).
