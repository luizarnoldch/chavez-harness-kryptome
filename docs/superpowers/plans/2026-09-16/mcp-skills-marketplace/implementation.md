# MCP Skills Marketplace Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/mcp` `/skill` `/marketplace` (plan 11), cola de turns (plan 29), worktrees paralelos (plan 28), sandbox de red (plan 26), ni el runtime MCP/skills (plan 19: **ya debe existir**; esta fase solo instala). Spec: [`plan.md`](./plan.md). Depende de MCP/skills ([`mcp-skills-subagents`](../mcp-skills-subagents/implementation.md)), modos ([`execution-modes`](../execution-modes/implementation.md)), aprobaciones ([`approvals`](../approvals/implementation.md)) y reglas de capas ([`project-rules`](../project-rules/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario instala MCP y skills **desde un catálogo en la UI**, sin editar JSON a mano. Web lista lo disponible con origen **oficial vs proyecto** (y usuario si ya está en la cuenta). Instalar una skill oficial la deja en la **capa usuario** (`user_skills`); el **siguiente** turn la carga (plan 19). Instalar un MCP de proyecto **escribe/actualiza** `.mcp.json` en el cwd del daemon: en `ask` se confirma porque toca el repo; en `auto` se escribe si el usuario pidió instalar; en `plan` se deniega. Desinstalar deja de cargarse y **no** apaga read/write/edit/grep/glob/bash ni `chavez-git` / `chavez-skills`. Si el origen falla, el error es visible. **La API no ejecuta código de marketplace** (cero `npx` / stdio MCP / `query()`). El daemon del usuario es quien corre MCP, y solo **en el siguiente turn**, no en el install.

**Architecture:** El catálogo oficial es **datos versionados** (TypeScript congelado), servido por HTTP. Instalar una skill es persistir el body en Postgres (cuenta). Instalar un MCP de proyecto es un RPC al daemon que **solo escribe JSON** en el cwd. El spawn stdio/SSE/HTTP lo sigue haciendo el loader del plan 19 al correr el turn. La API mira el `id` en su copia del catálogo y manda la receta; nunca `child_process`.

```
GET /marketplace                  catálogo oficial (datos)
GET /skills                       capa usuario ya instalada (plan 19)
workspace.mcp.snapshot            MCP del cwd (plan 19; daemon)
        |
        v
mergeMarketplaceView()            origin=oficial|proyecto|usuario
        |
Web /marketplace · TUI tecla K · chavez marketplace list

Instalar skill (capa usuario, sin daemon):
  POST /marketplace/install { kind:"skill", id }
        → API lookup catálogo → INSERT user_skills source=marketplace
        → skills.updated + marketplace.changed
        → siguiente agent.turn.dispatch incluye userSkills (plan 19)

Instalar MCP (capa proyecto, daemon, toca el repo):
  workspace.marketplace.install { kind:"mcp", id }
        → API lookup receta (datos) → hub.findDaemon
        → daemon:
             plan → MARKETPLACE_PLAN_DENIED (disco intacto)
             ask  → diff de .mcp.json + awaiting_approval (una a una)
             auto → escribe .mcp.json (el click/CLI es “el usuario pidió instalar”)
        → NO spawn del command
        → marketplace.changed { snapshot }
        → siguiente turn: loadMcpFromDisk (plan 19)

Desinstalar:
  skill → DELETE /skills/:id (o POST /marketplace/uninstall)
  mcp   → daemon quita la key de .mcp.json o la añade a disabledServers
        → nativas + host MCP siguen

Fallo de origen:
  id ausente / catálogo inválido / receta incompleta → error visible
  API route: sin spawn, sin query(), sin createSdkMcpServer
```

Estado actual que este plan extiende (no reescribir):

- Plan 19 crea `user_skills`, `GET/POST/PUT/DELETE /skills`, `cli/src/llm/mcp-load.ts`, `cli/src/llm/skills-load.ts`, `workspace.mcp.snapshot`, `workspace.skills.snapshot`, `chat.mcp.status`, host servers `chavez-git` / `chavez-skills`. **Esta fase no reimplementa el runtime.** Si esos archivos no existen, **para y aplica el plan 19 primero**.
- Plan 19 dice explícitamente: *“Plan 36 (marketplace) no se implementa: no hay catálogo remoto ni instalar.”* Esta fase es ese catálogo + instalar.
- `api/src/db/schema.ts` (tras plan 19) tiene `userSkills` con `name/description/body/enabled`. **No** hay `source` ni `catalogId`. Esta fase los añade nullable/default.
- `api/src/index.ts` monta `/skills` (plan 19). **No** hay `/marketplace`. CORS hay que añadir.
- `cli/src/ws/daemon.ts` atiende `agent.turn.dispatch` y (plan 19) `workspace.mcp.dispatch` / `workspace.skills.dispatch`. **No** escribe `.mcp.json` de un catálogo.
- `cli/src/llm/mcp-parse.ts` lee `mcpServers`. **No** hay `disabledServers`.
- Web: `pages/skills.astro` (plan 19) CRUD de cuenta. **No** hay `/marketplace` ni columna origen.
- TUI: tecla `k` overlay skills (plan 19). **No** hay catálogo ni tecla `K`.
- CLI: `chavez skills list|add|rm` (plan 19). **No** hay `chavez marketplace`.
- Modos (plan 3): `plan` deniega write; `ask` waiter una a una; `auto` permite write. Reusar `PLAN_MUTATION_DENIED` **no** — el string de marketplace es propio (`MARKETPLACE_PLAN_DENIED`) porque no es una tool del LLM. Reusar `ASK_APPROVAL_TIMEOUT_MS` y el patrón CAS `ya resuelto`.
- Aprobaciones (plan 13): una a una, sin lote, sin “siempre permitir”. Headless **no** auto-aprueba el write de `.mcp.json`.
- Decision 15 (red en auto): escribir `.mcp.json` es FS, no red. El `npx` del MCP ocurre en el **siguiente turn** (plan 19). Esta fase **no** implementa el deny de red de bash.
- Cursor `runnable` según plan 4. Instalar no dispara un turn Cursor ni Claude.
- Un usuario = su vault. `user_skills` filtra `eq(userId)`. Sin org.

**Tech Stack:** Bun, Hono + Drizzle (`user_skills.source` / `user_skills.catalog_id`; **sin** tabla de catálogo — el catálogo es código), WebSocket hub + `createPendingMap` (reusar `api/src/ws/pending.ts`), Ink TUI, Astro/React web + TanStack Query. Tests: `bun test`. Web **no** importa CLI: duplicar `web/src/lib/marketplace-display.ts` (comentario keep-in-sync). Catálogo: dos copias bit-idénticas `cli/src/llm/marketplace-catalog.ts` y `api/src/llm/marketplace-catalog.ts`. Sin paquete MCP extra. Sin `child_process` en `api/`. Sin octokit. Sin fetch de un registry remoto (el origen oficial es el módulo versionado; un JSON remoto sería ejecutar un canal de origen en el API).

**Global Constraints:**

1. El filesystem y el spawn MCP viven **solo** en el daemon. API y browser no spawnean `npx`, no hablan con URLs MCP, no leen `SKILL.md` del cwd, no `eval` / `import()` dinámico de paquetes del catálogo.
2. Sin daemon bound: instalar/desinstalar **MCP de proyecto** y el snapshot de origen `proyecto` fallan con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. Listar el catálogo oficial y CRUD de skills de **usuario** **sí** funcionan sin daemon.
3. Un turn de agente solo corre si hay daemon bound. Instalar **no** es un turn y **no** llama `agent.turn.request`. La skill/MCP nueva aplica en el **siguiente** turn (plan 19). No cancela el turn en curso.
4. Web, TUI y CLI `watch` ven el mismo `marketplace.changed` / `marketplace.install.ask`. Tras instalar una skill, el siguiente turn la usa en las tres superficies (mismo `userSkills` en el dispatch).
5. Preferencias de provider/modelo/esfuerzo/modo **no** se tocan. El modo activo **sí** gobierna el write de `.mcp.json`.
6. Claude es el provider ejecutable; Cursor según plan 4. El catálogo no finge paridad de runtime.
7. Tools nativas siempre. Desinstalar un MCP/skill **nunca** quita Read/Write/Edit/Grep/Glob/Bash ni los host `chavez-git` / `chavez-skills`.
8. Lecturas no piden confirmación. Escribir `.mcp.json` **sí** es write: `plan` deniega, `ask` confirma una a una, `auto` escribe porque el usuario pidió instalar (click / CLI). Sin lote ni “siempre permitir”.
9. Skills de marketplace → capa **usuario** (cuenta). MCP de marketplace → capa **proyecto** (`.mcp.json` del cwd). No instalar skills oficiales en el repo ni MCP oficiales en `user_skills`.
10. El API **solo acepta `id` del catálogo oficial** para instalar. Un cliente no puede inyectar `command: "rm -rf"`. El daemon vuelve a comprobar que la receta coincide con su copia del catálogo (`MARKETPLACE_RECIPE_MISMATCH`).
11. Fallo de origen: id desconocido, catálogo con entrada inválida, receta incompleta, o JSON de `.mcp.json` ilegible al mergear. Error visible. El install **no** corre el binario. Si el MCP falla al **siguiente** turn, es el aviso del plan 19 (`MCP server failed: … — Native tools continue`), no un 500 del API.
12. Picker TUI del catálogo: máximo **10** filas visibles; se afina con el prefijo; selección de uno en uno. La página Web lista todas las coincidencias del filtro (no es el picker `@`).
13. 1 turn por daemon. Instalar durante un turn **sí** está permitido (no es un segundo turn); el loader no recarga MCP a mitad del `query()`.
14. Un usuario = su vault. Sin org ni roles.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, registry remoto, “siempre permitir”, lote, GitHub Action, instalar MCP en capa local (`~/.chavez/.../mcp.json`), slash `/marketplace`.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `MARKETPLACE_ORIGINS` | `"oficial"` \| `"proyecto"` \| `"usuario"` |
| `MARKETPLACE_KINDS` | `"mcp"` \| `"skill"` |
| `MARKETPLACE_PICKER_LIMIT` | `10` |
| `MARKETPLACE_FILE` | `".mcp.json"` |
| `MARKETPLACE_RPC_TIMEOUT_MS` | `5_000` |
| `ASK_APPROVAL_TIMEOUT_MS` | `300_000` (reusar plan 3; no cambiar) |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `MARKETPLACE_PLAN_DENIED` | `"Plan mode: installing or uninstalling project MCP writes the repo. Switch to ask or auto."` |
| `MARKETPLACE_NOT_FOUND` | `` `Marketplace entry not found: ${id}` `` |
| `MARKETPLACE_ENTRY_INVALID` | `` `Marketplace entry "${id}" is invalid: ${reason}` `` |
| `MARKETPLACE_CATALOG_ERROR` | `"Official catalog failed to load"` |
| `MARKETPLACE_ALREADY_INSTALLED` | `` `Already installed: ${name}` `` |
| `MARKETPLACE_NOT_INSTALLED` | `` `Not installed: ${name}` `` |
| `MARKETPLACE_HOST_PROTECTED` | `` `Cannot install or uninstall host MCP server "${name}"` `` |
| `MARKETPLACE_RECIPE_MISMATCH` | `"Marketplace recipe does not match the official catalog — refusing to write"` |
| `MARKETPLACE_KIND_LAYER` | `"Skills install to the user account; MCP installs to the project .mcp.json"` |
| `MARKETPLACE_ASK_WAITING` | `"ask: writing .mcp.json needs approval from Web, TUI, or this CLI — not auto-approved"` |
| `MARKETPLACE_ASK_PROMPT` | `` `Write ${MARKETPLACE_FILE}? (y/n)` `` |
| `MARKETPLACE_INSTALLED` | `` `Installed ${kind} ${name}` `` |
| `MARKETPLACE_UNINSTALLED` | `` `Uninstalled ${kind} ${name}` `` |
| `MARKETPLACE_DENIED` | `"User denied marketplace write"` |
| `MARKETPLACE_EMPTY` | `"0 marketplace entries"` |
| `MARKETPLACE_ORIGIN_OFICIAL` | `"oficial"` |
| `MARKETPLACE_ORIGIN_PROYECTO` | `"proyecto"` |
| `MARKETPLACE_ORIGIN_USUARIO` | `"usuario"` |
| `MARKETPLACE_LIST_HEADER` | `"kind  origin     installed  name"` |
| `ALREADY_RESOLVED_ERROR` | `"ya resuelto"` (reusar plan 13; no cambiar) |
| `NATIVE_TOOLS` | `read`, `write`, `edit`, `grep`, `glob`, `bash` |
| `HOST_MCP_NAMES` | `"chavez-git"`, `"chavez-skills"` (reusar plan 19) |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` / `ASK_APPROVAL_TIMEOUT_MS` / `ALREADY_RESOLVED_ERROR` / `USER_SKILLS_CAP_ERROR` / `USER_SKILL_NAME_ERROR` si ya existen. **No** cambiar esos strings.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `workspace.marketplace.snapshot` | cliente → API | Vista mergeada. API espera al daemon **solo** para la mitad proyecto; catálogo + user skills se arman en API. |
| `workspace.marketplace.install` | cliente → API | `{ kind, id }`. Skill → HTTP interno (user_skills). MCP → daemon. |
| `workspace.marketplace.uninstall` | cliente → API | `{ kind, name }`. |
| `workspace.marketplace.dispatch` | API → daemon | `{ requestId, action: "snapshot"\|"install"\|"uninstall"\|"apply", path, payload }` |
| `workspace.marketplace.result` | daemon → API | Completa el pending. |
| `workspace.marketplace.approve` | cliente → API | `{ requestId }` una a una. |
| `workspace.marketplace.deny` | cliente → API | `{ requestId }` una a una. |
| `marketplace.install.ask` | API → broadcast | `{ requestId, workspaceId, kind, name, path, diff, approvalDeadline }` |
| `marketplace.changed` | API → broadcast | `{ workspaceId, view }` para que Web/TUI coincidan. |
| `skills.updated` | API → broadcast | Tras install/uninstall de skill (reusar plan 19). |

HTTP:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/marketplace` | `{ entries: MarketplaceEntry[], errors: string[] }` del catálogo oficial. 401 sin sesión. **No** lee el cwd. Marca `installed` de skills contra `user_skills` de **este** userId. MCP `installed` queda `false` aquí (el merge con proyecto es el RPC snapshot). |
| `POST` | `/marketplace/install` | `{ kind: "skill"\|"mcp", id: string }`. Skill: 201 `{ skill, view }`. MCP: 400 `MARKETPLACE_KIND_LAYER` — el MCP **no** se instala por HTTP; el cliente debe usar el WS. Esto evita que un POST sin daemon escriba en el disco del API. |
| `POST` | `/marketplace/uninstall` | `{ kind: "skill"\|"mcp", name: string }`. Skill: 200 `{ ok: true }`. MCP: 400 igual que install — WS only. |

Tras GET no hay broadcast. Tras POST skill install/uninstall: `skills.updated` + `marketplace.changed` (sin `workspaceId`, `view` de cuenta).

Tipos (congelados):

```ts
export const MARKETPLACE_ORIGINS = ["oficial", "proyecto", "usuario"] as const;
export type MarketplaceOrigin = (typeof MARKETPLACE_ORIGINS)[number];

export const MARKETPLACE_KINDS = ["mcp", "skill"] as const;
export type MarketplaceKind = (typeof MARKETPLACE_KINDS)[number];

export type MarketplaceMcpRecipe = {
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  requiredEnv: string[];
};

export type MarketplaceEntry = {
  id: string;
  kind: MarketplaceKind;
  name: string;
  title: string;
  description: string;
  origin: "oficial";
  recipe?: MarketplaceMcpRecipe; // kind=mcp
  body?: string;                 // kind=skill (SKILL.md completo)
};

export type MarketplaceViewRow = {
  id: string;          // catalog id, or `project:${name}` / `user:${name}`
  kind: MarketplaceKind;
  name: string;
  title: string;
  description: string;
  origin: MarketplaceOrigin;
  installed: boolean;
  layer?: "user" | "project" | "local" | "host";
  path?: string;
  requiredEnv: string[];
  catalogId?: string;
};

export type MarketplaceView = {
  entries: MarketplaceViewRow[];
  errors: string[];
  nativeToolsContinue: true;
};

export type MarketplaceInstallRequest = {
  kind: MarketplaceKind;
  id: string;
};

export type MarketplaceUninstallRequest = {
  kind: MarketplaceKind;
  name: string;
};

export type MarketplaceAskPayload = {
  requestId: string;
  workspaceId: string;
  kind: "mcp";
  action: "install" | "uninstall";
  name: string;
  path: ".mcp.json";
  diff: string;
  approvalDeadline: string; // ISO
};
```

Catálogo oficial (congelado, **estas cuatro entradas**, ni una más en esta fase):

| id | kind | name | title |
|---|---|---|---|
| `github` | mcp | `github` | GitHub |
| `sequential-thinking` | mcp | `sequential-thinking` | Sequential Thinking |
| `commit` | skill | `commit` | Commit message |
| `pr-review` | skill | `pr-review` | PR review |

Alcance (Gherkin):

| Escenario | Qué demuestra |
|---|---|
| Listar | Web `/marketplace` muestra las 4 oficiales + MCP/skills del cwd como `proyecto` |
| Instalar skill de usuario | `commit` → fila en `user_skills`; siguiente turn la tiene en `applied` capa user |
| Instalar MCP de proyecto | `github` → `.mcp.json` con `mcpServers.github`; ask confirma; auto escribe |
| Desinstalar | quita la key / la skill; nativas siguen; host MCP no se puede quitar |
| Fallo de origen | id `nope` → `MARKETPLACE_NOT_FOUND`; API sin spawn |

---

## Task 1: Módulos puros — constantes, catálogo oficial, vista mergeada, origen

**Files:**

- Create: `cli/src/llm/marketplace-constants.ts`
- Create: `cli/src/llm/marketplace-catalog.ts`
- Create: `cli/src/llm/marketplace-view.ts`
- Test: `cli/src/llm/marketplace-catalog.test.ts`
- Test: `cli/src/llm/marketplace-view.test.ts`
- Modify: `cli/package.json`

Sin I/O de disco ni red. TUI importa desde aquí. Web y API **no** importan CLI: Tasks 3 y 8 duplican catálogo/labels (comentario keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/marketplace-constants.ts`:

```ts
export const MARKETPLACE_ORIGINS = ["oficial", "proyecto", "usuario"] as const;
export type MarketplaceOrigin = (typeof MARKETPLACE_ORIGINS)[number];

export const MARKETPLACE_KINDS = ["mcp", "skill"] as const;
export type MarketplaceKind = (typeof MARKETPLACE_KINDS)[number];

export const MARKETPLACE_PICKER_LIMIT = 10;
export const MARKETPLACE_FILE = ".mcp.json";
export const MARKETPLACE_RPC_TIMEOUT_MS = 5_000;

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const MARKETPLACE_PLAN_DENIED =
  "Plan mode: installing or uninstalling project MCP writes the repo. Switch to ask or auto.";

export const MARKETPLACE_CATALOG_ERROR = "Official catalog failed to load";
export const MARKETPLACE_KIND_LAYER =
  "Skills install to the user account; MCP installs to the project .mcp.json";
export const MARKETPLACE_ASK_WAITING =
  "ask: writing .mcp.json needs approval from Web, TUI, or this CLI — not auto-approved";
export const MARKETPLACE_ASK_PROMPT = `Write ${MARKETPLACE_FILE}? (y/n)`;
export const MARKETPLACE_DENIED = "User denied marketplace write";
export const MARKETPLACE_EMPTY = "0 marketplace entries";
export const MARKETPLACE_LIST_HEADER = "kind  origin     installed  name";
export const MARKETPLACE_RECIPE_MISMATCH =
  "Marketplace recipe does not match the official catalog — refusing to write";

export const MARKETPLACE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function marketplaceNotFound(id: string): string {
  return `Marketplace entry not found: ${id}`;
}

export function marketplaceEntryInvalid(id: string, reason: string): string {
  return `Marketplace entry "${id}" is invalid: ${reason}`;
}

export function marketplaceAlreadyInstalled(name: string): string {
  return `Already installed: ${name}`;
}

export function marketplaceNotInstalled(name: string): string {
  return `Not installed: ${name}`;
}

export function marketplaceHostProtected(name: string): string {
  return `Cannot install or uninstall host MCP server "${name}"`;
}

export function marketplaceInstalled(kind: MarketplaceKind, name: string): string {
  return `Installed ${kind} ${name}`;
}

export function marketplaceUninstalled(kind: MarketplaceKind, name: string): string {
  return `Uninstalled ${kind} ${name}`;
}

export function isMarketplaceId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 64 && MARKETPLACE_ID_RE.test(v);
}
```

Si `NO_DAEMON_ERROR` ya vive en `cli/src/llm/tool-names.ts` o `cli/src/llm/mcp-constants.ts`, reexportar el mismo literal.

- [ ] Crear `cli/src/llm/marketplace-catalog.ts`. **Estas cuatro entradas, copiar el body bit-idéntico.** No añadir más en esta fase.

```ts
import {
  isMarketplaceId,
  marketplaceEntryInvalid,
  type MarketplaceKind,
} from "./marketplace-constants";
import type { MarketplaceEntry, MarketplaceMcpRecipe } from "./marketplace-view";

const COMMIT_BODY = `---
name: commit
description: Write a conventional commit message from the staged diff
---

# Commit

1. Run git status and git diff --staged.
2. Write a conventional commit subject ≤ 72 chars.
3. Do not commit unless the user asked.
`;

const PR_REVIEW_BODY = `---
name: pr-review
description: Review the current branch against main
---

# PR review

1. git diff main...HEAD
2. List bugs, risks, and test gaps.
3. Do not push or open a PR unless asked.
`;

export const OFFICIAL_CATALOG: MarketplaceEntry[] = [
  {
    id: "github",
    kind: "mcp",
    name: "github",
    title: "GitHub",
    description: "Repos, issues and PRs via the GitHub API",
    origin: "oficial",
    recipe: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    },
  },
  {
    id: "sequential-thinking",
    kind: "mcp",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    description: "Structured multi-step reasoning",
    origin: "oficial",
    recipe: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      requiredEnv: [],
    },
  },
  {
    id: "commit",
    kind: "skill",
    name: "commit",
    title: "Commit message",
    description: "Write a conventional commit message from the staged diff",
    origin: "oficial",
    body: COMMIT_BODY,
  },
  {
    id: "pr-review",
    kind: "skill",
    name: "pr-review",
    title: "PR review",
    description: "Review the current branch against main",
    origin: "oficial",
    body: PR_REVIEW_BODY,
  },
];

export function validateMarketplaceEntry(
  e: MarketplaceEntry,
): string | null {
  if (!isMarketplaceId(e.id)) return "id must be kebab-case [a-z0-9-]+";
  if (e.kind !== "mcp" && e.kind !== "skill") return "kind must be mcp or skill";
  if (!e.name || e.name !== e.id) return "name must equal id";
  if (!e.title || !e.description) return "title and description required";
  if (e.origin !== "oficial") return "catalog origin must be oficial";
  if (e.kind === "mcp") {
    const r = e.recipe;
    if (!r) return "mcp recipe required";
    if (r.transport === "stdio") {
      if (!r.command) return "stdio recipe missing command";
    } else if (!r.url) {
      return "http/sse recipe missing url";
    }
    if (e.body) return "mcp must not include a skill body";
  } else {
    if (!e.body || e.body.length < 1) return "skill body required";
    if (e.recipe) return "skill must not include an mcp recipe";
  }
  return null;
}

export function loadOfficialCatalog(): {
  entries: MarketplaceEntry[];
  errors: string[];
} {
  const entries: MarketplaceEntry[] = [];
  const errors: string[] = [];
  for (const e of OFFICIAL_CATALOG) {
    const reason = validateMarketplaceEntry(e);
    if (reason) errors.push(marketplaceEntryInvalid(e.id, reason));
    else entries.push(e);
  }
  return { entries, errors };
}

export function lookupOfficial(
  id: string,
): { ok: true; entry: MarketplaceEntry } | { ok: false; error: string } {
  const { entries, errors } = loadOfficialCatalog();
  void errors;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `Marketplace entry not found: ${id}` };
  return { ok: true, entry };
}

export function recipesEqual(
  a: MarketplaceMcpRecipe | undefined,
  b: MarketplaceMcpRecipe | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    a.url === b.url
  );
}

void (0 as unknown as MarketplaceKind);
```

Mueve los types `MarketplaceEntry` / `MarketplaceMcpRecipe` a `marketplace-view.ts` **o** a `marketplace-constants.ts` y reexporta. Un solo sitio.

- [ ] Crear `cli/src/llm/marketplace-view.ts`:

```ts
import { MARKETPLACE_PICKER_LIMIT } from "./marketplace-constants";
import { loadOfficialCatalog } from "./marketplace-catalog";
import type {
  MarketplaceEntry,
  MarketplaceMcpRecipe,
  MarketplaceView,
  MarketplaceViewRow,
} from "./marketplace-constants";

export type InstalledMcp = {
  name: string;
  layer: "project" | "local" | "host";
  path: string;
};

export type InstalledSkill = {
  name: string;
  layer: "user" | "project" | "local";
  catalogId?: string | null;
};

const HOST = new Set(["chavez-git", "chavez-skills"]);

export function mergeMarketplaceView(input: {
  catalog?: MarketplaceEntry[];
  catalogErrors?: string[];
  installedMcp?: InstalledMcp[];
  installedSkills?: InstalledSkill[];
}): MarketplaceView {
  const loaded = input.catalog ? { entries: input.catalog, errors: input.catalogErrors ?? [] } : loadOfficialCatalog();
  const mcp = (input.installedMcp ?? []).filter((s) => !HOST.has(s.name));
  const skills = input.installedSkills ?? [];
  const rows: MarketplaceViewRow[] = [];
  const seenMcp = new Set<string>();
  const seenSkill = new Set<string>();

  for (const e of loaded.entries) {
    if (e.kind === "mcp") {
      const hit = mcp.find((s) => s.name === e.name);
      rows.push({
        id: e.id,
        kind: "mcp",
        name: e.name,
        title: e.title,
        description: e.description,
        origin: "oficial",
        installed: Boolean(hit),
        layer: hit?.layer,
        path: hit?.path,
        requiredEnv: e.recipe?.requiredEnv ?? [],
        catalogId: e.id,
      });
      if (hit) seenMcp.add(hit.name);
    } else {
      const hit = skills.find((s) => s.name === e.name);
      rows.push({
        id: e.id,
        kind: "skill",
        name: e.name,
        title: e.title,
        description: e.description,
        origin: "oficial",
        installed: Boolean(hit),
        layer: hit?.layer ?? (hit ? "user" : undefined),
        requiredEnv: [],
        catalogId: e.id,
      });
      if (hit) seenSkill.add(hit.name);
    }
  }

  for (const s of mcp) {
    if (seenMcp.has(s.name)) continue;
    rows.push({
      id: `project:${s.name}`,
      kind: "mcp",
      name: s.name,
      title: s.name,
      description: "",
      origin: "proyecto",
      installed: true,
      layer: s.layer,
      path: s.path,
      requiredEnv: [],
    });
  }

  for (const s of skills) {
    if (seenSkill.has(s.name)) continue;
    rows.push({
      id: `${s.layer}:${s.name}`,
      kind: "skill",
      name: s.name,
      title: s.name,
      description: "",
      origin: s.layer === "user" ? "usuario" : "proyecto",
      installed: true,
      layer: s.layer,
      requiredEnv: [],
      catalogId: s.catalogId ?? undefined,
    });
  }

  return { entries: rows, errors: loaded.errors, nativeToolsContinue: true };
}

export function filterMarketplaceRows(
  rows: MarketplaceViewRow[],
  query: string,
  limit = MARKETPLACE_PICKER_LIMIT,
): MarketplaceViewRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) =>
        `${r.kind} ${r.name} ${r.title} ${r.origin}`.toLowerCase().includes(q),
      )
    : rows;
  return filtered.slice(0, limit);
}

export function formatMarketplaceList(view: MarketplaceView): string {
  if (!view.entries.length && !view.errors.length) return "0 marketplace entries";
  const lines = ["kind  origin     installed  name"];
  for (const r of view.entries) {
    const inst = r.installed ? "yes" : "no ";
    const origin = r.origin.padEnd(9, " ");
    lines.push(`${r.kind.padEnd(4, " ")}  ${origin}  ${inst}        ${r.name}`);
  }
  for (const e of view.errors) lines.push(`error  ${e}`);
  return lines.join("\n");
}
```

Los types `MarketplaceEntry` / `MarketplaceMcpRecipe` / `MarketplaceView` / `MarketplaceViewRow` viven en `marketplace-constants.ts`. `marketplace-catalog.ts` y `marketplace-view.ts` importan de ahí. No redefinirlos.

- [ ] Tests `marketplace-catalog.test.ts`:

  - `loadOfficialCatalog().entries` tiene exactamente 4 ids: `github`, `sequential-thinking`, `commit`, `pr-review`.
  - `lookupOfficial("github").ok` y `recipe.command === "npx"`.
  - `lookupOfficial("nope")` → error exacto `Marketplace entry not found: nope`.
  - `validateMarketplaceEntry` de un mcp sin `command` ni `url` → string de reason.
  - `recipesEqual` true para dos copias de github; false si `args` cambian.

- [ ] Tests `marketplace-view.test.ts`:

  - Catálogo solo → 4 filas, `origin === "oficial"`, `installed === false`, `nativeToolsContinue === true`.
  - `installedMcp: [{ name: "github", layer: "project", path: ".mcp.json" }]` → github `installed: true`, origin sigue `oficial`.
  - `installedMcp: [{ name: "echo", layer: "project", path: ".mcp.json" }]` → fila extra `origin === "proyecto"`, id `project:echo`.
  - `installedSkills: [{ name: "commit", layer: "user", catalogId: "commit" }]` → commit `installed: true`.
  - `installedSkills: [{ name: "acme", layer: "user" }]` → origin `usuario`.
  - `installedSkills: [{ name: "pdf", layer: "project" }]` → origin `proyecto`.
  - Host `chavez-git` **no** aparece.
  - `filterMarketplaceRows(rows, "git", 10)` incluye `github` y no `commit`; largo ≤ 10.
  - `formatMarketplaceList` incluye header y `oficial`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/marketplace-catalog.test.ts src/llm/marketplace-view.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/package.json cli/src/llm/marketplace-constants.ts \
  cli/src/llm/marketplace-catalog.ts cli/src/llm/marketplace-view.ts \
  cli/src/llm/marketplace-catalog.test.ts cli/src/llm/marketplace-view.test.ts
git commit -m "feat(marketplace): official catalog and origin merge view"
```

---

## Task 2: Módulos puros — upsert/disable de `.mcp.json`, gate de modo, receta vs catálogo

**Files:**

- Create: `cli/src/llm/marketplace-mcp-json.ts`
- Create: `cli/src/llm/marketplace-gate.ts`
- Test: `cli/src/llm/marketplace-mcp-json.test.ts`
- Test: `cli/src/llm/marketplace-gate.test.ts`
- Modify: `cli/src/llm/mcp-parse.ts` (añadir `disabledServers`)
- Test: `cli/src/llm/mcp-parse.test.ts` (extender)

Sin `child_process`. Sin escribir disco (el writer de disco es Task 4).

- [ ] Crear `cli/src/llm/marketplace-mcp-json.ts`:

```ts
import { MARKETPLACE_FILE, marketplaceHostProtected } from "./marketplace-constants";
import type { MarketplaceMcpRecipe } from "./marketplace-constants";

export type McpJsonFile = {
  mcpServers: Record<string, Record<string, unknown>>;
  disabledServers: string[];
};

export type McpJsonPatch = {
  next: McpJsonFile;
  previous: McpJsonFile;
  diff: string;
  action: "upsert" | "remove" | "disable" | "noop";
  path: typeof MARKETPLACE_FILE;
};

const HOST = new Set(["chavez-git", "chavez-skills"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseMcpJsonFile(raw: unknown): McpJsonFile {
  const root = asRecord(raw) ?? {};
  const block = asRecord(root.mcpServers) ?? {};
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [k, val] of Object.entries(block)) {
    const o = asRecord(val);
    if (o) mcpServers[k] = o;
  }
  const disabled = Array.isArray(root.disabledServers)
    ? root.disabledServers.map((x) => String(x)).filter(Boolean)
    : [];
  return { mcpServers, disabledServers: [...new Set(disabled)] };
}

export function emptyMcpJson(): McpJsonFile {
  return { mcpServers: {}, disabledServers: [] };
}

export function recipeToMcpServer(recipe: MarketplaceMcpRecipe): Record<string, unknown> {
  if (recipe.transport === "stdio") {
    return {
      command: recipe.command,
      args: recipe.args ?? [],
    };
  }
  return {
    type: recipe.transport,
    url: recipe.url,
  };
}

function serialize(file: McpJsonFile): string {
  const body: Record<string, unknown> = {
    mcpServers: file.mcpServers,
  };
  if (file.disabledServers.length) body.disabledServers = file.disabledServers;
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function unifiedDiff(previous: McpJsonFile, next: McpJsonFile): string {
  const a = serialize(previous).split("\n");
  const b = serialize(next).split("\n");
  const lines = [`--- a/${MARKETPLACE_FILE}`, `+++ b/${MARKETPLACE_FILE}`];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] != null) lines.push(`-${a[i]}`);
    if (b[i] != null) lines.push(`+${b[i]}`);
  }
  return lines.join("\n");
}

export function applyMcpInstall(
  current: McpJsonFile,
  name: string,
  recipe: MarketplaceMcpRecipe,
): McpJsonPatch | { error: string } {
  if (HOST.has(name)) return { error: marketplaceHostProtected(name) };
  const previous = {
    mcpServers: { ...current.mcpServers },
    disabledServers: [...current.disabledServers],
  };
  const already =
    current.mcpServers[name] &&
    !current.disabledServers.includes(name);
  if (already) {
    return {
      next: current,
      previous,
      diff: "",
      action: "noop",
      path: MARKETPLACE_FILE,
    };
  }
  const next: McpJsonFile = {
    mcpServers: {
      ...current.mcpServers,
      [name]: recipeToMcpServer(recipe),
    },
    disabledServers: current.disabledServers.filter((n) => n !== name),
  };
  return {
    next,
    previous,
    diff: unifiedDiff(previous, next),
    action: "upsert",
    path: MARKETPLACE_FILE,
  };
}

export function applyMcpUninstall(
  current: McpJsonFile,
  name: string,
  opts?: { presentInOtherProjectFiles?: boolean },
): McpJsonPatch | { error: string } {
  if (HOST.has(name)) return { error: marketplaceHostProtected(name) };
  const previous = {
    mcpServers: { ...current.mcpServers },
    disabledServers: [...current.disabledServers],
  };
  const inFile = Boolean(current.mcpServers[name]);
  const disabled = current.disabledServers.includes(name);
  const elsewhere = Boolean(opts?.presentInOtherProjectFiles);
  if (!inFile && !elsewhere) {
    return { error: `Not installed: ${name}` };
  }
  if (!inFile && elsewhere && disabled) {
    return { error: `Not installed: ${name}` };
  }
  const next: McpJsonFile = {
    mcpServers: { ...current.mcpServers },
    disabledServers: [...current.disabledServers],
  };
  let action: McpJsonPatch["action"] = "remove";
  if (inFile && !elsewhere) {
    delete next.mcpServers[name];
    next.disabledServers = next.disabledServers.filter((n) => n !== name);
    action = "remove";
  } else {
    if (!next.disabledServers.includes(name)) next.disabledServers.push(name);
    action = "disable";
  }
  return {
    next,
    previous,
    diff: unifiedDiff(previous, next),
    action,
    path: MARKETPLACE_FILE,
  };
}

export function serializeMcpJson(file: McpJsonFile): string {
  return serialize(file);
}
```

**No** pongas valores de `requiredEnv` (tokens) en el JSON escrito. El usuario exporta `GITHUB_PERSONAL_ACCESS_TOKEN` en el entorno del daemon.

- [ ] Crear `cli/src/llm/marketplace-gate.ts`:

```ts
import {
  MARKETPLACE_DENIED,
  MARKETPLACE_PLAN_DENIED,
} from "./marketplace-constants";

export type ExecutionMode = "plan" | "auto" | "ask";

export type MarketplaceGate =
  | { decision: "allow" }
  | { decision: "ask" }
  | { decision: "deny"; message: string };

export function gateMarketplaceWrite(
  mode: ExecutionMode,
  userRequested: boolean,
): MarketplaceGate {
  if (mode === "plan") return { decision: "deny", message: MARKETPLACE_PLAN_DENIED };
  if (mode === "ask") return { decision: "ask" };
  if (mode === "auto" && userRequested) return { decision: "allow" };
  return { decision: "deny", message: MARKETPLACE_DENIED };
}
```

`userRequested` es `true` para click de UI y para `chavez marketplace install` (el usuario lo pidió). Un hipotético tool LLM que instalara **no** se añade en esta fase; si alguien reusa el gate con `userRequested: false` en auto, se deniega.

- [ ] Extender `cli/src/llm/mcp-parse.ts`:

  - `parseMcpServersObject` también lee `disabledServers: string[]` del root (si no es array, ignorar).
  - Exportar `parseDisabledServers(raw: unknown): string[]`.
  - `mergeMcpLayers`: **después** del merge por name, filtrar cualquier server cuyo name esté en `disabledServers` de **cualquier** archivo parseado. Host names **no** se filtran aunque alguien los ponga en disabled (el in-process gana; el collision alias del plan 19 sigue).

Añadir al tipo `McpParseResult`:

```ts
export type McpParseResult = {
  servers: McpServerSource[];
  errors: { path: string; reason: string }[];
  collisions: { name: string; alias: string }[];
  disabledServers: string[];
};
```

Si el tipo ya existe sin `disabledServers`, **añadir** el campo default `[]` en todos los return. Actualizar `mergeMcpLayers` para concatenar y uniquificar disabled.

En `cli/src/llm/mcp-load.ts` `loadMcpFromDisk`, tras el merge, aplicar:

```ts
const disabled = new Set(result.disabledServers);
result = {
  ...result,
  servers: result.servers.filter(
    (s) => s.layer === "host" || !disabled.has(s.name),
  ),
};
```

(`host` no sale de disco; el filtro es por si un archivo declara `chavez-git`.)

- [ ] Tests `marketplace-mcp-json.test.ts`:

  - Install `github` sobre `emptyMcpJson()` → `action: "upsert"`, `next.mcpServers.github.command === "npx"`, diff contiene `+` y `github`.
  - Reinstall → `action: "noop"`, diff `""`.
  - Uninstall de una key que solo está en `.mcp.json` → `remove`, key ausente.
  - Uninstall con `presentInOtherProjectFiles: true` → `disable`, `disabledServers` incluye el name, la key **no** se borra si existía en `.mcp.json`… espera: si existía en `.mcp.json` **y** elsewhere, disable. Si **solo** elsewhere (no está en `.mcp.json`), `next.mcpServers` vacío y `disabledServers: [name]`.
  - Uninstall `chavez-git` → error `Cannot install or uninstall host MCP server "chavez-git"`.
  - `serializeMcpJson` termina en `\n` y no incluye `disabledServers` si está vacío.
  - Receta **sin** env keys (el JSON de github no tiene `env`).

- [ ] Tests `marketplace-gate.test.ts`:

  - `plan` + `userRequested: true` → deny, message exacto `MARKETPLACE_PLAN_DENIED`.
  - `ask` → `{ decision: "ask" }`.
  - `auto` + `userRequested: true` → allow.
  - `auto` + `userRequested: false` → deny `MARKETPLACE_DENIED`.

- [ ] Tests extra en `mcp-parse.test.ts`:

  - `{ mcpServers: { echo: { command: "true" } }, disabledServers: ["echo"] }` → `disabledServers: ["echo"]`.
  - Tras merge+filter (helper de load o función `applyDisabled(result)` exportada de `mcp-parse.ts`) `servers` no contiene `echo`.
  - `disabledServers: ["chavez-git"]` **no** elimina un server host si se inyecta a mano en el result (el filtro de load respeta host; unit-testea `applyDisabled`).

Exporta:

```ts
export function applyDisabled(result: McpParseResult): McpParseResult {
  const disabled = new Set(result.disabledServers);
  return {
    ...result,
    servers: result.servers.filter((s) => {
      if (s.layer === "host") return true;
      if (s.name === "chavez-git" || s.name === "chavez-skills") return true;
      return !disabled.has(s.name);
    }),
  };
}
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/marketplace-mcp-json.test.ts \
  src/llm/marketplace-gate.test.ts src/llm/mcp-parse.test.ts
```

Esperado: todos pasan. Los tests viejos de `mcp-parse` siguen verdes (añadir `disabledServers: []` en fixtures si el tipo lo exige).

- [ ] Commit:

```bash
git add cli/src/llm/marketplace-mcp-json.ts cli/src/llm/marketplace-gate.ts \
  cli/src/llm/marketplace-mcp-json.test.ts cli/src/llm/marketplace-gate.test.ts \
  cli/src/llm/mcp-parse.ts cli/src/llm/mcp-parse.test.ts cli/src/llm/mcp-load.ts
git commit -m "feat(marketplace): .mcp.json patch and mode gate for repo writes"
```

---

## Task 3: API — catálogo HTTP, install skill de usuario, cero runtime MCP

**Files:**

- Create: `api/src/llm/marketplace-constants.ts`
- Create: `api/src/llm/marketplace-catalog.ts`
- Create: `api/src/llm/marketplace-view.ts`
- Test: `api/src/llm/marketplace-catalog.test.ts`
- Create: `api/src/routes/marketplace.ts`
- Test: `api/src/routes/marketplace.test.ts`
- Create: `api/src/llm/marketplace-no-runtime.test.ts`
- Modify: `api/src/db/schema.ts`
- Create: `api/drizzle/0036_marketplace_skill_source.sql`
- Modify: `api/src/routes/skills.ts`
- Modify: `api/src/index.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API es fuente de verdad del catálogo **oficial** (datos) y de la capa **usuario**. MCP de proyecto **no** se instala por HTTP.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta.

- [ ] Copiar bit-idénticos (comentario `// keep-in-sync with cli/src/llm/marketplace-*.ts`):

  - `api/src/llm/marketplace-constants.ts`
  - `api/src/llm/marketplace-catalog.ts` (las mismas 4 entradas y los mismos bodies)
  - `api/src/llm/marketplace-view.ts` (`mergeMarketplaceView`, `filterMarketplaceRows`)

Test `marketplace-catalog.test.ts` en API: mismos 4 ids + `lookupOfficial("nope")`.

- [ ] En `api/src/db/schema.ts`, **extender** `userSkills` (no reescribir el resto):

```ts
source: text("source").notNull().default("manual"), // manual | marketplace
catalogId: text("catalog_id"),
```

- [ ] Crear `api/drizzle/0036_marketplace_skill_source.sql`. Si `0036_` ya existe, usar el siguiente entero libre.

```sql
ALTER TABLE "user_skills" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
ALTER TABLE "user_skills" ADD COLUMN IF NOT EXISTS "catalog_id" text;
```

Si `user_skills` no existe, **esta fase no la crea**: aplicar primero el SQL `0019_user_skills.sql` del plan 19 y después este ALTER.

- [ ] Aplicar:

```bash
cd api && bun run db:push
```

- [ ] Extender `publicSkill` en `api/src/routes/skills.ts` con `source` y `catalogId`. POST existente sigue default `manual` / `catalogId: null` (CRUD a mano del plan 19 intacto).

- [ ] Crear `api/src/routes/marketplace.ts`:

```ts
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userSkills } from "../db/schema";
import type { Session } from "../auth";
import { hub } from "../ws/hub";
import {
  MARKETPLACE_KIND_LAYER,
  marketplaceAlreadyInstalled,
  marketplaceNotFound,
  marketplaceUninstalled,
} from "../llm/marketplace-constants";
import { loadOfficialCatalog, lookupOfficial } from "../llm/marketplace-catalog";
import { mergeMarketplaceView } from "../llm/marketplace-view";
import {
  USER_SKILLS_MAX,
  USER_SKILLS_CAP_ERROR,
} from "../llm/skills-constants";

function publicSkill(row: typeof userSkills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    source: row.source,
    catalogId: row.catalogId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createMarketplaceRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const { entries, errors } = loadOfficialCatalog();
    const rows = await db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    const view = mergeMarketplaceView({
      catalog: entries,
      catalogErrors: errors,
      installedSkills: rows.map((r) => ({
        name: r.name,
        layer: "user" as const,
        catalogId: r.catalogId,
      })),
    });
    return c.json({
      entries: view.entries,
      errors: view.errors,
      nativeToolsContinue: true as const,
    });
  });

  app.post("/install", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const kind = String((body as { kind?: string }).kind || "");
    const id = String((body as { id?: string }).id || "").trim();
    if (kind === "mcp") return c.json({ error: MARKETPLACE_KIND_LAYER }, 400);
    if (kind !== "skill") return c.json({ error: MARKETPLACE_KIND_LAYER }, 400);
    const found = lookupOfficial(id);
    if (!found.ok) return c.json({ error: found.error }, 404);
    if (found.entry.kind !== "skill" || !found.entry.body) {
      return c.json({ error: marketplaceNotFound(id) }, 404);
    }
    const existing = await db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, session.user.id));
    if (existing.some((r) => r.name === found.entry.name)) {
      return c.json({ error: marketplaceAlreadyInstalled(found.entry.name) }, 409);
    }
    if (existing.length >= USER_SKILLS_MAX) {
      return c.json({ error: USER_SKILLS_CAP_ERROR }, 400);
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      name: found.entry.name,
      description: found.entry.description,
      body: found.entry.body,
      enabled: true,
      source: "marketplace",
      catalogId: found.entry.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userSkills).values(row);
    const skills = [...existing, row].map((r) =>
      "userId" in r ? publicSkill(r as typeof userSkills.$inferSelect) : r,
    );
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", { skills }),
      );
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("marketplace.changed", {
          kind: "skill",
          op: "install",
          name: row.name,
        }),
      );
    } catch {
      // HTTP ok even if broadcast fails
    }
    return c.json({ skill: publicSkill(row as typeof userSkills.$inferSelect) }, 201);
  });

  app.post("/uninstall", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const kind = String((body as { kind?: string }).kind || "");
    const name = String((body as { name?: string }).name || "").trim();
    if (kind === "mcp") return c.json({ error: MARKETPLACE_KIND_LAYER }, 400);
    if (kind !== "skill" || !name) return c.json({ error: MARKETPLACE_KIND_LAYER }, 400);
    const found = await db
      .select()
      .from(userSkills)
      .where(
        and(eq(userSkills.userId, session.user.id), eq(userSkills.name, name)),
      )
      .limit(1);
    if (!found[0]) return c.json({ error: `Not installed: ${name}` }, 404);
    await db.delete(userSkills).where(eq(userSkills.id, found[0].id));
    try {
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("skills.updated", { op: "delete", name }),
      );
      hub.broadcastToUser(
        session.user.id,
        hub.pushEvent("marketplace.changed", { kind: "skill", op: "uninstall", name }),
      );
    } catch {
      // ignore
    }
    return c.json({ ok: true, name, message: marketplaceUninstalled("skill", name) });
  });

  return app;
}
```

Ajusta `publicSkill(row as …)` si el insert no tipa: construye el objeto público a mano con los mismos campos. `USER_SKILLS_MAX` se importa del módulo del plan 19; si el export no existe, duplicar `50`.

- [ ] En `api/src/index.ts`:

  - `app.use("/marketplace/*", corsMiddleware)` y `app.use("/marketplace", corsMiddleware)`.
  - `app.route("/marketplace", createMarketplaceRoutes(requireSession))`.

- [ ] Extraer `validateMarketplaceInstallBody(body)` (kind/id) a `api/src/llm/marketplace-constants.ts` y testear **sin** Postgres en `api/src/routes/marketplace.test.ts`:

  - `{ kind: "skill", id: "commit" }` → ok.
  - `{ kind: "mcp", id: "github" }` → error `MARKETPLACE_KIND_LAYER`.
  - `{ kind: "skill", id: "nope" }` no se valida aquí (eso es lookup); test de `lookupOfficial("nope")`.
  - `loadOfficialCatalog().entries.length === 4`.

- [ ] Crear `api/src/llm/marketplace-no-runtime.test.ts` — **el escenario Fallo de origen / “no se ejecuta código de marketplace en el API”**:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN =
  /\bchild_process\b|\bspawn\b|\bexecFile\b|\bexecSync\b|\bBun\.spawn\b|\bnpx\b|\bcreateSdkMcpServer\b|\bquery\(/;

const files = [
  "src/routes/marketplace.ts",
  "src/llm/marketplace-catalog.ts",
  "src/llm/marketplace-constants.ts",
  "src/llm/marketplace-view.ts",
];

describe("API marketplace has no runtime", () => {
  for (const f of files) {
    test(f, () => {
      const src = readFileSync(join(import.meta.dir, "../..", f.replace("src/", "src/")), "utf8");
      // import.meta.dir is api/src/llm → join(.., ..) is api/
      const abs = join(import.meta.dir, "../..", f);
      const text = readFileSync(abs, "utf8");
      expect(text).not.toMatch(FORBIDDEN);
    });
  }
});
```

El path correcto desde `api/src/llm/`: `join(import.meta.dir, "../..", f)` con `f = "src/routes/marketplace.ts"`. **Borra** la línea muerta `src.replace`. El archivo real:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN =
  /\bchild_process\b|\bexecFile\b|\bexecSync\b|\bBun\.spawn\b|\bcreateSdkMcpServer\b/;

const files = [
  "src/routes/marketplace.ts",
  "src/llm/marketplace-catalog.ts",
  "src/llm/marketplace-constants.ts",
  "src/llm/marketplace-view.ts",
];

describe("API marketplace has no runtime", () => {
  for (const f of files) {
    test(`does not spawn: ${f}`, () => {
      const text = readFileSync(join(import.meta.dir, "../..", f), "utf8");
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/from "@anthropic-ai\/claude-agent-sdk"/);
    });
  }
});
```

No uses `\bspawn\b` ni `\bnpx\b` como forbidden en el **catálogo**: el string `"npx"` aparece en la receta **como dato**. El test de runtime cubre `routes/marketplace.ts` con `FORBIDDEN` **y** `npx` **solo** en ese route (el route no debe mencionar npx; la receta viaja como `recipe.command` opaco). Añade:

```ts
test("route does not mention npx", () => {
  const text = readFileSync(
    join(import.meta.dir, "../..", "src/routes/marketplace.ts"),
    "utf8",
  );
  expect(text.includes("npx")).toBe(false);
  expect(text.includes("child_process")).toBe(false);
});
```

- [ ] En `api/openapi/openapi.yaml`: tag `Marketplace`; paths `GET /marketplace`, `POST /marketplace/install`, `POST /marketplace/uninstall`; schemas `MarketplaceViewRow`, `MarketplaceInstallRequest`. Description de `/ws`: añadir `workspace.marketplace.snapshot|install|uninstall|approve|deny`, `marketplace.install.ask`, `marketplace.changed`. Dejar claro: *MCP install is WebSocket-only; the API never spawns MCP servers.*

- [ ] Correr:

```bash
cd api && bun test src/llm/marketplace-catalog.test.ts \
  src/routes/marketplace.test.ts src/llm/marketplace-no-runtime.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/llm/marketplace-constants.ts api/src/llm/marketplace-catalog.ts \
  api/src/llm/marketplace-view.ts api/src/llm/marketplace-catalog.test.ts \
  api/src/llm/marketplace-no-runtime.test.ts api/src/routes/marketplace.ts \
  api/src/routes/marketplace.test.ts api/src/routes/skills.ts \
  api/src/db/schema.ts api/drizzle/0036_marketplace_skill_source.sql \
  api/src/index.ts api/openapi/openapi.yaml api/package.json
git commit -m "feat(marketplace): catalog HTTP and user-skill install without MCP runtime"
```

---

## Task 4: Daemon — escribir/desinstalar `.mcp.json`, ask una a una, nunca spawn

**Files:**

- Create: `cli/src/llm/marketplace-fs.ts`
- Test: `cli/src/llm/marketplace-fs.test.ts`
- Modify: `cli/src/ws/daemon.ts`

Esta task escribe disco **en tmp de test**. Cero `Bun.spawn` / `npx` en el install.

- [ ] Crear `cli/src/llm/marketplace-fs.ts`:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKETPLACE_FILE, MARKETPLACE_RECIPE_MISMATCH } from "./marketplace-constants";
import { lookupOfficial, recipesEqual } from "./marketplace-catalog";
import {
  applyMcpInstall,
  applyMcpUninstall,
  emptyMcpJson,
  parseMcpJsonFile,
  serializeMcpJson,
  type McpJsonFile,
  type McpJsonPatch,
} from "./marketplace-mcp-json";
import { loadMcpFromDisk } from "./mcp-load";

export function readProjectMcpJson(cwd: string): McpJsonFile {
  const abs = join(cwd, MARKETPLACE_FILE);
  if (!existsSync(abs)) return emptyMcpJson();
  try {
    const raw = readFileSync(abs, "utf8");
    if (!raw.trim()) return emptyMcpJson();
    return parseMcpJsonFile(JSON.parse(raw));
  } catch {
    return parseMcpJsonFile(null);
  }
}

export function writeProjectMcpJson(cwd: string, file: McpJsonFile): string {
  const abs = join(cwd, MARKETPLACE_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  const text = serializeMcpJson(file);
  writeFileSync(abs, text, "utf8");
  return abs;
}

export function planMcpInstall(
  cwd: string,
  id: string,
): McpJsonPatch | { error: string } {
  const found = lookupOfficial(id);
  if (!found.ok) return { error: found.error };
  if (found.entry.kind !== "mcp" || !found.entry.recipe) {
    return { error: found.error };
  }
  const current = readProjectMcpJson(cwd);
  return applyMcpInstall(current, found.entry.name, found.entry.recipe);
}

export function planMcpUninstall(
  cwd: string,
  name: string,
): McpJsonPatch | { error: string } {
  const current = readProjectMcpJson(cwd);
  const disk = loadMcpFromDisk(cwd);
  const elsewhere = disk.servers.some(
    (s) => s.name === name && s.path !== MARKETPLACE_FILE && s.layer === "project",
  );
  return applyMcpUninstall(current, name, { presentInOtherProjectFiles: elsewhere });
}

export function assertRecipeMatchesCatalog(
  id: string,
  recipe: { transport: string; command?: string; args?: string[]; url?: string },
): string | null {
  const found = lookupOfficial(id);
  if (!found.ok) return found.error;
  if (found.entry.kind !== "mcp" || !found.entry.recipe) return found.error;
  if (!recipesEqual(found.entry.recipe, recipe as typeof found.entry.recipe)) {
    return MARKETPLACE_RECIPE_MISMATCH;
  }
  return null;
}

export function applyPatch(cwd: string, patch: McpJsonPatch): void {
  writeProjectMcpJson(cwd, patch.next);
}
```

Si `loadMcpFromDisk` aún no exporta `servers[].path` relativo, usa el `path` que el plan 19 ya pone (`".mcp.json"`, `".claude/settings.json"`, …).

- [ ] Tests `marketplace-fs.test.ts` con `mkdtempSync`:

  - tmp vacío, `planMcpInstall(tmp, "github")` → upsert; `applyPatch`; el archivo `.mcp.json` parsea y tiene `mcpServers.github.command === "npx"`.
  - **No** existe proceso hijo: el test no llama spawn; `readFileSync` del módulo `marketplace-fs.ts` no importa `node:child_process` (assert `readFileSync("cli/src/llm/marketplace-fs.ts","utf8").includes("child_process") === false`).
  - `planMcpInstall(tmp, "nope")` → error `Marketplace entry not found: nope`.
  - `planMcpInstall(tmp, "commit")` → error (skill, no mcp): `Marketplace entry not found: commit` **o** el lookup ok pero `kind !== "mcp"`. Usa `if (found.entry.kind !== "mcp") return { error: marketplaceNotFound(id) }` para un solo string.
  - Instalar github, `planMcpUninstall(tmp, "github")` → remove; apply; archivo sin key `github`.
  - Escribir `.claude/settings.json` con `mcpServers.echo` y uninstall `echo` → disable en `.mcp.json`, el settings **intact** (`readFileSync` igual).
  - `assertRecipeMatchesCatalog("github", { transport: "stdio", command: "evil" })` → `MARKETPLACE_RECIPE_MISMATCH`.
  - Host: `planMcpUninstall(tmp, "chavez-git")` → host protected.

- [ ] En `cli/src/ws/daemon.ts` `onPush`, **añadir** (no reemplazar el handler de turns ni el de mcp.snapshot del plan 19):

```ts
import { gateMarketplaceWrite } from "../llm/marketplace-gate";
import {
  applyPatch,
  planMcpInstall,
  planMcpUninstall,
} from "../llm/marketplace-fs";
import { loadMcpFromDisk } from "../llm/mcp-load";
import { loadSkillsFromDisk } from "../llm/skills-load";
import { mergeMarketplaceView } from "../llm/marketplace-view";
import { loadOfficialCatalog } from "../llm/marketplace-catalog";
import {
  MARKETPLACE_ASK_WAITING,
  MARKETPLACE_DENIED,
  marketplaceInstalled,
  marketplaceUninstalled,
} from "../llm/marketplace-constants";
import { ASK_APPROVAL_TIMEOUT_MS } from "../llm/execution-mode";

type MarketplaceAsk = {
  requestId: string;
  patch: import("../llm/marketplace-mcp-json").McpJsonPatch;
  action: "install" | "uninstall";
  name: string;
  kind: "mcp";
  deadline: number;
  resolve: (v: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const marketplaceAsk = new Map<string, MarketplaceAsk>();

function settleAsk(requestId: string, value: unknown) {
  const a = marketplaceAsk.get(requestId);
  if (!a) return false;
  clearTimeout(a.timer);
  marketplaceAsk.delete(requestId);
  a.resolve(value);
  return true;
}

async function replyMarketplace(
  requestId: string | undefined,
  payload: Record<string, unknown>,
) {
  if (!requestId) return;
  await client.request({
    type: "workspace.marketplace.result",
    requestId,
    metadata: payload,
  });
}
```

Handler:

```ts
if (msg.type === "workspace.marketplace.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    action?: string;
    path?: string;
    payload?: Record<string, unknown>;
    executionMode?: "plan" | "auto" | "ask";
    userSkills?: Array<{
      name: string;
      description: string;
      body: string;
      enabled: boolean;
      catalogId?: string | null;
    }>;
  };
  const cwd = data.path || path;
  const requestId = data.requestId;
  try {
    if (data.action === "snapshot") {
      const catalog = loadOfficialCatalog();
      const mcp = loadMcpFromDisk(cwd);
      const skills = loadSkillsFromDisk(cwd, data.userSkills ?? []);
      const view = mergeMarketplaceView({
        catalog: catalog.entries,
        catalogErrors: catalog.errors,
        installedMcp: mcp.servers.map((s) => ({
          name: s.name,
          layer: s.layer,
          path: s.path,
        })),
        installedSkills: [
          ...skills.user.map((s) => ({ name: s.name, layer: "user" as const })),
          ...skills.project.map((s) => ({ name: s.name, layer: "project" as const })),
          ...skills.local.map((s) => ({ name: s.name, layer: "local" as const })),
        ],
      });
      await replyMarketplace(requestId, view as unknown as Record<string, unknown>);
      return;
    }

    if (data.action === "approve") {
      const id = String(data.payload?.requestId || "");
      const a = marketplaceAsk.get(id);
      if (!a) {
        await replyMarketplace(requestId, { error: "ya resuelto" });
        return;
      }
      applyPatch(cwd, a.patch);
      const name = a.name;
      const action = a.action;
      settleAsk(id, { ok: true });
      await replyMarketplace(requestId, {
        ok: true,
        status: "applied",
        message:
          action === "install"
            ? marketplaceInstalled("mcp", name)
            : marketplaceUninstalled("mcp", name),
      });
      return;
    }

    if (data.action === "deny") {
      const id = String(data.payload?.requestId || "");
      const a = marketplaceAsk.get(id);
      if (!a) {
        await replyMarketplace(requestId, { error: "ya resuelto" });
        return;
      }
      settleAsk(id, { ok: false, error: MARKETPLACE_DENIED });
      await replyMarketplace(requestId, { ok: false, error: MARKETPLACE_DENIED });
      return;
    }

    const mode = data.executionMode === "plan" || data.executionMode === "auto" || data.executionMode === "ask"
      ? data.executionMode
      : "ask";
    const gate = gateMarketplaceWrite(mode, true);
    const op = data.action === "uninstall" ? "uninstall" : "install";
    const patch =
      op === "install"
        ? planMcpInstall(cwd, String(data.payload?.id || ""))
        : planMcpUninstall(cwd, String(data.payload?.name || ""));
    if ("error" in patch) {
      await replyMarketplace(requestId, { error: patch.error });
      return;
    }
    if (patch.action === "noop") {
      await replyMarketplace(requestId, {
        ok: true,
        status: "installed",
        message: marketplaceInstalled("mcp", String(data.payload?.id || data.payload?.name || "")),
      });
      return;
    }
    if (gate.decision === "deny") {
      await replyMarketplace(requestId, { error: gate.message });
      return;
    }
    if (gate.decision === "allow") {
      applyPatch(cwd, patch);
      await replyMarketplace(requestId, {
        ok: true,
        status: "applied",
        diff: patch.diff,
        message:
          op === "install"
            ? marketplaceInstalled("mcp", String(data.payload?.id))
            : marketplaceUninstalled("mcp", String(data.payload?.name)),
      });
      return;
    }

    // ask
    const askId = crypto.randomUUID();
    const deadline = new Date(Date.now() + ASK_APPROVAL_TIMEOUT_MS).toISOString();
    await client.request({
      type: "marketplace.install.ask",
      metadata: {
        requestId: askId,
        kind: "mcp",
        action: op,
        name: String(data.payload?.id || data.payload?.name || ""),
        path: patch.path,
        diff: patch.diff,
        approvalDeadline: deadline,
      },
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        marketplaceAsk.delete(askId);
        void replyMarketplace(requestId, { error: MARKETPLACE_DENIED });
        resolve();
      }, ASK_APPROVAL_TIMEOUT_MS);
      marketplaceAsk.set(askId, {
        requestId: askId,
        patch,
        action: op,
        name: String(data.payload?.id || data.payload?.name || ""),
        kind: "mcp",
        deadline: Date.now() + ASK_APPROVAL_TIMEOUT_MS,
        resolve: () => resolve(),
        timer,
      });
    });
  } catch (err) {
    await replyMarketplace(requestId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

El ask **no** escribe hasta `action === "approve"`. Headless **no** llama approve solo. Log `MARKETPLACE_ASK_WAITING` con `log(...)`.

El `client.request({ type: "marketplace.install.ask" })` puede no ser un type que el API acepte como request: en ese caso el daemon manda el ask **dentro** del `workspace.marketplace.result` con `{ status: "awaiting_approval", requestId: askId, diff, path, approvalDeadline }` y el API es quien hace broadcast `marketplace.install.ask`. **Prefiere este segundo camino** (un solo result): el daemon **nunca** inventa un type HTTP. Task 5 lee `status === "awaiting_approval"` y broadcast.

Simplifica el bloque ask a:

```ts
await replyMarketplace(requestId, {
  status: "awaiting_approval",
  askRequestId: askId,
  kind: "mcp",
  action: op,
  name: String(data.payload?.id || data.payload?.name || ""),
  path: patch.path,
  diff: patch.diff,
  approvalDeadline: deadline,
  message: MARKETPLACE_ASK_WAITING,
});
```

El Promise largo **no** es necesario: el install RPC retorna `awaiting_approval` al momento; approve es **otro** dispatch. Quita el `new Promise` y deja el Map hasta timeout:

```ts
const timer = setTimeout(() => {
  marketplaceAsk.delete(askId);
}, ASK_APPROVAL_TIMEOUT_MS);
marketplaceAsk.set(askId, { requestId: askId, patch, action: op, name: ..., kind: "mcp", deadline: Date.parse(deadline), resolve: () => {}, timer });
await replyMarketplace(requestId, { status: "awaiting_approval", askRequestId: askId, ... });
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/marketplace-fs.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/marketplace-fs.ts cli/src/llm/marketplace-fs.test.ts \
  cli/src/ws/daemon.ts
git commit -m "feat(marketplace): daemon writes .mcp.json only after mode gate"
```

---

## Task 5: API WS — snapshot mergeado, install/uninstall MCP, fan-out ask, CAS una a una

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Create: `api/src/ws/pending.ts` (solo si attach-files/git/rules/mcp **no** lo crearon)
- Test: `api/src/ws/marketplace-protocol.test.ts`
- Modify: `api/openapi/openapi.yaml`

- [ ] En `api/src/ws/protocol.ts` añadir campos opcionales si no están: `requestId?: string`, `action?: string`.

- [ ] Reusar `createPendingMap`. Timeout `MARKETPLACE_RPC_TIMEOUT_MS` (5000) para snapshot/install-auto. El ask **no** se espera en ese pending: el install retorna `awaiting_approval` en < 5s.

```ts
const marketplacePending = createPendingMap(5_000);
```

Si ya hay un mapa genérico, **no** dupliques la implementación; declara otro mapa o reusa el de mcp (ids UUID no colisionan). Un segundo `createPendingMap(5000)` llamado `marketplacePending` es lo más claro.

- [ ] En `agent.turn.request` **no** cambies el payload salvo que plan 19 ya meta `userSkills`: el siguiente turn debe incluir la skill recién instalada porque se lee `user_skills` **en el request**, no en caché del daemon. Verifica (comentario en el case) que el SELECT de `userSkills` no filtra `source`. Si alguien filtró `source = 'manual'`, **quítalo**.

- [ ] Cases nuevos en `handleWsMessage` (después de los de plan 19, no dentro de `default`):

```ts
case "workspace.marketplace.snapshot": {
  const workspaceId = requireWorkspace(connectionId);
  const { entries, errors } = loadOfficialCatalog();
  const skillRows = await db
    .select()
    .from(userSkills)
    .where(eq(userSkills.userId, userId));
  const userPart = mergeMarketplaceView({
    catalog: entries,
    catalogErrors: errors,
    installedSkills: skillRows.map((r) => ({
      name: r.name,
      layer: "user" as const,
      catalogId: r.catalogId,
    })),
  });
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) {
    return ok(type, id, {
      ...userPart,
      errors: [...userPart.errors, NO_DAEMON_ERROR],
      projectAvailable: false,
    });
  }
  const requestId = crypto.randomUUID();
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.marketplace.dispatch", {
      requestId,
      action: "snapshot",
      path: daemon.path,
      userSkills: skillRows.map((s) => ({
        name: s.name,
        description: s.description,
        body: s.body,
        enabled: s.enabled,
        catalogId: s.catalogId,
      })),
    }),
  );
  if (!sent) return fail(type, id, NO_DAEMON_ERROR);
  try {
    const data = await marketplacePending.wait(requestId);
    broadcast(userId, "marketplace.changed", { workspaceId, view: data });
    return ok(type, id, data);
  } catch (e) {
    return fail(type, id, e instanceof Error ? e.message : "timeout");
  }
}

case "workspace.marketplace.install": {
  const workspaceId = requireWorkspace(connectionId);
  const kind = String((msg.metadata as { kind?: string } | undefined)?.kind || msg.action || "");
  const catalogId = String((msg.metadata as { id?: string } | undefined)?.id || "");
  // Accept also top-level via protocol extension:
  const bodyKind = kind || String((msg as { kind?: string }).kind || "");
  const bodyId = catalogId || String((msg as { catalogId?: string }).catalogId || "");
  if (bodyKind === "skill") {
    // Delegate: same path as POST /marketplace/install. Do not spawn.
    // Inline the insert (do not HTTP-self): copy the handler body into a
    // function installUserSkill(userId, id) in api/src/routes/marketplace.ts and call it.
    return fail(type, id, "use POST /marketplace/install for skills");
  }
  if (bodyKind !== "mcp") return fail(type, id, MARKETPLACE_KIND_LAYER);
  const found = lookupOfficial(bodyId);
  if (!found.ok) return fail(type, id, found.error);
  if (found.entry.kind !== "mcp") return fail(type, id, found.error);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const pref = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const executionMode =
    pref[0] && (pref[0] as { activeExecutionMode?: string }).activeExecutionMode;
  const mode =
    executionMode === "plan" || executionMode === "auto" || executionMode === "ask"
      ? executionMode
      : "ask";
  const requestId = crypto.randomUUID();
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.marketplace.dispatch", {
      requestId,
      action: "install",
      path: daemon.path,
      executionMode: mode,
      payload: {
        id: found.entry.id,
        recipe: found.entry.recipe,
      },
    }),
  );
  if (!sent) return fail(type, id, NO_DAEMON_ERROR);
  try {
    const data = (await marketplacePending.wait(requestId)) as Record<string, unknown>;
    if (data?.status === "awaiting_approval") {
      broadcast(userId, "marketplace.install.ask", {
        workspaceId,
        ...data,
      });
      return ok(type, id, data);
    }
    if (data?.error) return fail(type, id, String(data.error));
    broadcast(userId, "marketplace.changed", { workspaceId, view: data });
    return ok(type, id, data);
  } catch (e) {
    return fail(type, id, e instanceof Error ? e.message : "timeout");
  }
}

case "workspace.marketplace.uninstall": {
  const workspaceId = requireWorkspace(connectionId);
  const bodyKind = String((msg as { kind?: string }).kind || (msg.metadata as { kind?: string } | undefined)?.kind || "");
  const name = String((msg as { name?: string }).name || (msg.metadata as { name?: string } | undefined)?.name || "");
  if (bodyKind === "skill") {
    return fail(type, id, "use POST /marketplace/uninstall for skills");
  }
  if (bodyKind !== "mcp" || !name) return fail(type, id, MARKETPLACE_KIND_LAYER);
  if (name === "chavez-git" || name === "chavez-skills") {
    return fail(type, id, `Cannot install or uninstall host MCP server "${name}"`);
  }
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const pref = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const executionMode =
    pref[0] && (pref[0] as { activeExecutionMode?: string }).activeExecutionMode;
  const mode =
    executionMode === "plan" || executionMode === "auto" || executionMode === "ask"
      ? executionMode
      : "ask";
  const requestId = crypto.randomUUID();
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.marketplace.dispatch", {
      requestId,
      action: "uninstall",
      path: daemon.path,
      executionMode: mode,
      payload: { name },
    }),
  );
  if (!sent) return fail(type, id, NO_DAEMON_ERROR);
  try {
    const data = (await marketplacePending.wait(requestId)) as Record<string, unknown>;
    if (data?.status === "awaiting_approval") {
      broadcast(userId, "marketplace.install.ask", { workspaceId, ...data });
      return ok(type, id, data);
    }
    if (data?.error) return fail(type, id, String(data.error));
    broadcast(userId, "marketplace.changed", { workspaceId, view: data });
    return ok(type, id, data);
  } catch (e) {
    return fail(type, id, e instanceof Error ? e.message : "timeout");
  }
}

case "workspace.marketplace.approve":
case "workspace.marketplace.deny": {
  const workspaceId = requireWorkspace(connectionId);
  const askRequestId = String(msg.requestId || (msg.metadata as { requestId?: string } | undefined)?.requestId || "");
  if (!askRequestId) return fail(type, id, "requestId is required");
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const requestId = crypto.randomUUID();
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.marketplace.dispatch", {
      requestId,
      action: type.endsWith("approve") ? "approve" : "deny",
      path: daemon.path,
      payload: { requestId: askRequestId },
    }),
  );
  if (!sent) return fail(type, id, NO_DAEMON_ERROR);
  try {
    const data = (await marketplacePending.wait(requestId)) as Record<string, unknown>;
    if (data?.error === "ya resuelto") return fail(type, id, "ya resuelto");
    if (data?.error) return fail(type, id, String(data.error));
    broadcast(userId, "marketplace.changed", { workspaceId, view: data });
    return ok(type, id, data);
  } catch (e) {
    return fail(type, id, e instanceof Error ? e.message : "timeout");
  }
}

case "workspace.marketplace.result": {
  if (!msg.requestId) return fail(type, id, "requestId is required");
  marketplacePending.settle(
    msg.requestId,
    msg.metadata ?? msg,
    (msg as { error?: string }).error,
  );
  return ok(type, id, { ok: true });
}
```

Extiende `ClientMessage` con `kind?: string`, `name?: string`, `catalogId?: string` **o** exige que todo vaya en `metadata` (`{ kind, id, name, requestId }`). Elige **metadata** y documenta en OpenAPI. Entonces el case lee solo `msg.metadata`. El snippet de `msg.kind` es fallback; el archivo real usa un helper:

```ts
function meta(msg: ClientMessage): Record<string, unknown> {
  return msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
}
```

`NO_DAEMON_ERROR` reusado. `userPreferences.activeExecutionMode` lo añade el plan 3; si la columna aún no existe, el mode cae a `"ask"` (default del plan 3).

CAS: el daemon Map borra el ask al primer approve/deny; el segundo recibe `ya resuelto`. El API **no** guarda el ask (el waiter vive en el daemon, igual que plan 13).

- [ ] Extrae `installKindLayerError(kind: string): string | null` (mcp debe ser WS, skill HTTP) y `hostProtected(name)`. Tests `api/src/ws/marketplace-protocol.test.ts` **sin** WS real:

  - `kind: "mcp"` en helper HTTP → `MARKETPLACE_KIND_LAYER`.
  - `hostProtected("chavez-skills")` → string host.
  - `lookupOfficial("nope")` error not found.
  - Un payload `status: "awaiting_approval"` se considera no-applied (el disco no cambia — eso es Task 4).

- [ ] Correr:

```bash
cd api && bun test src/ws/marketplace-protocol.test.ts src/llm/marketplace-no-runtime.test.ts
```

Esperado: todos pasan. El test de no-runtime **no** incluye `handlers.ts` (handlers sí reenvían recetas). Añade en `marketplace-no-runtime.test.ts`:

```ts
test("handlers do not import claude-agent-sdk for marketplace", () => {
  const text = readFileSync(join(import.meta.dir, "../../ws/handlers.ts"), "utf8");
  expect(text).not.toMatch(/createSdkMcpServer/);
});
```

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/handlers.ts api/src/ws/pending.ts \
  api/src/ws/marketplace-protocol.test.ts api/openapi/openapi.yaml
git commit -m "feat(ws): marketplace snapshot, gated MCP install, one-by-one ask"
```

---

## Task 6: CLI — `marketplace list|install|uninstall`, headless, watch

**Files:**

- Create: `cli/src/commands/marketplace.ts`
- Test: `cli/src/commands/marketplace-format.test.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/llm/watch-format.ts` **o** Create: `cli/src/llm/watch-format-marketplace.ts`
- Test: `cli/src/llm/watch-format-marketplace.test.ts`

- [ ] Crear `cli/src/commands/marketplace.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { ChavezWsClient } from "../ws/client";
import { cwdPath } from "../workspace";
import {
  MARKETPLACE_ASK_PROMPT,
  MARKETPLACE_ASK_WAITING,
  MARKETPLACE_KIND_LAYER,
} from "../llm/marketplace-constants";
import { formatMarketplaceList } from "../llm/marketplace-view";
import type { MarketplaceView } from "../llm/marketplace-constants";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

function usage(): never {
  throw new Error(
    "Uso: chavez marketplace list [--json]\n" +
      "     chavez marketplace install skill <id>\n" +
      "     chavez marketplace install mcp <id>\n" +
      "     chavez marketplace uninstall skill <name>\n" +
      "     chavez marketplace uninstall mcp <name>",
  );
}

export async function marketplaceCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "list" || !action) {
    const jsonFlag = rest.includes("--json");
    const data = await apiFetch<MarketplaceView>("/marketplace", {}, token());
    if (jsonFlag) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(formatMarketplaceList(data));
    return;
  }
  if (action === "install") {
    const kind = rest[0];
    const id = rest[1];
    if ((kind !== "skill" && kind !== "mcp") || !id) usage();
    if (kind === "skill") {
      const res = await apiFetch("/marketplace/install", {
        method: "POST",
        body: JSON.stringify({ kind: "skill", id }),
      }, token());
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    await marketplaceMcpRpc("install", { kind: "mcp", id });
    return;
  }
  if (action === "uninstall") {
    const kind = rest[0];
    const name = rest[1];
    if ((kind !== "skill" && kind !== "mcp") || !name) usage();
    if (kind === "skill") {
      const res = await apiFetch("/marketplace/uninstall", {
        method: "POST",
        body: JSON.stringify({ kind: "skill", name }),
      }, token());
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    await marketplaceMcpRpc("uninstall", { kind: "mcp", name });
    return;
  }
  usage();
}

async function marketplaceMcpRpc(
  op: "install" | "uninstall",
  metadata: Record<string, string>,
): Promise<void> {
  const t = token();
  const client = new ChavezWsClient(t);
  await client.connect();
  const path = cwdPath();
  const bound = await client.bind(path, "client");
  if (!bound.ok) {
    client.close();
    throw new Error(bound.error || "bind failed");
  }
  const type =
    op === "install" ? "workspace.marketplace.install" : "workspace.marketplace.uninstall";
  const res = await client.request({ type, metadata });
  if (!res.ok) {
    client.close();
    throw new Error(res.error || "marketplace rpc failed");
  }
  const data = (res.data || {}) as {
    status?: string;
    askRequestId?: string;
    diff?: string;
    message?: string;
    error?: string;
  };
  if (data.status === "awaiting_approval") {
    if (!process.stdin.isTTY) {
      console.error(MARKETPLACE_ASK_WAITING);
      console.error(data.diff || "");
      client.close();
      process.exitCode = 2;
      return;
    }
    console.log(data.diff || "");
    console.log(MARKETPLACE_ASK_PROMPT);
    const answer = await readYesNo();
    const decide = answer
      ? "workspace.marketplace.approve"
      : "workspace.marketplace.deny";
    const done = await client.request({
      type: decide,
      metadata: { requestId: data.askRequestId },
    });
    client.close();
    if (!done.ok) throw new Error(done.error || "ya resuelto");
    console.log(JSON.stringify(done.data, null, 2));
    return;
  }
  client.close();
  console.log(JSON.stringify(data, null, 2));
}

async function readYesNo(): Promise<boolean> {
  const buf = new Uint8Array(8);
  const n = await Bun.stdin.read(buf);
  const s = new TextDecoder().decode(buf.slice(0, n || 0)).trim().toLowerCase();
  return s === "y" || s === "yes";
}

void MARKETPLACE_KIND_LAYER;
```

`ChavezWsClient.request` ya existe; el payload `{ type, metadata }` debe coincidir con lo que el API espera (Task 5). `bind` con `clientKind: "client"` (no daemon). `formatMarketplaceList` ya está en Task 1.

- [ ] Extraer `parseMarketplaceArgs(args: string[])` puro a `cli/src/commands/marketplace-args.ts` (list/install/uninstall + kind + id) y testear en `marketplace-format.test.ts`:

  - `["list"]` → `{ action: "list" }`.
  - `["install", "skill", "commit"]` → ok.
  - `["install", "mcp"]` → usage throw.
  - `["uninstall", "mcp", "chavez-git"]` se parsea (el rechazo host es del API/daemon, no del parser).
  - `formatMarketplaceList` de un fixture origin `oficial` / `proyecto`.

- [ ] En `cli/src/index.ts`: `case "marketplace": await marketplaceCommand(rest);`. Usage: añadir las 5 líneas.

- [ ] En `cli/src/commands/headless.ts` grupo `marketplace`:

```
chavez headless marketplace list
chavez headless marketplace install skill <id>
chavez headless marketplace install mcp <id>
chavez headless marketplace uninstall skill <name>
chavez headless marketplace uninstall mcp <name>
```

Skill → HTTP (sin daemon). MCP → WS `clientKind: "client"` contra el daemon ya abierto; sin daemon → `NO_DAEMON_ERROR` tal cual. Headless **no** lee TTY para el ask: si `awaiting_approval`, imprime `MARKETPLACE_ASK_WAITING` y sale 2. Web/TUI/watch aprueban.

- [ ] Watch: si `cli/src/llm/watch-format.ts` existe, añadir:

```
marketplace.install.ask  →  marketplace · ask · write .mcp.json · {name}
marketplace.changed      →  marketplace · {op} · {name}
```

Si no existe, crear `cli/src/llm/watch-format-marketplace.ts` con `formatMarketplaceWatchLine(msg)` y llamarlo desde `headless.ts` `chat watch` **antes** del JSON genérico (igual que plan 19).

- [ ] Tests `watch-format-marketplace.test.ts`: ask line incluye `.mcp.json`; changed incluye el name.

- [ ] Correr:

```bash
cd cli && bun test src/commands/marketplace-format.test.ts \
  src/llm/watch-format-marketplace.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/commands/marketplace.ts cli/src/commands/marketplace-args.ts \
  cli/src/commands/marketplace-format.test.ts cli/src/index.ts \
  cli/src/commands/headless.ts cli/src/llm/watch-format.ts \
  cli/src/llm/watch-format-marketplace.ts cli/src/llm/watch-format-marketplace.test.ts
git commit -m "feat(cli): marketplace list/install/uninstall without spawning MCP"
```

---

## Task 7: TUI — overlay catálogo, origen, install/uninstall, tecla `K`

**Files:**

- Modify: `tui/src/App.tsx`
- Create: `tui/src/marketplace-overlay.ts` **o** reusar `cli/src/llm/marketplace-view.ts` (TUI ya importa CLI)
- Test: `tui/src/marketplace-overlay.test.ts`

- [ ] Añadir `"test": "bun test"` en `tui/package.json` si falta.

- [ ] Estado: `overlay: null | "skills" | "marketplace"` (si plan 19 ya tiene `"skills"`, **extiende** el union). `marketQuery: string`, `marketCursor: number`, `marketView: MarketplaceView | null`, `marketAsk: { askRequestId, name, diff, approvalDeadline } | null`.

- [ ] Tecla `K` en command mode (no compose). `k` sigue siendo skills (plan 19). `K` abre overlay marketplace:

  1. `GET /marketplace` vía `apiFetch` (oficial + user installed).
  2. `client.request({ type: "workspace.marketplace.snapshot" })` si bound; si falla con `NO_DAEMON_ERROR`, muestra el GET y una línea `proyecto: No daemon bound…`.
  3. Lista `filterMarketplaceRows(view.entries, marketQuery, 10)`.
  4. Cada fila: `{kind} · {origin} · {installed yes|no} · {name}`.
  5. Escribir refina `marketQuery` (afinar). Backspace borra. Flechas mueven cursor.
  6. Enter sobre una fila **no instalada** y `kind=skill` → `POST /marketplace/install`. `kind=mcp` → `workspace.marketplace.install`.
  7. Enter / tecla `x` sobre una **instalada** → uninstall del kind correspondiente.
  8. Si el RPC vuelve `awaiting_approval`, guarda `marketAsk` y muestra el diff + `y/n` (una a una, reusa el patrón de plan 13; **no** aprueba en lote).
  9. Escape cierra overlay o el ask (deny si hay ask). Escape **no** mata la TUI si plan 16 cambió Escape (cierra overlay primero).

- [ ] `onPush`: `marketplace.changed` recarga el overlay si está abierto. `marketplace.install.ask` abre el bloque y/n aunque el overlay no estuviera (el usuario pudo instalar desde Web). `y`/`n` en command mode cuando `marketAsk` está set envían approve/deny y **no** caen al ciclo de provider.

- [ ] Extraer `formatMarketplaceRow(row)` y `marketplaceOverlayTitle(view)` a `tui/src/marketplace-overlay.ts` (o CLI). Tests:

  - origin `oficial` / `proyecto` aparecen en el string.
  - `installed: false` muestra `no`.
  - filter `git` + limit 10.
  - host no está en un view construido con merge.

- [ ] Correr:

```bash
cd tui && bun test src/marketplace-overlay.test.ts
```

Si el helper vive en CLI: `cd cli && bun test src/llm/marketplace-view.test.ts` basta; el archivo TUI reexporta.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/marketplace-overlay.ts \
  tui/src/marketplace-overlay.test.ts tui/package.json
git commit -m "feat(tui): marketplace catalog overlay with origin and ask confirm"
```

---

## Task 8: Web — página `/marketplace`, origen, install/uninstall, confirm en ask

**Files:**

- Create: `web/src/lib/marketplace-display.ts`
- Test: `web/src/lib/marketplace-display.test.ts`
- Create: `web/src/components/MarketplacePanel.tsx`
- Create: `web/src/pages/marketplace.astro`
- Modify: `web/src/layouts/BaseLayout.astro`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/ws-hooks.ts` **o** el `onPush` de `MarketplacePanel` / `ChatDetailPanel.tsx`
- Modify: `web/package.json`

Web **no** importa `cli/`. Duplicar merge/filter/labels con comentario `// keep-in-sync with cli/src/llm/marketplace-view.ts`.

- [ ] Añadir `"test": "bun test"` en `web/package.json` si falta (dejar `dev`/`build`/`preview`).

- [ ] `web/src/lib/marketplace-display.ts`: copiar `MARKETPLACE_PICKER_LIMIT`, `formatMarketplaceRow`, `filterMarketplaceRows`, `originLabel` (`oficial` / `proyecto` / `usuario`). **No** copiar el catálogo: Web consume GET `/marketplace`.

```ts
export function formatMarketplaceRow(row: {
  kind: string;
  origin: string;
  installed: boolean;
  name: string;
}): string {
  return `${row.kind} · ${row.origin} · ${row.installed ? "instalado" : "disponible"} · ${row.name}`;
}

export function originBadgeClass(origin: string): string {
  if (origin === "oficial") return "ok";
  if (origin === "proyecto") return "";
  return "muted";
}
```

- [ ] Tests: `github` oficial no instalado; `echo` proyecto instalado; filter.

- [ ] `queryKeys.marketplace: ["marketplace"]`.

- [ ] `hooks.ts`:

  - `useMarketplace(enabled: boolean)` → `apiJson("/marketplace")`.
  - `useInstallSkill()` → `POST /marketplace/install` `{ kind: "skill", id }`, invalida `queryKeys.marketplace` y `queryKeys.skills` si existe.
  - `useUninstallSkill()` → `POST /marketplace/uninstall`.

MCP install/uninstall se hace con `useWs().request` desde el panel (no HTTP).

- [ ] `MarketplacePanel.tsx` (client:load):

  1. Tabla/lista: columnas Kind, Nombre, Origen (`<span className={badge}>`), Estado (instalado/disponible), Env requerido (solo nombres, **nunca** valores), acciones.
  2. Input filtro que afina (todas las coincidencias; no cap 10 en Web).
  3. Botón **Instalar** en filas `!installed`. Skill → POST. MCP → `ws.request({ type: "workspace.marketplace.install", metadata: { kind: "mcp", id } })`.
  4. Botón **Desinstalar** en filas instaladas. Host no se lista.
  5. Si MCP y no hay daemon: el request falla; mostrar el `NO_DAEMON_ERROR` tal cual (rojo). El catálogo oficial **sigue** visible.
  6. Si `status === "awaiting_approval"`: modal/panel con path `.mcp.json`, `<pre>{diff}</pre>`, botones **Aprobar** / **Denegar** (uno). Sin “siempre permitir”. Sin checkbox de lote.
  7. `onPush` `marketplace.install.ask` → mismo panel (otra superficie pudo disparar). `marketplace.changed` / `skills.updated` → `queryClient.invalidateQueries({ queryKey: queryKeys.marketplace })`.
  8. Errores 404/409/400 se muestran con el `error` del API, sin traducir.
  9. Copy: “Las skills oficiales se instalan en tu cuenta (siguientes turns). Los MCP oficiales se escriben en `.mcp.json` del workspace (el daemon los corre). La API no ejecuta MCP.”

- [ ] `pages/marketplace.astro`: layout + `<MarketplacePanel client:load />`. Title `Marketplace`.

- [ ] `BaseLayout.astro` nav: `<a href="/marketplace">Marketplace</a>` junto a Providers / Skills (si Skills existe).

- [ ] Correr:

```bash
cd web && bun test src/lib/marketplace-display.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add web/src/lib/marketplace-display.ts web/src/lib/marketplace-display.test.ts \
  web/src/components/MarketplacePanel.tsx web/src/pages/marketplace.astro \
  web/src/layouts/BaseLayout.astro web/src/lib/hooks.ts web/src/lib/query-keys.ts \
  web/src/lib/ws-hooks.ts web/src/components/ChatDetailPanel.tsx web/package.json
git commit -m "feat(web): marketplace catalog with origin and ask confirm for .mcp.json"
```

---

## Task 9: Smoke Gherkin — los cinco escenarios, nativas intactas, API sin runtime

**Files:**

- Create: `cli/src/llm/gherkin-marketplace.test.ts`
- Create: `cli/scripts/marketplace-smoke.ts`
- Modify: `cli/package.json` (script opcional `"test:marketplace-smoke": "bun run scripts/marketplace-smoke.ts"`)

No LLM vivo. Disco en tmp. El smoke **no** spawnea el server GitHub.

- [ ] `cli/src/llm/gherkin-marketplace.test.ts` — un `describe` por escenario:

**Listar**

- `mergeMarketplaceView({ catalog: loadOfficialCatalog().entries, installedMcp: [{ name: "echo", layer: "project", path: ".mcp.json" }] })`.
- Hay filas `origin === "oficial"` (github, sequential-thinking, commit, pr-review).
- Hay fila `echo` con `origin === "proyecto"`.
- `formatMarketplaceList` incluye `oficial` y `proyecto`.

**Instalar skill de usuario**

- `lookupOfficial("commit")` kind skill, body contiene `# Commit`.
- Simula el insert: `userSkillToSource({ name: "commit", description: "…", body, enabled: true })` (plan 19) → `layer === "user"`.
- `mergeSkillLayers({ user: [that], project: [], local: [] }).applied` contiene `commit`.
- `formatSkillsPrompt` menciona `commit`. Esto **es** “el siguiente turn puede usarla”: el dispatch del plan 19 inyecta `userSkills` y el loader las mergea. No hace falta `query()`.

**Instalar MCP de proyecto**

- tmp + `gateMarketplaceWrite("ask", true).decision === "ask"`.
- `gateMarketplaceWrite("auto", true).decision === "allow"`.
- `gateMarketplaceWrite("plan", true).message` exacto `MARKETPLACE_PLAN_DENIED`.
- `planMcpInstall(tmp, "github")` + `applyPatch` → `.mcp.json` con command `npx`.
- `loadMcpFromDisk(tmp).servers` tiene `github` layer project.
- El test **no** importa `child_process`.

**Desinstalar**

- Tras install github, `planMcpUninstall(tmp, "github")` + apply → `loadMcpFromDisk` ya no tiene `github`.
- `planMcpUninstall(tmp, "chavez-git")` error host.
- Nativas: si `cli/src/llm/tool-names.ts` exporta `DEFAULT_CLAUDE_TOOLS` / `canonicalToolName`, assert que `read/write/edit/grep/glob/bash` siguen. Si el export es del plan 2 (`NATIVE_TOOLS` / `DEFAULT_ALLOWED_TOOLS`), usa ese. Fallback:

```ts
const NATIVE = ["read", "write", "edit", "grep", "glob", "bash"];
for (const n of NATIVE) {
  expect(["read", "write", "edit", "grep", "glob", "bash"]).toContain(n);
}
```

Eso no demuestra nada. En su lugar, si existe `cli/src/llm/claude-runner.ts` / `tool-names.ts` con la lista, impórtala. Si el plan 2 dejó:

```ts
export const DEFAULT_CLAUDE_TOOLS = ["Read", "Write", "Edit", "Grep", "Glob", "Bash"];
```

assert `DEFAULT_CLAUDE_TOOLS` length 6 **después** de importar `marketplace-fs` (el módulo de uninstall no la muta).

```ts
import { DEFAULT_CLAUDE_TOOLS } from "./tool-names";
import "../llm/marketplace-fs";
expect(DEFAULT_CLAUDE_TOOLS).toEqual(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
```

Si el export tiene otro casing, **iguala el array real** del repo, no inventes otro. Host: `HOST_MCP_NAMES` de `mcp-constants.ts` sigue `chavez-git` y `chavez-skills`.

**Fallo de origen**

- `lookupOfficial("nope").error === "Marketplace entry not found: nope"`.
- `validateMarketplaceEntry({ ...github, recipe: { transport: "stdio", requiredEnv: [] } })` (sin command) no es null.
- `readFileSync` de `api/src/routes/marketplace.ts` (path relativo desde el monorepo: `join(import.meta.dir, "../../../api/src/routes/marketplace.ts")`) no contiene `child_process` ni `createSdkMcpServer`.
- `planMcpInstall` no llama spawn: spy innecesario; el módulo `marketplace-fs.ts` no importa `node:child_process`.

- [ ] `cli/scripts/marketplace-smoke.ts` (opcional, no LLM):

  1. `mkdtempSync`.
  2. Install github via `planMcpInstall` + apply.
  3. Print `loadMcpFromDisk` names.
  4. Uninstall.
  5. Exit 0. Exit 1 si github sigue en disk o si nativas faltan.

- [ ] Correr:

```bash
cd cli && bun test src/llm/gherkin-marketplace.test.ts \
  src/llm/marketplace-catalog.test.ts src/llm/marketplace-view.test.ts \
  src/llm/marketplace-mcp-json.test.ts src/llm/marketplace-gate.test.ts \
  src/llm/marketplace-fs.test.ts
cd api && bun test src/llm/marketplace-no-runtime.test.ts \
  src/llm/marketplace-catalog.test.ts
cd web && bun test src/lib/marketplace-display.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/gherkin-marketplace.test.ts cli/scripts/marketplace-smoke.ts \
  cli/package.json
git commit -m "test(marketplace): gherkin list/install/uninstall/origin without API runtime"
```

---

## Verificación rápida (orden)

1. Plan 19 aplicado (`user_skills`, `mcp-load`, `skills-load`). Si no, parar.
2. Tasks 1 → 9 en orden. Cada task deja tests verdes y un commit.
3. Manual mínimo (no sustituye tests):

```bash
# skill de usuario (sin daemon)
chavez marketplace install skill commit
chavez skills list
# debe listar commit; el siguiente `chavez headless chat ask` la inyecta (plan 19)

# MCP de proyecto (daemon bound, modo auto)
chavez mode auto
chavez headless workspace open
chavez marketplace install mcp github
test -f .mcp.json

# ask confirma
chavez mode ask
chavez marketplace install mcp sequential-thinking
# TTY: y/n; headless: exit 2 + MARKETPLACE_ASK_WAITING

# desinstalar
chavez marketplace uninstall mcp github
chavez marketplace uninstall skill commit

# fallo
chavez marketplace install skill nope   # 404 Marketplace entry not found: nope
```

Web: abrir `/marketplace`, ver columna origen, instalar `commit`, recargar `/skills`, disparar un turn, ver skill en timeline (plan 19). Instalar `github` en ask → diff `.mcp.json` → Aprobar. Quitar `github` → el siguiente turn no lista esa tool; Read sigue.

TUI: `K`, origen, Enter instala, `x` desinstala, `y/n` en ask.
