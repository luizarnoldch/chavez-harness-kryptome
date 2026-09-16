# Git workspace Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, slash `/git` (plan 11), undo del último turn (plan 12), cola de turns (plan 29), worktrees paralelos (plan 28), GitLab/Azure DevOps, ni force-push a `main`/`master`. Spec: [`plan.md`](./plan.md). Depende de tools ([`agent-tools`](../agent-tools/implementation.md)), modos ([`execution-modes`](../execution-modes/implementation.md)), approvals ([`approvals`](../approvals/implementation.md)), ignore/secrets ([`ignore-secrets`](../ignore-secrets/implementation.md)) y, si existe, `runGit`/`detectGit` de [`checkpoints-undo`](../checkpoints-undo/implementation.md). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario y el agente operan git del **cwd del daemon**: status (branch, ahead/behind, sucios), diff vs HEAD (distinto del diff-por-turn del plan 6), branch de trabajo, commit, push y PR en GitHub. El token vive en el **vault por usuario** (`provider = "github"`), nunca en el chat. Modo `ask` confirma commit/push/branch/PR una a una (mensaje + paths). Modo `plan` no muta git: responde un plan. Modo `auto` puede commitear/abrir PR **si el usuario lo pidió**. Sin `.git`, status/commit/PR se deshabilitan con mensaje y el agente **no finge** un commit. Web, TUI y CLI `watch` ven el mismo snapshot y la misma URL de PR.

**Architecture:** El filesystem y git viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** corre `git` ni habla con `api.github.com`: persiste el PAT cifrado, reenvía RPCs `workspace.git.*` al daemon bound y hace fan-out del snapshot / URL. Las tools del agente son un MCP in-process (`createSdkMcpServer` + `tool` del Claude Agent SDK). `canUseTool` aplica el modo **antes** de que el handler toque el repo. Bash `git …` se intercepta: no hay git opaco.

```
Composer / panel / CLI
        |
        |  status|diff  →  workspace.git.status|diff
        |  agent turn   →  agent.turn.request
        v
  API  hub.findDaemon
        |  no daemon → NO_DAEMON_ERROR
        v
  daemon  detectGit(cwd)
        |  !repo → NOT_A_GIT_REPO (UI disabled; tools error; no fake commit)
        |
        |  git_status / git_diff     → allow (todos los modos)
        |  git_branch/commit/push/pr
        |     plan → deny PLAN_GIT_DENIED (git log intacto)
        |     ask  → awaiting_approval { message, paths } → waitForApproval
        |            hasta approve, git log no cambia
        |     auto → allow + guardas (no force main, no secrets, no vault)
        |
        |  git_pr: GET /providers/github/credentials (user del daemon)
        |          404 → GITHUB_UNLINKED (no token in chat)
        |          push fail → error, PR no creado
        |          POST api.github.com/repos/{owner}/{repo}/pulls
        v
  chat.tool.* + workspace.git.snapshot + metadata.prUrl
        v
  Web GitPanel · TUI tecla g · CLI watch  (mismo contrato)
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y (tras planes 2–3) `permissionMode: "default"` + `canUseTool`. **No** hay MCP git. `tools`/`allowedTools` son las 6 de filesystem. Si aún está `bypassPermissions`, **no** volver a él: esta fase exige `default` para que el gate de git corra.
- `cli/src/llm/publish-turn.ts` emite `chat.tool.start` / `result`. No hay snapshot git de producto ni `prUrl`.
- `cli/src/ws/daemon.ts` atiende `agent.turn.dispatch` (y, si plan 3/13 aterrizó, approve/deny). **No** hay `workspace.git.*`.
- `api/src/routes/providers.ts` `ProviderId = "claude" | "cursor"`. `provider_credentials.provider` es `text` con unique `(userId, provider)` — **cabe `"github"` sin migración**. `PUT /providers/active` no debe aceptar github.
- `api/src/ws/handlers.ts` despacha `agent.turn.request`. Pending RPC: reusar `api/src/ws/pending.ts` (`createPendingMap`) si attach-files/undo lo creó.
- Web `ProvidersPanel.tsx` solo lista claude/cursor. `ChatDetailPanel.tsx` no tiene panel git.
- TUI `App.tsx`: teclas `p` `[` `]` `{` `}` `m`. **No** hay `g`.
- CLI: `chavez provider link claude|cursor`. **No** hay `github`. **No** hay `chavez headless git`.
- Cursor `runnable: false`. No simular git de Cursor. Cuando el plan 4 lo haga ejecutable, reutiliza el mismo MCP (host-side, no del provider).
- Plan 6 (`diffs-review`) es diff **por turn** (`streamId`). Este plan es `git diff HEAD` del working tree. Si el usuario editó a mano, **difieren**.
- Plan 8 exporta `gitCommitBlockedReason` / `assertCommitPathsAllowed` en `cli/src/llm/git-secret-guard.ts`. Llamarlo **antes** de `git commit`. Si el archivo no existe aún, crearlo aquí con el mismo API y los mismos strings.
- Plan 12 crea `cli/src/llm/git-exec.ts` + `git-detect.ts`. Reusar. Si no existen, crearlos con la misma firma (`runGit(cwd, args, envExtra?, timeoutMs?)`, `detectGit` → `{ isRepo, gitAvailable, headSha, branch }`).
- Plan 11 (`/git`) **no** se implementa: slash llamará el mismo `workspace.git.status`. Esta fase expone RPC + panel + `chavez headless git`.
- Undo (plan 12) **no** se implementa. Un commit de esta fase sí queda en `git log` (y undo posterior podría revertirlo; no es alcance).

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `provider_credentials` (sin migración; `provider = "github"`), Claude Agent SDK `query` + `createSdkMcpServer` + `tool` (`permissionMode: "default"`, `canUseTool`, `permissionPrompts: "host"`), git CLI en el daemon (`git -C <cwd>`), GitHub REST `fetch` (sin octokit), Ink TUI, Astro/React web. Sin paquete git.js / isomorphic-git / simple-git / `@octokit/rest`.

**Global Constraints:**

1. El filesystem y git se tocan **solo** en el daemon (cwd del workspace). API y browser no ejecutan `git`, no clonan, no firman commits, no llaman a `api.github.com`. El PAT se descifra en GET `/providers/github/credentials` y **solo** el daemon lo usa (push extraheader / POST pulls).
2. Sin daemon bound, `workspace.git.*` y `agent.turn.request` fallan con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Sin repo (`rev-parse --is-inside-work-tree` ≠ `true`) o sin binario git: status/commit/PR **deshabilitados**. Error exacto `NOT_A_GIT_REPO`. Tools git devuelven `isError` con ese string. **Cero** `git commit` inventado.
4. Lecturas git (`git_status`, `git_diff`) **nunca** piden confirmación, en ningún modo.
5. Mutaciones (`git_branch`, `git_commit`, `git_push`, `git_pr`):
   - `ask` → `awaiting_approval` con **mensaje + lista de paths** (commit) o remote/branch (push) o título (PR). Hasta approve, `git log` / remote / GitHub no cambian.
   - `auto` → ejecuta si el modelo invocó la tool (el preamble dice: solo si el usuario lo pidió). Siguen las guardas.
   - `plan` → deny `PLAN_GIT_DENIED`. Disco e historia intactos. El modelo escribe un plan de git.
6. Aprobaciones **una a una**. Sin lote ni “siempre permitir”. Reusar el waiter de plan 3/13 (`waitForApproval` / `agent.tool.approve`). El primero gana.
7. Guardas **en todos los modos** (también auto):
   - No `git push --force` / `-f` / `--force-with-lease` a `main` o `master`.
   - No commitear paths que `gitCommitBlockedReason` marque secret/vault (`.env`, keys, `.chavez/**`).
   - Un commit que incluye el vault se rechaza con `GIT_SECRET_COMMIT_DENIED`.
   - No commit directo en `main`/`master` salvo `allowProtected: true` **y** modo `ask` (el pedido lo muestra). En `auto`, deny `COMMIT_ON_PROTECTED` — el modelo crea una branch de trabajo primero.
8. Bash cuyo comando parsea como `git …` **no** se ejecuta. Deny `GIT_USE_DEDICATED_TOOLS` (o `FORCE_PUSH_PROTECTED` si es force a protegida). Así no hay git opaco ni bypass de guardas.
9. GitHub es el único host de PR de esta fase. Remote que no sea `github.com` → `PR_REQUIRES_GITHUB_REMOTE`. Push a un remote no-GitHub puede usar SSH local del daemon (sin PAT); si el remote rechaza, la tool queda `error` con el motivo y **no** se marca el PR creado.
10. Token de GitHub: vault **por `userId`**. El daemon de A usa el PAT de A. El de B no ve el de A (unique `(userId, provider)` + `eq(userId)`). Sin sesión: **401**. El token **nunca** viaja en `chat.tool.start` input, stream, ni watch (redact `ghp_` / `github_pat_` ya cubierto por plan 8/5).
11. 1 turn por daemon. `workspace.git.status` / `diff` (lecturas) **sí** pueden correr durante un turn (`GIT_OPTIONAL_LOCKS=0`). Mutaciones user-RPC (`commit`/`push`/`pr`/`branch`) con `turnBusy` fallan `TURN_BUSY_ERROR`.
12. Claude es el provider ejecutable. Cursor vinculado no ejecuta turns aquí; el MCP se registra en `runClaudeTurn`. El panel git (status del cwd) funciona igual porque es del daemon, no del LLM.
13. Web, TUI y CLI `watch` ven el mismo contrato: `workspace.git.snapshot` + tools canónicas `git_status|git_diff|git_branch|git_commit|git_push|git_pr` + `metadata.prUrl` cuando hay PR.
14. Diff vs HEAD ≠ diff-por-turn. El panel etiqueta el git diff como “vs HEAD”. No mezclar `turn_file_diffs`.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/git`, GitLab, force-push a main, cola, worktrees, CI GitHub Action.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NOT_A_GIT_REPO` | `"Workspace is not a git repository"` |
| `NOT_A_GIT_UI` | `"Este workspace no es un repo git — status, commit y PR están deshabilitados"` |
| `NO_FAKE_COMMIT` | `"Cannot commit: workspace is not a git repository"` |
| `GIT_MISSING` | `"git is not available on this daemon"` |
| `GITHUB_UNLINKED` | `"GitHub is not linked. Run: chavez provider link github"` |
| `GITHUB_UNLINKED_UI` | `"Vincula GitHub en el vault (CLI o /providers) para abrir un PR. No pegues el token en el chat."` |
| `PLAN_GIT_DENIED` | `"Plan mode: git commit/push/branch/PR are disabled. Switch to ask or auto to apply git changes."` |
| `COMMIT_ON_PROTECTED` | `"Refusing to commit on protected branch main/master — create a work branch first"` |
| `FORCE_PUSH_PROTECTED` | `"Force push to main/master is not allowed"` |
| `GIT_USE_DEDICATED_TOOLS` | `"Use git_status / git_diff / git_branch / git_commit / git_push / git_pr instead of bash git"` |
| `PR_REQUIRES_GITHUB_REMOTE` | `"Pull requests require a GitHub origin remote"` |
| `PUSH_REJECTED_PREFIX` | `"git push rejected: "` |
| `GIT_SECRET_COMMIT_DENIED` | `` `Refusing to commit secret path: ${path}` `` (mismo string que plan 8) |
| `PROTECTED_BRANCHES` | `["main", "master"]` |
| `GIT_MCP_SERVER` | `"chavez-git"` |
| `VAULT_GITHUB` | `"github"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `GIT_STATUS_TIMEOUT_MS` | `15_000` |
| `GIT_PUSH_TIMEOUT_MS` | `60_000` |
| `GIT_PR_TIMEOUT_MS` | `30_000` |
| `GIT_DIFF_MAX_CHARS` | `8000` |
| `GITHUB_API` | `"https://api.github.com"` |
| `GIT_PLAN_PREAMBLE` | `"You are in plan mode. You may inspect git status and git diff. Do not commit, push, create branches, or open PRs. Propose a concrete git plan the user can apply after switching to ask or auto."` |
| `GIT_AUTO_PREAMBLE` | `"Git tools are available. Only commit, push, or open a PR if the user asked. Never force-push to main/master. Never commit secrets, .env, or the Chavez vault (.chavez). If HEAD is main/master, create a work branch first."` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` / `ASK_APPROVAL_TIMEOUT_MS` / `GIT_CMD_TIMEOUT_MS` si ya existen; **no** cambiar esos strings. `GIT_SECRET_COMMIT_DENIED` debe ser bit-idéntico al de `cli/src/llm/git-secret-guard.ts` (plan 8).

Nombres canónicos (timeline; el PascalCase/MCP no es el único label):

| SDK `toolName` | Canónico |
|---|---|
| `git_status`, `mcp__chavez-git__git_status` | `git_status` |
| `git_diff`, `mcp__chavez-git__git_diff` | `git_diff` |
| `git_branch`, `mcp__chavez-git__git_branch` | `git_branch` |
| `git_commit`, `mcp__chavez-git__git_commit` | `git_commit` |
| `git_push`, `mcp__chavez-git__git_push` | `git_push` |
| `git_pr`, `mcp__chavez-git__git_pr` | `git_pr` |

Clases:

- **read:** `git_status`, `git_diff` (+ Read/Grep/Glob/LS existentes).
- **write (git):** `git_branch`, `git_commit`, `git_push`, `git_pr`.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `workspace.git.status` | cliente → API | Pedir snapshot. API espera al daemon. |
| `workspace.git.diff` | cliente → API | Pedir `git diff HEAD` (+ `--stat`). |
| `workspace.git.commit` | cliente → API | User-RPC commit (CLI). Guardas sí; **no** waiter de ask (el usuario ya lo pidió). |
| `workspace.git.push` | cliente → API | User-RPC push. |
| `workspace.git.pr` | cliente → API | User-RPC PR (título + body). |
| `workspace.git.branch` | cliente → API | User-RPC crear/checkout branch. |
| `workspace.git.dispatch` | API → daemon | `{ requestId, action, path, payload }` |
| `workspace.git.result` | daemon → API | Completa el pending. |
| `workspace.git.snapshot` | API → broadcast | `{ workspaceId, snapshot }` para que Web/TUI/watch coincidan. |
| `github.pr.created` | API → broadcast | `{ url, number, title, head, base }` — **después** de un PR real. Push error **no** lo emite. |

HTTP:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/providers` | Incluye `providers.github: { linked, authKind, label: "GitHub", runnable: false }`. **No** entra en `catalogs` LLM ni en `activeProvider`. |
| `PUT` | `/providers/github/credentials` | `{ authKind: "api_key", secret }` PAT. 401 sin sesión. |
| `GET` | `/providers/github/credentials` | Descifrado. 404 si no vinculado. 401 sin sesión. El daemon lo llama; Web Reveal existente. |
| `DELETE` | `/providers/github/credentials` | Unlink. |
| `PUT` | `/providers/active` | Sigue **solo** `claude` \| `cursor`. `github` → 400 `"provider must be claude or cursor"`. |

Sin tabla nueva. Sin migración Drizzle.

Tipos (congelados):

```ts
export const GIT_TOOL_IDS = [
  "git_status",
  "git_diff",
  "git_branch",
  "git_commit",
  "git_push",
  "git_pr",
] as const;
export type GitToolId = (typeof GIT_TOOL_IDS)[number];

export const GIT_READ_TOOLS: GitToolId[] = ["git_status", "git_diff"];
export const GIT_WRITE_TOOLS: GitToolId[] = [
  "git_branch",
  "git_commit",
  "git_push",
  "git_pr",
];

export type GitDirtyFile = {
  path: string;
  index: string;    // porcelain XY[0]
  worktree: string; // porcelain XY[1]
};

export type GitSnapshot = {
  isRepo: boolean;
  gitAvailable: boolean;
  message?: string;
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: GitDirtyFile[];
  protectedBranch: boolean;
};

export type GitHeadDiff = {
  isRepo: boolean;
  message?: string;
  unified: string;
  stat: string;
  paths: string[];
  truncated: boolean;
};

export type GitHubRemote = {
  owner: string;
  repo: string;
  host: "github.com";
  url: string;
};

export type GitPrResult = {
  url: string;
  number: number;
  title: string;
  head: string;
  base: string;
};
```

Approval prompt (metadata.prompt, plan 13) — **añadir** estos kinds, no reemplazar write/edit/bash:

```ts
type GitApprovalPrompt =
  | { kind: "git_commit"; message: string; paths: string[]; branch: string | null }
  | { kind: "git_push"; remote: string; branch: string | null; force: boolean }
  | { kind: "git_pr"; title: string; body: string; head: string; base: string }
  | { kind: "git_branch"; name: string; from: string | null };
```

---

## Task 1: Módulos puros — constantes, porcelain, bash git, guardas, nombres, prompt de ask

**Files:**

- Create: `cli/src/llm/git-constants.ts`
- Create: `cli/src/llm/git-names.ts`
- Create: `cli/src/llm/git-porcelain.ts`
- Create: `cli/src/llm/git-bash.ts`
- Create: `cli/src/llm/git-guard.ts`
- Create: `cli/src/llm/git-remote.ts`
- Create: `cli/src/llm/git-approval.ts`
- Test: `cli/src/llm/git-names.test.ts`
- Test: `cli/src/llm/git-porcelain.test.ts`
- Test: `cli/src/llm/git-bash.test.ts`
- Test: `cli/src/llm/git-guard.test.ts`
- Test: `cli/src/llm/git-remote.test.ts`
- Test: `cli/src/llm/git-approval.test.ts`
- Modify: `cli/package.json`

Sin I/O de red ni `git` spawn. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Tasks 4 y 7 duplican las constantes que pintan.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/git-constants.ts` con **exactamente** los strings de la tabla de constantes de arriba (`NOT_A_GIT_REPO`, `NOT_A_GIT_UI`, `NO_FAKE_COMMIT`, `GIT_MISSING`, `GITHUB_UNLINKED`, `GITHUB_UNLINKED_UI`, `PLAN_GIT_DENIED`, `COMMIT_ON_PROTECTED`, `FORCE_PUSH_PROTECTED`, `GIT_USE_DEDICATED_TOOLS`, `PR_REQUIRES_GITHUB_REMOTE`, `PUSH_REJECTED_PREFIX`, `PROTECTED_BRANCHES`, `GIT_MCP_SERVER`, `VAULT_GITHUB`, `GIT_STATUS_TIMEOUT_MS`, `GIT_PUSH_TIMEOUT_MS`, `GIT_PR_TIMEOUT_MS`, `GIT_DIFF_MAX_CHARS`, `GITHUB_API`, `GIT_PLAN_PREAMBLE`, `GIT_AUTO_PREAMBLE`).

Si `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` ya viven en `cli/src/llm/tool-names.ts` o `undo-constants.ts`, reexportarlos (mismo literal). Si `GIT_SECRET_COMMIT_DENIED` ya se construye en `git-secret-guard.ts`, **no** duplicar otro wording: exportar un helper:

```ts
export function gitSecretCommitDenied(path: string): string {
  return `Refusing to commit secret path: ${path}`;
}
```

- [ ] Crear `cli/src/llm/git-names.ts`:

```ts
import { GIT_MCP_SERVER } from "./git-constants";

export const GIT_TOOL_IDS = [
  "git_status",
  "git_diff",
  "git_branch",
  "git_commit",
  "git_push",
  "git_pr",
] as const;
export type GitToolId = (typeof GIT_TOOL_IDS)[number];

export const GIT_READ_TOOLS = new Set<GitToolId>(["git_status", "git_diff"]);
export const GIT_WRITE_TOOLS = new Set<GitToolId>([
  "git_branch",
  "git_commit",
  "git_push",
  "git_pr",
]);

export function gitSdkName(id: GitToolId): string {
  return `mcp__${GIT_MCP_SERVER}__${id}`;
}

export function parseGitSdkName(sdkName: string): GitToolId | null {
  if ((GIT_TOOL_IDS as readonly string[]).includes(sdkName)) {
    return sdkName as GitToolId;
  }
  const prefix = `mcp__${GIT_MCP_SERVER}__`;
  if (sdkName.startsWith(prefix)) {
    const rest = sdkName.slice(prefix.length);
    if ((GIT_TOOL_IDS as readonly string[]).includes(rest)) {
      return rest as GitToolId;
    }
  }
  return null;
}

export function gitToolClass(id: GitToolId): "read" | "write" {
  return GIT_READ_TOOLS.has(id) ? "read" : "write";
}

export function allowedGitMcpTools(): string[] {
  return [`mcp__${GIT_MCP_SERVER}`];
}

export type GitHubRemote = {
  owner: string;
  repo: string;
  host: "github.com";
  url: string;
};
```

- [ ] Crear `cli/src/llm/git-porcelain.ts` — parser de `git status --porcelain=v2 --branch` (y fallback v1 `XY path`). Extraer:

```ts
export function parsePorcelainV2(stdout: string): {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: Array<{ path: string; index: string; worktree: string }>;
} {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const dirty: Array<{ path: string; index: string; worktree: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const h = line.slice("# branch.head ".length).trim();
      if (h === "(detached)") {
        detached = true;
        branch = null;
      } else {
        branch = h || null;
      }
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = /# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const xy = line.slice(2, 4);
      const path = extractPorcelainPath(line);
      if (path) dirty.push({ path, index: xy[0] ?? ".", worktree: xy[1] ?? "." });
      continue;
    }
    if (line.startsWith("? ")) {
      dirty.push({ path: line.slice(2).trim(), index: "?", worktree: "?" });
    }
  }
  return { branch, detached, upstream, ahead, behind, dirty };
}

export function extractPorcelainPath(line: string): string | null {
  // v2: "1 XY ... TAB?path" or rename "2 XY ... TAB dest TAB src"
  const tab = line.indexOf("\t");
  if (tab >= 0) {
    const rest = line.slice(tab + 1);
    const dest = rest.split("\t")[0]?.trim();
    return dest || null;
  }
  const parts = line.split(/\s+/);
  return parts[parts.length - 1] || null;
}

export function parseDiffNameOnly(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isProtectedBranch(name: string | null | undefined): boolean {
  return name === "main" || name === "master";
}
```

- [ ] Crear `cli/src/llm/git-bash.ts` — clasificar un `Bash.command` para interceptar git opaco:

```ts
export type GitBashKind = "none" | "read" | "mutate" | "forbidden";

export type GitBashClass = {
  kind: GitBashKind;
  force: boolean;
  targetBranch: string | null;
  subcommand: string | null;
};

const READ_SUB = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "describe",
  "ls-files",
  "blame",
  "cat-file",
  "remote",
  "config",
]);

const MUTATE_SUB = new Set([
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "branch",
  "merge",
  "rebase",
  "cherry-pick",
  "stash",
  "reset",
  "revert",
  "tag",
  "clean",
  "mv",
  "rm",
  "restore",
  "worktree",
  "stash",
]);

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/);
}

/** First git invocation in a simple command (no pipes/and). */
export function classifyGitBash(command: string): GitBashClass {
  const empty: GitBashClass = {
    kind: "none",
    force: false,
    targetBranch: null,
    subcommand: null,
  };
  const raw = command.trim();
  if (!raw) return empty;
  if (/[|;&`$]/.test(raw) && /\bgit\b/.test(raw)) {
    // Opaque compound: treat as mutate so it cannot bypass guards via `git push --force`.
    if (/\bgit\s+push\b/.test(raw) && isForcePush(raw) && targetsProtected(raw)) {
      return { kind: "forbidden", force: true, targetBranch: "main", subcommand: "push" };
    }
    if (/\bgit\b/.test(raw)) {
      return { kind: "mutate", force: isForcePush(raw), targetBranch: null, subcommand: "compound" };
    }
    return empty;
  }
  const tokens = tokenize(raw);
  let i = 0;
  if (tokens[0] === "sudo") i += 1;
  if (tokens[i] !== "git") return empty;
  i += 1;
  while (tokens[i] && (tokens[i].startsWith("-") || tokens[i] === "-C")) {
    if (tokens[i] === "-C") i += 2;
    else i += 1;
  }
  const sub = tokens[i] || null;
  const rest = tokens.slice(i + 1).join(" ");
  const force = sub === "push" && isForcePush(rest);
  const target = pushDestBranch(tokens.slice(i + 1));
  if (force && isProtectedBranchName(target)) {
    return { kind: "forbidden", force: true, targetBranch: target, subcommand: "push" };
  }
  if (sub && READ_SUB.has(sub) && sub !== "remote" && sub !== "config") {
    return { kind: "read", force: false, targetBranch: target, subcommand: sub };
  }
  if (sub === "remote" || sub === "config") {
    const mutating = /\b(add|set-url|remove|rename|unset)\b/.test(rest);
    return {
      kind: mutating ? "mutate" : "read",
      force: false,
      targetBranch: null,
      subcommand: sub,
    };
  }
  if (sub && MUTATE_SUB.has(sub)) {
    return { kind: "mutate", force, targetBranch: target, subcommand: sub };
  }
  if (sub) return { kind: "mutate", force, targetBranch: target, subcommand: sub };
  return empty;
}

export function isForcePush(s: string): boolean {
  return /(?:^|\s)(--force|-f|--force-with-lease)(?:\s|$|=)/.test(s);
}

function isProtectedBranchName(name: string | null): boolean {
  return name === "main" || name === "master";
}

function targetsProtected(command: string): boolean {
  return /(^|\s)(origin\/)?(main|master)(\s|$)/.test(command);
}

function pushDestBranch(args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  // git push [<remote>] [<refspec>]
  if (positional.length >= 2) {
    const spec = positional[1];
    const dest = spec.includes(":") ? spec.split(":").pop() : spec;
    return dest || null;
  }
  return null;
}
```

- [ ] Crear `cli/src/llm/git-guard.ts`:

```ts
import {
  COMMIT_ON_PROTECTED,
  FORCE_PUSH_PROTECTED,
} from "./git-constants";
import { isProtectedBranch } from "./git-porcelain";

export function denyForcePushToProtected(input: {
  force: boolean;
  branch: string | null;
  refspec?: string | null;
}): string | null {
  if (!input.force) return null;
  const spec = input.refspec || "";
  const dest =
    (spec.includes(":") ? spec.split(":").pop() : spec) || input.branch;
  if (isProtectedBranch(dest) || isProtectedBranch(input.branch)) {
    return FORCE_PUSH_PROTECTED;
  }
  return null;
}

/** Auto (and plan) cannot commit on main/master. Ask may if allowProtected. */
export function denyCommitOnProtected(input: {
  branch: string | null;
  allowProtected: boolean;
  mode: "plan" | "auto" | "ask" | "user";
}): string | null {
  if (!isProtectedBranch(input.branch)) return null;
  if (input.mode === "user") return null; // CLI explícito del usuario
  if (input.mode === "ask" && input.allowProtected) return null;
  return COMMIT_ON_PROTECTED;
}

export function denyProtectedBranchName(name: string): string | null {
  if (isProtectedBranch(name)) {
    return COMMIT_ON_PROTECTED;
  }
  return null;
}

export function sanitizeWorkBranch(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const base = s || "work";
  if (isProtectedBranch(base)) return `chavez/${base}`;
  return base.startsWith("chavez/") ? base : `chavez/${base}`;
}
```

- [ ] Crear `cli/src/llm/git-remote.ts`:

```ts
import type { GitHubRemote } from "./git-names";
export type { GitHubRemote };

export function parseGitHubRemote(url: string): GitHubRemote | null {
  const u = url.trim().replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(u);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2], host: "github.com", url };
  }
  const sshAlt = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/.exec(u);
  if (sshAlt) {
    return { owner: sshAlt[1], repo: sshAlt[2], host: "github.com", url };
  }
  try {
    const parsed = new URL(u.includes("://") ? u : `https://${u}`);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }
    const parts = parsed.pathname.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1], host: "github.com", url };
  } catch {
    return null;
  }
}
```

Mover el type `GitHubRemote` a `git-names.ts` o dejarlo en `git-remote.ts` e importarlo. Un solo sitio.

- [ ] Crear `cli/src/llm/git-approval.ts`:

```ts
export type GitApprovalPrompt =
  | { kind: "git_commit"; message: string; paths: string[]; branch: string | null }
  | { kind: "git_push"; remote: string; branch: string | null; force: boolean }
  | { kind: "git_pr"; title: string; body: string; head: string; base: string }
  | { kind: "git_branch"; name: string; from: string | null };

export function gitApprovalPrompt(
  id: "git_commit" | "git_push" | "git_pr" | "git_branch",
  input: Record<string, unknown>,
  ctx: { branch: string | null } = { branch: null },
): GitApprovalPrompt {
  if (id === "git_commit") {
    const paths = Array.isArray(input.paths)
      ? input.paths.filter((p): p is string => typeof p === "string")
      : [];
    return {
      kind: "git_commit",
      message: String(input.message || ""),
      paths,
      branch: ctx.branch,
    };
  }
  if (id === "git_push") {
    return {
      kind: "git_push",
      remote: String(input.remote || "origin"),
      branch: ctx.branch,
      force: Boolean(input.force),
    };
  }
  if (id === "git_pr") {
    return {
      kind: "git_pr",
      title: String(input.title || ""),
      body: String(input.body || ""),
      head: String(input.head || ctx.branch || ""),
      base: String(input.base || "main"),
    };
  }
  return {
    kind: "git_branch",
    name: String(input.name || ""),
    from: ctx.branch,
  };
}

export function formatGitApproval(prompt: GitApprovalPrompt): string {
  if (prompt.kind === "git_commit") {
    const files = prompt.paths.length
      ? prompt.paths.map((p) => `  ${p}`).join("\n")
      : "  (all dirty paths after guards)";
    return `commit ${JSON.stringify(prompt.message)}\nbranch: ${prompt.branch || "?"}\npaths:\n${files}`;
  }
  if (prompt.kind === "git_push") {
    return `push ${prompt.remote} ${prompt.branch || "HEAD"}${prompt.force ? " --force" : ""}`;
  }
  if (prompt.kind === "git_pr") {
    return `PR ${prompt.head} → ${prompt.base}\n${prompt.title}`;
  }
  return `branch ${prompt.name} from ${prompt.from || "HEAD"}`;
}
```

- [ ] Tests (bun:test), mínimo:

  - `git-names`: `parseGitSdkName("mcp__chavez-git__git_commit") === "git_commit"`; read vs write.
  - `git-porcelain`: fixture `# branch.head main` + `# branch.ab +1 -2` + `1 M. ...\tfoo.ts` + `? untracked.md` → ahead 1, behind 2, dirty 2.
  - `git-bash`: `git status` → read; `git commit -m x` → mutate; `git push --force origin main` → forbidden; `echo hi` → none; `git push -f origin master` → forbidden; `git diff HEAD` → read.
  - `git-guard`: force+main → `FORCE_PUSH_PROTECTED`; commit on main auto → `COMMIT_ON_PROTECTED`; ask+allowProtected → null; `sanitizeWorkBranch("Hello World")` → `chavez/hello-world`.
  - `git-remote`: `nina.v@example.com:org/repo.git`, `https://github.com/org/repo.git` → owner/repo; `https://gitlab.com/org/repo` → null.
  - `git-approval`: commit prompt incluye mensaje y paths; `formatGitApproval` no incluye tokens.

- [ ] Correr:

```bash
cd cli && bun test src/llm/git-names.test.ts src/llm/git-porcelain.test.ts \
  src/llm/git-bash.test.ts src/llm/git-guard.test.ts src/llm/git-remote.test.ts \
  src/llm/git-approval.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/git-constants.ts cli/src/llm/git-names.ts \
  cli/src/llm/git-porcelain.ts cli/src/llm/git-bash.ts \
  cli/src/llm/git-guard.ts cli/src/llm/git-remote.ts \
  cli/src/llm/git-approval.ts \
  cli/src/llm/git-names.test.ts cli/src/llm/git-porcelain.test.ts \
  cli/src/llm/git-bash.test.ts cli/src/llm/git-guard.test.ts \
  cli/src/llm/git-remote.test.ts cli/src/llm/git-approval.test.ts \
  cli/package.json
git commit -m "feat(git): constants, porcelain parser, bash intercept, guards"
```

---

## Task 2: Git en el daemon — status, diff HEAD, branch, commit, push, PR

**Files:**

- Create: `cli/src/llm/git-exec.ts` (solo si plan 12 **no** lo creó; si existe, **extender** el timeout opcional ya documentado)
- Create: `cli/src/llm/git-detect.ts` (idem)
- Create: `cli/src/llm/git-secret-guard.ts` (solo si plan 8 **no** lo creó)
- Create: `cli/src/llm/git-status.ts`
- Create: `cli/src/llm/git-diff-head.ts`
- Create: `cli/src/llm/git-commit.ts`
- Create: `cli/src/llm/git-branch.ts`
- Create: `cli/src/llm/git-push.ts`
- Create: `cli/src/llm/git-pr.ts`
- Create: `cli/src/llm/git-format.ts`
- Test: `cli/src/llm/git-status.test.ts`
- Test: `cli/src/llm/git-diff-head.test.ts`
- Test: `cli/src/llm/git-commit.test.ts`
- Test: `cli/src/llm/git-branch.test.ts`
- Test: `cli/src/llm/git-push.test.ts`
- Test: `cli/src/llm/git-pr.test.ts`
- Test: `cli/src/llm/git-format.test.ts`

I/O local de git sobre dirs temporales. Red **solo** en `git-pr.ts` inyectando `fetchImpl` (tests no llaman a GitHub). **Prohibido:** `git reset --hard`, `git push --force` a main/master, `git commit --no-verify` por defecto.

- [ ] Si `cli/src/llm/git-exec.ts` no existe, crearlo **idéntico** al de checkpoints-undo Task 2 (`runGit`, `shaLine`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, timeout). Importar `GIT_CMD_TIMEOUT_MS` desde `undo-constants.ts` si existe; si no, definir `15_000` en `git-constants.ts` y usarlo. Firma:

```ts
export async function runGit(
  cwd: string,
  args: string[],
  envExtra?: Record<string, string | undefined>,
  timeoutMs?: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;
```

- [ ] Si `cli/src/llm/git-detect.ts` no existe, crearlo como en plan 12 (`detectGit` → `isRepo`, `gitAvailable`, `headSha`, `branch`, `gitDir`).

- [ ] Si `cli/src/llm/git-secret-guard.ts` no existe, crearlo con el API del plan 8:

```ts
export function gitCommitBlockedReason(cwd: string, relPath: string): string | null;
export function assertCommitPathsAllowed(cwd: string, paths: string[]): void;
```

Clasificación mínima si `loadIgnore` aún no existe: bloquear paths que matcheen `(^|/)\.env(\.|$)`, `/\.chavez\//`, `\.pem$`, `\.key$`, `id_rsa`, `credentials.json`. El string debe ser `Refusing to commit secret path: ${relPath}`. Cuando plan 8 aterrice, **su** implementación sustituye el cuerpo; no cambiar el string.

- [ ] Crear primero `cli/src/llm/git-format.ts` con los types `GitSnapshot`, `GitDirtyFile`, `GitHeadDiff` (el `formatGitSnapshot` se añade en el paso de display más abajo). `git-status.ts` importa esos types.

- [ ] Crear `cli/src/llm/git-status.ts`:

```ts
import { GIT_MISSING, NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { isProtectedBranch, parsePorcelainV2 } from "./git-porcelain";
import type { GitSnapshot } from "./git-format";

export async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const ident = await detectGit(cwd);
  if (!ident.gitAvailable) {
    return emptySnapshot({ gitAvailable: false, message: GIT_MISSING });
  }
  if (!ident.isRepo) {
    return emptySnapshot({ gitAvailable: true, message: NOT_A_GIT_REPO });
  }
  const st = await runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
  const parsed = parsePorcelainV2(st.ok ? st.stdout : "");
  return {
    isRepo: true,
    gitAvailable: true,
    branch: parsed.branch ?? ident.branch,
    detached: parsed.detached,
    headSha: ident.headSha,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirty: parsed.dirty,
    protectedBranch: isProtectedBranch(parsed.branch ?? ident.branch),
  };
}

function emptySnapshot(p: { gitAvailable: boolean; message: string }): GitSnapshot {
  return {
    isRepo: false,
    gitAvailable: p.gitAvailable,
    message: p.message,
    branch: null,
    detached: false,
    headSha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: [],
    protectedBranch: false,
  };
}
```

Exportar `GitSnapshot` / `GitDirtyFile` / `GitHeadDiff` desde `git-format.ts` (un solo módulo de tipos+display).

- [ ] Crear `cli/src/llm/git-diff-head.ts`:

```ts
import { GIT_DIFF_MAX_CHARS, GIT_MISSING, NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { parseDiffNameOnly } from "./git-porcelain";
import type { GitHeadDiff } from "./git-format";

export async function collectDiffVsHead(
  cwd: string,
  paths?: string[],
): Promise<GitHeadDiff> {
  const ident = await detectGit(cwd);
  if (!ident.gitAvailable) {
    return { isRepo: false, message: GIT_MISSING, unified: "", stat: "", paths: [], truncated: false };
  }
  if (!ident.isRepo) {
    return { isRepo: false, message: NOT_A_GIT_REPO, unified: "", stat: "", paths: [], truncated: false };
  }
  const pathArgs = paths?.length ? ["--", ...paths] : [];
  const diff = await runGit(cwd, ["diff", "HEAD", ...pathArgs]);
  const stat = await runGit(cwd, ["diff", "--stat", "HEAD", ...pathArgs]);
  const names = await runGit(cwd, ["diff", "--name-only", "HEAD", ...pathArgs]);
  const untracked = await runGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  let unified = diff.ok ? diff.stdout : diff.stderr;
  let truncated = false;
  if (unified.length > GIT_DIFF_MAX_CHARS) {
    unified =
      unified.slice(0, GIT_DIFF_MAX_CHARS) +
      `\n[truncated: showing ${GIT_DIFF_MAX_CHARS} of ${unified.length} chars]`;
    truncated = true;
  }
  const pathsOut = [
    ...parseDiffNameOnly(names.stdout),
    ...parseDiffNameOnly(untracked.stdout),
  ];
  return {
    isRepo: true,
    unified,
    stat: stat.ok ? stat.stdout : "",
    paths: [...new Set(pathsOut)],
    truncated,
  };
}
```

Este unificado es **vs HEAD** (index + worktree + untracked names). No leer `turn_file_diffs`.

- [ ] Crear `cli/src/llm/git-commit.ts`:

```ts
import { NO_FAKE_COMMIT, NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit, shaLine } from "./git-exec";
import { denyCommitOnProtected } from "./git-guard";
import { assertCommitPathsAllowed } from "./git-secret-guard";
import { collectGitSnapshot } from "./git-status";

export type CommitMode = "plan" | "auto" | "ask" | "user";

export async function commitWorkspace(input: {
  cwd: string;
  message: string;
  paths?: string[];
  allowProtected?: boolean;
  mode: CommitMode;
}): Promise<{ sha: string; branch: string | null; paths: string[] }> {
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) {
    throw new Error(ident.gitAvailable ? NOT_A_GIT_REPO : NO_FAKE_COMMIT);
  }
  const snap = await collectGitSnapshot(input.cwd);
  const protectedErr = denyCommitOnProtected({
    branch: snap.branch,
    allowProtected: Boolean(input.allowProtected),
    mode: input.mode,
  });
  if (protectedErr) throw new Error(protectedErr);

  const paths =
    input.paths?.length ? input.paths : snap.dirty.map((d) => d.path);
  if (!paths.length) {
    throw new Error("Nothing to commit");
  }
  assertCommitPathsAllowed(input.cwd, paths);

  const add = await runGit(input.cwd, ["add", "--", ...paths]);
  if (!add.ok) throw new Error(add.stderr || add.stdout || "git add failed");

  const msg = input.message.trim();
  if (!msg) throw new Error("Commit message is required");
  const committed = await runGit(input.cwd, ["commit", "-m", msg, "--", ...paths]);
  if (!committed.ok) {
    throw new Error(committed.stderr || committed.stdout || "git commit failed");
  }
  const shaRes = await runGit(input.cwd, ["rev-parse", "HEAD"]);
  const sha = shaLine(shaRes.stdout) || shaRes.stdout.trim();
  return { sha, branch: snap.branch, paths };
}
```

Nunca `git commit -a` sin lista. Nunca `--no-verify`. `assertCommitPathsAllowed` **antes** de `git add`.

- [ ] Crear `cli/src/llm/git-branch.ts`:

```ts
import { NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { denyProtectedBranchName } from "./git-guard";

export async function createWorkBranch(input: {
  cwd: string;
  name: string;
  checkout?: boolean;
}): Promise<{ branch: string; from: string | null }> {
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) throw new Error(NOT_A_GIT_REPO);
  const name = input.name.trim();
  if (!name) throw new Error("Branch name is required");
  const denied = denyProtectedBranchName(name);
  if (denied) throw new Error(denied);
  const from = ident.branch;
  const args =
    input.checkout === false
      ? ["branch", name]
      : ["switch", "-c", name];
  const r = await runGit(input.cwd, args);
  if (!r.ok) throw new Error(r.stderr || r.stdout || "git branch failed");
  const now = await detectGit(input.cwd);
  return { branch: now.branch || name, from };
}
```

`git switch -c` deja el cwd en esa branch. No se llama `main`/`master`.

- [ ] Crear `cli/src/llm/git-push.ts`:

```ts
import {
  GIT_PUSH_TIMEOUT_MS,
  PUSH_REJECTED_PREFIX,
  VAULT_GITHUB,
} from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { denyForcePushToProtected } from "./git-guard";
import { parseGitHubRemote } from "./git-remote";
import { collectGitSnapshot } from "./git-status";

export function githubExtraHeaderEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  };
}

export async function pushWorkspace(input: {
  cwd: string;
  remote?: string;
  force?: boolean;
  token?: string | null;
}): Promise<{ remote: string; branch: string | null; stdout: string }> {
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) throw new Error("Workspace is not a git repository");
  const snap = await collectGitSnapshot(input.cwd);
  const remote = input.remote || "origin";
  const forceErr = denyForcePushToProtected({
    force: Boolean(input.force),
    branch: snap.branch,
  });
  if (forceErr) throw new Error(forceErr);

  const args = ["push", "-u", remote, "HEAD"];
  if (input.force) args.splice(1, 0, "--force-with-lease");

  const url = await runGit(input.cwd, ["remote", "get-url", remote]);
  const gh = url.ok ? parseGitHubRemote(url.stdout.trim()) : null;
  const env =
    gh && input.token ? githubExtraHeaderEnv(input.token) : undefined;

  const r = await runGit(input.cwd, args, env, GIT_PUSH_TIMEOUT_MS);
  if (!r.ok) {
    throw new Error(`${PUSH_REJECTED_PREFIX}${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  return { remote, branch: snap.branch, stdout: r.stdout || r.stderr };
}
```

El PAT va en env de **un** spawn, no en `remote.url`, no en argv visible. `force` a main ya denegado. Si el remote rechaza (auth, non-fast-forward), el error incluye `PUSH_REJECTED_PREFIX` + motivo.

- [ ] Crear `cli/src/llm/git-pr.ts`:

```ts
import {
  GITHUB_API,
  GITHUB_UNLINKED,
  GIT_PR_TIMEOUT_MS,
  PR_REQUIRES_GITHUB_REMOTE,
} from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { parseGitHubRemote, type GitHubRemote } from "./git-remote";
import { pushWorkspace } from "./git-push";
import { collectGitSnapshot } from "./git-status";

export type GitPrResult = {
  url: string;
  number: number;
  title: string;
  head: string;
  base: string;
};

export async function resolveGitHubOrigin(cwd: string): Promise<GitHubRemote> {
  const url = await runGit(cwd, ["remote", "get-url", "origin"]);
  if (!url.ok) throw new Error(PR_REQUIRES_GITHUB_REMOTE);
  const gh = parseGitHubRemote(url.stdout.trim());
  if (!gh) throw new Error(PR_REQUIRES_GITHUB_REMOTE);
  return gh;
}

export async function createPullRequest(input: {
  cwd: string;
  title: string;
  body?: string;
  base?: string;
  token: string | null;
  fetchImpl?: typeof fetch;
}): Promise<GitPrResult> {
  if (!input.token) throw new Error(GITHUB_UNLINKED);
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) throw new Error("Workspace is not a git repository");
  const gh = await resolveGitHubOrigin(input.cwd);
  const snap = await collectGitSnapshot(input.cwd);
  const head = snap.branch;
  if (!head) throw new Error("Cannot open PR from a detached HEAD");
  const base = input.base || "main";

  await pushWorkspace({ cwd: input.cwd, token: input.token });

  const fetchImpl = input.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GIT_PR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${gh.owner}/${gh.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          "User-Agent": "chavez",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: input.title.trim(),
          body: input.body || "",
          head,
          base,
        }),
        signal: ac.signal,
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      html_url?: string;
      number?: number;
      title?: string;
      message?: string;
    };
    if (!res.ok || !json.html_url || !json.number) {
      throw new Error(json.message || `GitHub PR failed (${res.status})`);
    }
    return {
      url: json.html_url,
      number: json.number,
      title: json.title || input.title,
      head,
      base,
    };
  } finally {
    clearTimeout(t);
  }
}
```

Si `pushWorkspace` lanza, **no** se llama a GitHub. El caller no emite `github.pr.created`.

- [ ] Completar `cli/src/llm/git-format.ts` (types ya creados) con:

```ts
export function formatGitSnapshot(s: GitSnapshot): string {
  if (!s.isRepo) return s.message || "Workspace is not a git repository";
  const up =
    s.upstream != null ? `  ↑${s.ahead} ↓${s.behind}` : "";
  const lines = [`${s.branch || "(detached)"}${up}`];
  if (!s.dirty.length) {
    lines.push("clean");
  } else {
    for (const f of s.dirty) {
      lines.push(`${f.index}${f.worktree} ${f.path}`);
    }
  }
  return lines.join("\n");
}
```

- [ ] Tests con `mkdtempSync` + `git init` + `user.email`/`user.name`:

  1. Repo con un commit + archivo sucio → `collectGitSnapshot` tiene `isRepo`, `branch`, `dirty.length >= 1`.
  2. Dir sin `.git` → `isRepo: false`, `message === NOT_A_GIT_REPO`.
  3. Diff vs HEAD distinto de vacío con uncommitted; tras `commitWorkspace` el dirty se vacía y `git log -1 --pretty=%s` es el mensaje.
  4. `commitWorkspace` con path `.env` → throw `/secret path/`. **No** aparece en `git log`.
  5. En branch `main`, `commitWorkspace({ mode: "auto" })` → `COMMIT_ON_PROTECTED`; `git log` igual.
  6. `createWorkBranch({ name: "feat-x" })` → `detectGit.branch === "feat-x"`. `name: "main"` throw.
  7. `denyForcePushToProtected({ force: true, branch: "main" })` cubierto; `pushWorkspace({ force: true })` en main throw **antes** de spawn (spy opcional).
  8. `createPullRequest` con `fetchImpl` mock 201 `{ html_url, number }` y `pushWorkspace` mockeado o remote no-github → si origin no es GitHub, `PR_REQUIRES_GITHUB_REMOTE`. Con origin github y token null → `GITHUB_UNLINKED`. Con fetch 201 y push stub, no se marca PR si push throw: testear `createPullRequest` envolviendo push — si `pushWorkspace` falla, fetchImpl **no** se llama (pasar fetchImpl que `throw` si se invoca).

Para (8) sin red: hacer `origin` `https://github.com/acme/demo.git` (no hace fetch hasta POST). Stub `fetchImpl`. Para no pushear de verdad, extraer `pushThenPr` o mockear `pushWorkspace` vía parámetro `pushImpl` opcional:

```ts
pushImpl?: typeof pushWorkspace
```

En tests, `pushImpl` que lanza → fetch no se llama; `pushImpl` no-op + fetch 201 → PR url.

- [ ] Correr:

```bash
cd cli && bun test src/llm/git-status.test.ts src/llm/git-diff-head.test.ts \
  src/llm/git-commit.test.ts src/llm/git-branch.test.ts \
  src/llm/git-push.test.ts src/llm/git-pr.test.ts src/llm/git-format.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/git-exec.ts cli/src/llm/git-detect.ts \
  cli/src/llm/git-secret-guard.ts cli/src/llm/git-status.ts \
  cli/src/llm/git-diff-head.ts cli/src/llm/git-commit.ts \
  cli/src/llm/git-branch.ts cli/src/llm/git-push.ts \
  cli/src/llm/git-pr.ts cli/src/llm/git-format.ts \
  cli/src/llm/git-status.test.ts cli/src/llm/git-diff-head.test.ts \
  cli/src/llm/git-commit.test.ts cli/src/llm/git-branch.test.ts \
  cli/src/llm/git-push.test.ts cli/src/llm/git-pr.test.ts \
  cli/src/llm/git-format.test.ts
git commit -m "feat(git): daemon status, diff HEAD, commit, branch, push, PR"
```

---

## Task 3: MCP git tools + gate de modo + intercept de Bash + timeline

**Files:**

- Create: `cli/src/llm/git-mcp.ts`
- Create: `cli/src/llm/git-can-use.ts`
- Test: `cli/src/llm/git-can-use.test.ts`
- Test: `cli/src/llm/git-mcp.test.ts`
- Modify: `cli/src/llm/tool-names.ts`
- Modify: `cli/src/llm/tool-display.ts`
- Test: `cli/src/llm/tool-names.test.ts` (extender)
- Test: `cli/src/llm/tool-display.test.ts` (extender)
- Modify: `cli/src/llm/execution-gate.ts` (si existe; si no, `git-can-use.ts` es el gate)
- Test: `cli/src/llm/execution-gate.test.ts` (extender)
- Modify: `cli/src/llm/can-use-tool.ts` (si existe)
- Modify: `cli/src/llm/approval-prompt.ts` (si plan 13 lo creó; si no, el prompt git se arma en `publish-turn`)
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`

El MCP corre **en el proceso daemon**. `canUseTool` decide allow/deny/ask **antes** del handler. En ask, `git log` no cambia hasta approve.

- [ ] Extender `cli/src/llm/tool-names.ts`:

```ts
const CANONICAL: Record<string, CanonicalToolName> = {
  // …existentes…
  git_status: "git_status",
  git_diff: "git_diff",
  git_branch: "git_branch",
  git_commit: "git_commit",
  git_push: "git_push",
  git_pr: "git_pr",
};
```

En `canonicalToolName`, si `parseGitSdkName(sdkName)` retorna id, devolver ese id. No dejar `mcp__chavez-git__git_commit` como label de timeline.

- [ ] Extender `summarizeToolInput` en `cli/src/llm/tool-display.ts`:

  - `git_status` → `status`
  - `git_diff` → `diff HEAD` (+ path si hay)
  - `git_commit` → primeras 80 chars del `message` + `N paths` (nunca el PAT)
  - `git_push` → `push origin branch`
  - `git_pr` → `PR title`
  - `git_branch` → `branch name`

Si `input.token` / `authorization` aparecen, `sanitizeToolInput` ya los convierte en `***` (plan 2). Añadir keys `pat` / `github_token` al `SECRET_KEY_RE` si no están.

- [ ] Crear `cli/src/llm/git-can-use.ts`:

```ts
import { classifyGitBash } from "./git-bash";
import {
  FORCE_PUSH_PROTECTED,
  GIT_USE_DEDICATED_TOOLS,
  PLAN_GIT_DENIED,
} from "./git-constants";
import { gitToolClass, parseGitSdkName } from "./git-names";
import type { ExecutionMode } from "./execution-mode";

export type GitGate =
  | { decision: "allow" }
  | { decision: "deny"; message: string }
  | { decision: "ask" }
  | { decision: "passthrough" };

export function gateGitTool(
  mode: ExecutionMode,
  sdkName: string,
  toolInput: Record<string, unknown>,
): GitGate {
  if (sdkName === "Bash" || sdkName === "bash") {
    const cmd = String(toolInput.command || "");
    const g = classifyGitBash(cmd);
    if (g.kind === "none") return { decision: "passthrough" };
    if (g.kind === "forbidden") {
      return { decision: "deny", message: FORCE_PUSH_PROTECTED };
    }
    return { decision: "deny", message: GIT_USE_DEDICATED_TOOLS };
  }
  const id = parseGitSdkName(sdkName);
  if (!id) return { decision: "passthrough" };
  if (gitToolClass(id) === "read") return { decision: "allow" };
  if (mode === "plan") return { decision: "deny", message: PLAN_GIT_DENIED };
  if (mode === "auto") return { decision: "allow" };
  return { decision: "ask" };
}
```

Si `execution-mode.ts` no existe, definir `type ExecutionMode = "plan" | "auto" | "ask"` localmente y documentar que plan 3 lo unifica.

- [ ] En `cli/src/llm/execution-gate.ts` `gateClass` / `gateMutation`: **delegar primero** a `gateGitTool`. Si `passthrough`, seguir la lógica actual. No clasificar `mcp__chavez-git__git_commit` como `other` que en plan cae a write — debe ser git write con `PLAN_GIT_DENIED`, no `PLAN_MUTATION_DENIED` (el modelo tiene que oír “git”).

- [ ] En `cli/src/llm/can-use-tool.ts` `decideCanUseTool` (o el `canUseTool` inline de `claude-runner.ts` si el helper no existe): **después** de `denyIfEscapes` y **antes** del gate genérico:

```ts
const git = gateGitTool(input.executionMode, input.toolName, input.toolInput);
if (git.decision === "deny") return { behavior: "deny", message: git.message };
if (git.decision === "allow") return { behavior: "allow" };
if (git.decision === "ask") {
  // mismo waiter que Write: onAskPermission / waitForApproval
}
```

Tests `git-can-use.test.ts`:

  - `git_status` en plan/auto/ask → allow.
  - `git_commit` plan → deny `PLAN_GIT_DENIED`.
  - `git_commit` auto → allow.
  - `git_commit` ask → ask.
  - `mcp__chavez-git__git_pr` ask → ask.
  - Bash `git commit -m x` → deny `GIT_USE_DEDICATED_TOOLS`.
  - Bash `git push --force origin main` → deny `FORCE_PUSH_PROTECTED`.
  - Bash `ls` → passthrough.

- [ ] Crear `cli/src/llm/git-mcp.ts`:

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GIT_MCP_SERVER, GIT_PLAN_PREAMBLE } from "./git-constants";
import { collectGitSnapshot } from "./git-status";
import { collectDiffVsHead } from "./git-diff-head";
import { createWorkBranch } from "./git-branch";
import { commitWorkspace, type CommitMode } from "./git-commit";
import { pushWorkspace } from "./git-push";
import { createPullRequest } from "./git-pr";
import { formatGitSnapshot } from "./git-format";

export type GitMcpContext = {
  cwd: string;
  mode: CommitMode;
  getGitHubToken: () => Promise<string | null>;
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function createGitMcpServer(ctx: GitMcpContext) {
  return createSdkMcpServer({
    name: GIT_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Use these tools for git. Do not call bash git. Reads: git_status, git_diff. Mutations: git_branch, git_commit, git_push, git_pr.",
    tools: [
      tool("git_status", "Show branch, ahead/behind, and dirty files.", {}, async () => {
        const snap = await collectGitSnapshot(ctx.cwd);
        return textResult(formatGitSnapshot(snap), !snap.isRepo);
      }),
      tool(
        "git_diff",
        "Show git diff vs HEAD (working tree + index). Not the per-turn diff.",
        { paths: z.array(z.string()).optional() },
        async (args) => {
          const d = await collectDiffVsHead(ctx.cwd, args.paths);
          if (!d.isRepo) return textResult(d.message || "", true);
          return textResult([d.stat, d.unified].filter(Boolean).join("\n\n"));
        },
      ),
      tool(
        "git_branch",
        "Create a work branch and check it out. Not named main/master.",
        {
          name: z.string(),
          checkout: z.boolean().optional(),
        },
        async (args) => {
          try {
            const r = await createWorkBranch({
              cwd: ctx.cwd,
              name: args.name,
              checkout: args.checkout,
            });
            return textResult(`Now on ${r.branch} (from ${r.from || "?"})`);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_commit",
        "Commit the given paths with a message. Blocked on main/master in auto. Secrets/vault blocked.",
        {
          message: z.string(),
          paths: z.array(z.string()).optional(),
          allowProtected: z.boolean().optional(),
        },
        async (args) => {
          try {
            const r = await commitWorkspace({
              cwd: ctx.cwd,
              message: args.message,
              paths: args.paths,
              allowProtected: args.allowProtected,
              mode: ctx.mode,
            });
            return textResult(`commit ${r.sha} on ${r.branch}\n${r.paths.join("\n")}`);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_push",
        "Push HEAD to origin. No force-push to main/master.",
        {
          remote: z.string().optional(),
          force: z.boolean().optional(),
        },
        async (args) => {
          try {
            const token = await ctx.getGitHubToken();
            const r = await pushWorkspace({
              cwd: ctx.cwd,
              remote: args.remote,
              force: args.force,
              token,
            });
            return textResult(`pushed ${r.branch} → ${r.remote}\n${r.stdout}`);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_pr",
        "Push and open a GitHub pull request. Requires vault GitHub token. Never paste the token.",
        {
          title: z.string(),
          body: z.string().optional(),
          base: z.string().optional(),
        },
        async (args) => {
          try {
            const token = await ctx.getGitHubToken();
            const pr = await createPullRequest({
              cwd: ctx.cwd,
              title: args.title,
              body: args.body,
              base: args.base,
              token,
            });
            return textResult(`PR #${pr.number} ${pr.url}`, false);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
    ],
  });
}
```

`GIT_PLAN_PREAMBLE` no va en el MCP; va en el prompt del turn (abajo). Los handlers **sí** corren las guardas otra vez (cinturón si `canUseTool` se saltara un MCP).

- [ ] Test `git-mcp.test.ts`: no hace falta levantar el SDK. Testear que `createGitMcpServer` no lanza y que `commitWorkspace` en tmp (ya cubierto). Opcional: invocar el handler del tool si el objeto lo expone; si no, skip y cubrir vía `git-can-use` + Task 2.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. Importar `createGitMcpServer`, `allowedGitMcpTools`, `GIT_PLAN_PREAMBLE`, `GIT_AUTO_PREAMBLE`.
  2. Añadir a `RunClaudeTurnInput`: `getGitHubToken?: () => Promise<string | null>` y `executionMode` (si plan 3 no lo puso).
  3. Construir el server **por turn** (cierra sobre `cwd` + mode):

```ts
const gitServer = createGitMcpServer({
  cwd: input.cwd,
  mode: input.executionMode ?? "ask",
  getGitHubToken: input.getGitHubToken ?? (async () => null),
});
```

  4. `options.mcpServers = { [GIT_MCP_SERVER]: gitServer }` (merge con mcpServers existentes si plan 19 ya puso alguno: `{ ...existing, [GIT_MCP_SERVER]: gitServer }`).
  5. `allowedTools`: `[...DEFAULT_CLAUDE_TOOLS, ...allowedGitMcpTools()]`. Si `tools` ya se pasa, concatenar sin quitar Read/Write/….
  6. `permissionMode` permanece `"default"`. `canUseTool` llama `gateGitTool`.
  7. Prompt:

```ts
const extras =
  input.executionMode === "plan"
    ? GIT_PLAN_PREAMBLE
    : input.executionMode === "auto"
      ? GIT_AUTO_PREAMBLE
      : "";
const userPrompt = extras ? `${extras}\n\n${input.prompt}` : input.prompt;
```

Si ya se prepende `PLAN_MODE_PREAMBLE` (plan 3), **añadir** `GIT_PLAN_PREAMBLE` debajo, no sustituir el de filesystem.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. `getGitHubToken`:

```ts
async function getGitHubToken(token?: string): Promise<string | null> {
  try {
    const creds = await apiFetch<{ secret: string }>(
      "/providers/github/credentials",
      {},
      token,
    );
    return creds.secret || null;
  } catch {
    return null;
  }
}
```

  2. Pasarlo a `runClaudeTurn`. **Nunca** appendear el secret al user message ni a metadata.
  3. En `onAskPermission` (si existe): si `parseGitSdkName(toolName)` es write, `metadata.prompt = gitApprovalPrompt(id, toolInput, { branch })`. Cargar branch con `detectGit(cwd)` una vez (cache local del turn). El `awaiting_approval` **debe** incluir `message` + `paths` para commit (Gherkin).
  4. En `tool_result` de `git_pr`: si el output matchea `https://github.com/.*/pull/\d+`, poner `metadata.prUrl` en el `chat.tool.result`. Extraer helper `extractPrUrl(text: string): string | null`.
  5. Tras tool_result de cualquier git write, no hace falta RPC extra: los clientes refrescan snapshot al ver el tool (Tasks 5–7).

- [ ] Si `cli/src/llm/approval-prompt.ts` existe, añadir los kinds git al union `ApprovalPrompt` y a `buildApprovalPrompt`. Si no, el objeto vive en `metadata.prompt` desde publish-turn.

- [ ] Correr:

```bash
cd cli && bun test src/llm/git-can-use.test.ts src/llm/git-names.test.ts \
  src/llm/tool-names.test.ts src/llm/tool-display.test.ts \
  src/llm/execution-gate.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/git-mcp.ts cli/src/llm/git-can-use.ts \
  cli/src/llm/git-can-use.test.ts cli/src/llm/git-mcp.test.ts \
  cli/src/llm/tool-names.ts cli/src/llm/tool-display.ts \
  cli/src/llm/tool-names.test.ts cli/src/llm/tool-display.test.ts \
  cli/src/llm/execution-gate.ts cli/src/llm/execution-gate.test.ts \
  cli/src/llm/can-use-tool.ts cli/src/llm/approval-prompt.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts
git commit -m "feat(git): MCP git tools, mode gate, bash intercept"
```

---

## Task 4: API — vault GitHub por usuario, RPC `workspace.git.*`, fan-out, 401

**Files:**

- Modify: `api/src/db/schema.ts` (solo comentario de `provider`; **sin migración**)
- Modify: `api/src/routes/providers.ts`
- Test: `api/src/routes/providers-github.test.ts`
- Create: `api/src/llm/git-constants.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/pending.ts` (crear si no existe, idéntico a attach-files)
- Test: `api/src/ws/pending.test.ts` (si se crea)
- Modify: `api/src/index.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `api/package.json`

La API no corre git. Sí: guarda el PAT cifrado por `userId`, reenvía al daemon, completa pending, broadcast snapshot/PR.

- [ ] Añadir `"test": "bun test"` en `api/package.json` si falta.

- [ ] En `api/src/db/schema.ts`, actualizar el comentario de `provider` a `claude | cursor | github`. No cambiar columnas.

- [ ] Copiar a `api/src/llm/git-constants.ts` los strings que la API/UI comparte: `NOT_A_GIT_REPO`, `NOT_A_GIT_UI`, `GITHUB_UNLINKED`, `GITHUB_UNLINKED_UI`, `NO_DAEMON_ERROR`, `TURN_BUSY_ERROR`, `VAULT_GITHUB`. Mismos literales.

- [ ] En `api/src/routes/providers.ts`:

```ts
export type LlmProviderId = "claude" | "cursor";
export type VaultProviderId = LlmProviderId | "github";

const LLM_PROVIDERS: LlmProviderId[] = ["claude", "cursor"];
const VAULT_PROVIDERS: VaultProviderId[] = ["claude", "cursor", "github"];

function isLlmProvider(v: string): v is LlmProviderId {
  return LLM_PROVIDERS.includes(v as LlmProviderId);
}
function isVaultProvider(v: string): v is VaultProviderId {
  return VAULT_PROVIDERS.includes(v as VaultProviderId);
}
```

  1. `PUT /:provider/credentials`, `GET`, `DELETE`: validar con `isVaultProvider`. 404 `"Unknown provider"` si no.
  2. `GET /`: construir `providers` para **vault** ids. Claude/cursor siguen con catalog/runnable/models. GitHub:

```ts
github: {
  linked: Boolean(row),
  authKind: row?.authKind,
  updatedAt: row?.updatedAt,
  label: "GitHub",
  runnable: false,
  models: [],
}
```

  3. `PUT /preferences` y `PUT /active`: `isLlmProvider` únicamente. `github` → 400 `"provider must be claude or cursor"`.
  4. Al vincular github, **no** llamar `upsertPrefs({ activeProvider: "github" })`. El auto-active actual (`if (!prefs[0]?.activeProvider)`) debe quedar restringido a `isLlmProvider(providerParam)`.
  5. `GET /:provider/credentials` sigue exigiendo sesión (`requireSession` → 401). El row se filtra `eq(userId)`. Usuario B no lee el ciphertext de A.

- [ ] Test `api/src/routes/providers-github.test.ts` de las funciones extraídas (`isVaultProvider("github") === true`, `isLlmProvider("github") === false`). Extraer esas guards a `api/src/routes/provider-ids.ts` para testearlas sin Hono si hace falta.

- [ ] En `api/src/index.ts` `GET /providers/link`: aceptar `provider=github` además de claude/cursor (redirect a `${web}/providers?provider=github`). Hoy `provider !== "claude" && !== "cursor"` → 404.

- [ ] En `api/src/ws/protocol.ts` `ClientMessage` añadir (dejar existentes):

```ts
  action?: "status" | "diff" | "commit" | "push" | "pr" | "branch";
  requestId?: string;
  message?: string;
  paths?: string[];
  title?: string;
  body?: string;
  base?: string;
  name?: string;
  remote?: string;
  force?: boolean;
```

Mismos campos en `cli/src/ws/client.ts` `WsRequest` y `web/src/lib/ws-client.ts` `WsRequest`.

- [ ] Pending: si `api/src/ws/pending.ts` no existe, crearlo idéntico a attach-files (`createPendingMap`). En handlers:

```ts
const gitPending = createPendingMap(30_000);
```

No reusar el mapa de `fs.complete` (timeout 5s es corto para push/PR).

- [ ] En `api/src/ws/handlers.ts`, helper:

```ts
async function forwardGit(
  connectionId: string,
  userId: string,
  id: string,
  type: string,
  action: NonNullable<ClientMessage["action"]>,
  msg: ClientMessage,
): Promise<ServerMessage> {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const conn = hub.get(connectionId);
  const mutate = action === "commit" || action === "push" || action === "pr" || action === "branch";
  if (mutate && (daemon as { turnBusy?: boolean }).turnBusy) {
    return fail(type, id, TURN_BUSY_ERROR);
  }
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.git.dispatch", {
      requestId: id,
      action,
      path: daemon.path || conn?.path,
      workspaceId,
      payload: {
        message: msg.message || msg.title,
        paths: msg.paths,
        title: msg.title,
        body: msg.body || msg.content,
        base: msg.base,
        name: msg.name,
        remote: msg.remote,
        force: msg.force,
        allowProtected: msg.metadata?.allowProtected === true,
      },
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return gitPending.wait(id, type);
}
```

Cases **antes** de `default`:

  - `workspace.git.status` → `forwardGit(..., "status")`
  - `workspace.git.diff` → `"diff"`
  - `workspace.git.commit` → `"commit"` (requiere `msg.message` o `msg.content`)
  - `workspace.git.push` → `"push"`
  - `workspace.git.pr` → `"pr"` (requiere `msg.title`)
  - `workspace.git.branch` → `"branch"` (requiere `msg.name`)
  - `workspace.git.result` (lo manda el daemon): `requestId` obligatorio. `gitPending.complete(requestId, ok(originalType, requestId, msg.metadata || data))`. Si `metadata.snapshot`, broadcast `workspace.git.snapshot` `{ workspaceId, snapshot }` a todos los sockets del user. Si `metadata.pr` con `url`, broadcast `github.pr.created` **solo** si `ok !== false` y hay url. Responder al daemon `{ forwarded: true }`. Si `metadata.error`, `complete` con `fail` y **no** emitir `github.pr.created`.

Sin sesión el WS ni llega (upgrade 401 en `api/src/index.ts` `resolveWsUserId`). Eso cubre “sin sesión, 401”.

- [ ] OpenAPI: en tag Providers, documentar `github` como vault no-LLM. En tag WebSocket, listar `workspace.git.status|diff|commit|push|pr|branch` y push events `workspace.git.snapshot`, `github.pr.created`. Ejemplo 401 en GET credentials.

- [ ] Correr:

```bash
cd api && bun test src/routes/providers-github.test.ts src/ws/pending.test.ts
```

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/src/routes/providers.ts \
  api/src/routes/provider-ids.ts api/src/routes/providers-github.test.ts \
  api/src/llm/git-constants.ts api/src/ws/protocol.ts \
  api/src/ws/handlers.ts api/src/ws/pending.ts api/src/ws/pending.test.ts \
  api/src/index.ts api/openapi/openapi.yaml api/package.json \
  cli/src/ws/client.ts web/src/lib/ws-client.ts
git commit -m "feat(git): GitHub vault per user and workspace.git RPC"
```

---

## Task 5: Daemon handler + CLI `provider link github` + `headless git` + watch

**Files:**

- Create: `cli/src/llm/handle-git-rpc.ts`
- Test: `cli/src/llm/handle-git-rpc.test.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/commands/provider.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (si no existe, crear casos git)
- Test: `cli/src/llm/watch-format.test.ts`

- [ ] Crear `cli/src/llm/handle-git-rpc.ts` — dispatch de `action` a las funciones de Task 2. Firma:

```ts
export async function runGitAction(input: {
  cwd: string;
  action: "status" | "diff" | "commit" | "push" | "pr" | "branch";
  payload: Record<string, unknown>;
  getGitHubToken: () => Promise<string | null>;
}): Promise<{ ok: boolean; snapshot?: GitSnapshot; diff?: GitHeadDiff; pr?: GitPrResult; error?: string; result?: unknown }>;
```

  - `status` → `{ ok, snapshot }`
  - `diff` → `{ ok, diff, snapshot }`
  - `commit` → `commitWorkspace({ mode: "user", ... })` luego snapshot
  - `branch` → `createWorkBranch` luego snapshot
  - `push` → token + `pushWorkspace` (error `PUSH_REJECTED_PREFIX`, `ok: false`)
  - `pr` → token null → `{ ok: false, error: GITHUB_UNLINKED }`; push fail → no `pr`; success → `{ ok, pr, snapshot }`

Catch: `{ ok: false, error: message }`. Nunca throw al caller del WS.

- [ ] Test: tmp repo status ok; no-git status `error === NOT_A_GIT_REPO`; commit user mode en main **permitido** (CLI explícito); `.env` commit fail.

- [ ] En `cli/src/ws/daemon.ts` `onPush`, **antes** del early-return de dispatch:

```ts
if (msg.type === "workspace.git.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    action?: string;
    path?: string;
    payload?: Record<string, unknown>;
  };
  const result = await runGitAction({
    cwd: data.path || path,
    action: data.action as "status",
    payload: data.payload || {},
    getGitHubToken: async () => {
      try {
        const creds = await apiFetch<{ secret: string }>(
          "/providers/github/credentials",
          {},
          config.accessToken,
        );
        return creds.secret;
      } catch {
        return null;
      }
    },
  });
  await client.request({
    type: "workspace.git.result",
    requestId: data.requestId,
    metadata: result as unknown as Record<string, unknown>,
    status: result.ok ? "done" : "error",
  });
  return;
}
```

Importar `apiFetch`. El token **no** se loguea.

- [ ] En `cli/src/commands/provider.ts`:

  - `ProviderId = "claude" | "cursor" | "github"`
  - `parseProvider` acepta `github`.
  - `parseLlmProvider` (claude|cursor) para `set`.
  - `case "link"`: `github` → `promptSecret("Pega tu GitHub PAT (ghp_ / github_pat_…): ")` + `saveCredentials("github", "api_key", secret)`. Flag `--web` abre `${apiUrl}/providers/link?provider=github&token=`.
  - `set github` → throw `"provider must be claude or cursor"`.
  - Usage string actualizado.
  - `list`: imprime `- github: linked|not linked` junto a claude/cursor.

- [ ] En `cli/src/index.ts` `usage()`: añadir `chavez provider link github` y `chavez headless git status|diff|commit|push|pr|branch`.

- [ ] En `cli/src/commands/headless.ts`, grupo `git` (después de `chat`):

```
chavez headless git status
chavez headless git diff
chavez headless git commit -m "<msg>" [--] [paths…]
chavez headless git branch <name>
chavez headless git push
chavez headless git pr --title "<t>" [--body "<b>"] [--base main]
```

Usa `ensureClient()` y `client.request({ type: "workspace.git.status" | ... })` con timeout 60s para push/pr. Imprime `formatGitSnapshot` / unified / PR url. Si `!ok`, `throw new Error(res.error)`.

- [ ] Extender `cli/src/llm/watch-format.ts`:

```ts
if (msg.type === "workspace.git.snapshot") {
  const snap = rec(data.snapshot) ?? rec(data);
  if (!snap) return null;
  if (snap.isRepo === false) return `git · ${String(snap.message || "not a repo")}`;
  const dirty = Array.isArray(snap.dirty) ? snap.dirty.length : 0;
  return `git · ${String(snap.branch || "detached")} ↑${snap.ahead ?? 0} ↓${snap.behind ?? 0}  dirty=${dirty}`;
}
if (msg.type === "github.pr.created") {
  const url = String(data.url || "");
  return url ? `git · pr ${url}` : null;
}
```

En `chat.tool.result`, si `canonicalToolName === "git_pr"` y `metadata.prUrl`, línea extra `git · pr ${prUrl}`. Test: snapshot dirty, PR url, tool git_commit done, no volcar el PAT si viniera en input (redact).

- [ ] Correr:

```bash
cd cli && bun test src/llm/handle-git-rpc.test.ts src/llm/watch-format.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/handle-git-rpc.ts cli/src/llm/handle-git-rpc.test.ts \
  cli/src/ws/daemon.ts cli/src/commands/provider.ts \
  cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts
git commit -m "feat(git): daemon RPC, GitHub vault CLI, headless git, watch"
```

---

## Task 6: TUI — tecla `g`, panel status/diff, disabled sin repo, PR URL en vivo

**Files:**

- Modify: `tui/src/App.tsx`

TUI es daemon: ejecuta `runGitAction` **y** pinta. No importa API para git spawn.

- [ ] State nuevo:

```ts
type GitPanel = {
  open: boolean;
  snapshot: GitSnapshot | null;
  diff: string | null;
  error: string | null;
  prUrl: string | null;
};
```

- [ ] `refreshGit` llama `collectGitSnapshot(cwd)` + opcional `collectDiffVsHead` **directo** (mismo proceso). Si el panel se abrió vía RPC de otro cliente, también escuchar `workspace.git.snapshot` y `github.pr.created`.

- [ ] En el `onPush` existente:
  - `workspace.git.dispatch` → `runGitAction` + `workspace.git.result` (igual que daemon.ts). Extraer no es obligatorio si TUI ya comparte `handle-git-rpc`. **Sí** importar `runGitAction` para no divergir.
  - `workspace.git.snapshot` → set snapshot (paridad con Web).
  - `github.pr.created` / `chat.tool.result` con `prUrl` → `setGitPanel(p => ({...p, prUrl}))`.
  - `chat.tool.update` awaiting git_commit: el banner `[y]/[n]` de plan 13 ya muestra `metadata.prompt`. Si el banner existe, no duplicar; si no hay approvals aún, mostrar `formatGitApproval` en `log`.

- [ ] Tecla `g` en command mode (no compose, no busy-block para **abrir** el panel: status es lectura). Si `!snapshot.isRepo`, `setLog(NOT_A_GIT_UI)` y el panel lista el mensaje, **sin** acciones commit/PR.

- [ ] Render: columna o overlay bajo el timeline:

```
git  main  ↑1 ↓0
  M src/a.ts
  ?? new.ts
pr  https://github.com/org/repo/pull/12
```

Si `open` y se pidió diff (`G` mayúscula o segunda `g` cicla status/diff), mostrar `diff` truncado a 40 líneas.

- [ ] Footer help: añadir `g git`. No reusar `q` / Escape (Escape sigue saliendo — no lo cambies; plan 16/12 son otras teclas).

- [ ] Tras un `git_commit` done en el chat activo, `refreshGit()`.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(git): TUI panel for status, diff vs HEAD, PR url"
```

---

## Task 7: Web — GitPanel, vault GitHub, ToolCard git, URL de PR

**Files:**

- Create: `web/src/lib/git-display.ts`
- Test: `web/src/lib/git-display.test.ts`
- Create: `web/src/components/GitPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/ProvidersPanel.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/tool-display.ts` (si plan 2 lo creó; si no, mapear git_* en ToolCard)
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`
- Modify: `web/src/lib/ws-client.ts` (si Task 4 no cubrió `action`/`requestId`)

Web no ejecuta git. Pide snapshot al daemon vía WS y pinta tools.

- [ ] `"test": "bun test"` en `web/package.json` si falta.

- [ ] `web/src/lib/git-display.ts` — copia de `formatGitSnapshot`, `NOT_A_GIT_UI`, `GITHUB_UNLINKED_UI`, types `GitSnapshot`/`GitDirtyFile`. Mismos strings. Test: clean vs dirty vs `isRepo: false`.

- [ ] `queryKeys.gitSnapshot = (workspaceId: string) => ["gitSnapshot", workspaceId]`.

- [ ] `useWsGitStatus` / `useWsGitDiff` en `web/src/lib/ws-hooks.ts`:

```ts
export function useWsGitStatus() {
  const ws = useWs();
  return useMutation({
    mutationFn: () => ws.request({ type: "workspace.git.status" }),
  });
}
```

Ampliar el tipo `request` del context con `action`, `requestId`, `message`, `title`, `body`, `name`, `paths`, `force`, `remote`, `base` si aún no están.

- [ ] `GitPanel.tsx`:

  - Botón “Git status” / “Diff vs HEAD”.
  - Si `snapshot.isRepo === false`: texto `NOT_A_GIT_UI`, botones commit/PR **no** se muestran (esta fase el panel es status+diff+PR url; commit lo hace el agente/CLI).
  - Lista branch, `↑ahead ↓behind`, dirty paths (`index+worktree path`).
  - Diff en `<pre>` con marca truncado.
  - Si `prUrl`, link `<a href={prUrl} target="_blank">`.
  - Si github no linked (prop `githubLinked: boolean` desde `useProviders`): banner `GITHUB_UNLINKED_UI` + link `/providers?provider=github`. **No** hay textarea de token en el chat.
  - Hostname no se usa para git (el cwd es el del daemon bound). Si el workspace no tiene daemon, el mutate falla `NO_DAEMON_ERROR` y se muestra ese string.

- [ ] `ChatDetailPanel.tsx`: montar `<GitPanel />` encima del compositor. `onPush`:
  - `workspace.git.snapshot` → set snapshot
  - `github.pr.created` → set prUrl
  - `chat.tool.result` con `metadata.prUrl` → set prUrl
  - `chat.tool.update` awaiting `git_commit`: ToolCard ya pinta approve (plan 13). Asegurar que el body muestra `format` de `metadata.prompt` (mensaje + paths). Si ToolCard solo JSON, añadir rama `prompt.kind === "git_commit"`: `<pre>{message}\n{paths.join("\n")}</pre>`.

- [ ] `WorkspaceDetailPanel.tsx`: bloque compacto “git · branch · dirty=N” o `NOT_A_GIT_UI`. Click “abrir chat” no requerido; el detalle vive en el chat.

- [ ] `ProvidersPanel.tsx`:
  - Option `<option value="github">github</option>` en Vincular. Hint: “PAT `ghp_` / `github_pat_`. Nunca lo pegues en un chat.”
  - Card GitHub: **sin** botón “Activar” (no es LLM). Linked / Unlink / Reveal sí.
  - `useSetActiveProvider` no se llama para github.

- [ ] CSS: `.git-panel pre { max-height: 16rem; overflow: auto; }` y `.badge.git { }`.

- [ ] ToolCard: `canonicalToolName` git_* → `tool · git_commit · done`. Status `error` de push muestra el motivo (ya en output). PR done muestra el link si `prUrl` o si el output contiene `https://github.com/`.

- [ ] Commit:

```bash
git add web/src/lib/git-display.ts web/src/lib/git-display.test.ts \
  web/src/components/GitPanel.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/ProvidersPanel.tsx web/src/lib/hooks.ts \
  web/src/lib/ws-hooks.ts web/src/lib/ws-context.tsx \
  web/src/lib/query-keys.ts web/src/lib/tool-display.ts \
  web/src/styles/global.css web/package.json web/src/lib/ws-client.ts
git commit -m "feat(git): Web GitPanel, GitHub vault, PR url, ask paths"
```

---

## Task 8: Smokes Gherkin — las 12 escenas sin LLM vivo cuando baste

**Files:**

- Create: `cli/scripts/git-workspace-smoke.ts`
- Create: `api/scripts/e2e-git-vault.ts`
- Modify: `cli/package.json` (script opcional `"test:git-smoke": "bun run scripts/git-workspace-smoke.ts"`)
- Modify: `api/package.json` (`"test:git-vault": "bun run scripts/e2e-git-vault.ts"`)

No llamar a Anthropic. GitHub se mockea o se omite (vault + parse). Un repo tmp es suficiente.

- [ ] `cli/scripts/git-workspace-smoke.ts` (assert + `process.exit(1)`):

  1. **Status visible.** `git init` + commit + dirty file. `collectGitSnapshot` → branch, dirty ≥ 1. `formatGitSnapshot` estable. `formatWatchLine({ type: "workspace.git.snapshot", data: { snapshot } })` contiene branch y `dirty=`.
  2. **Diff vs HEAD.** Escribir archivo. `collectDiffVsHead` contiene el path. No usa `streamId`. (Comentario en el script: el diff-por-turn del plan 6 es otro set; si `turn_file_diffs` existiera vacío, este unificado **sigue** mostrando el edit manual.)
  3. **No es un repo.** tmp dir sin `.git`. snapshot `isRepo false`, `message === NOT_A_GIT_REPO`. `commitWorkspace` throw `NOT_A_GIT_REPO` / `NO_FAKE_COMMIT`. `runGitAction({ action: "commit" }).ok === false`.
  4. **Commit en ask (log intacto hasta approve).** No hace falta SDK: `gateGitTool("ask", "git_commit", { message: "x" }).decision === "ask"`. En un repo, **no** llamar `commitWorkspace` hasta un flag `approved`. Simular: contar `git rev-list --count HEAD` antes; no commitear; count igual; después `commitWorkspace({ mode: "user" })` (equivalente a approve) count +1. Mensaje + paths salen de `formatGitApproval`.
  5. **Commit en auto si el usuario lo pidió.** `gateGitTool("auto", "git_commit", …).decision === "allow"`. `commitWorkspace({ mode: "auto" })` en una **work branch** (no main) crea commit. `canonicalToolName("mcp__chavez-git__git_commit") === "git_commit"` (timeline done).
  6. **Modo plan no commitea.** `gateGitTool("plan", "git_commit").decision === "deny"` y `message === PLAN_GIT_DENIED`. `gateGitTool("plan", "git_pr")` deny. `git_status` allow. Count de commits igual si no se llama al handler.
  7. **Crear branch.** `createWorkBranch({ name: "feat-smoke" })` → `detectGit.branch === "feat-smoke"`. `createWorkBranch({ name: "main" })` throw. No se hace checkout a main.
  8. **Vincular GitHub.** `createPullRequest({ token: null, fetchImpl })` throw `GITHUB_UNLINKED`. `summarizeToolInput("git_pr", { title: "x", token: "ghp_SECRETO" })` no contiene `ghp_SECRETO` tras `sanitizeToolInput`.
  9. **Abrir PR.** `pushImpl` no-op + `fetchImpl` 201 `{ html_url: "https://github.com/acme/demo/pull/7", number: 7 }` → url. `formatWatchLine({ type: "github.pr.created", data: { url } })` === `git · pr https://github.com/acme/demo/pull/7`.
  10. **Push rechazado.** `pushImpl` throw `${PUSH_REJECTED_PREFIX}non-fast-forward`. `createPullRequest` no llama `fetchImpl` (flag). Result `pr` ausente.
  11. **Guardas auto.** `commitWorkspace` paths `[".env"]` throw secret. `denyForcePushToProtected({ force: true, branch: "main" }) === FORCE_PUSH_PROTECTED`. Path `.chavez/config.json` bloqueado. `classifyGitBash("git push --force origin master").kind === "forbidden"`.
  12. **Auth por usuario** — cubierto en el e2e de API (abajo). Aquí assert `isVaultProvider` no aplica; skip.

- [ ] `api/scripts/e2e-git-vault.ts` — mismo estilo que `api/scripts/e2e-phase1.ts` (sign-up dos users, cookie/bearer):

  1. User A `PUT /providers/github/credentials` `{ authKind: "api_key", secret: "ghp_aaa" }` → 200.
  2. User A `GET` → secret `ghp_aaa`.
  3. User B `GET /providers/github/credentials` → **404** (no el de A).
  4. User B `PUT` `ghp_bbb` → 200. A sigue viendo `ghp_aaa`.
  5. Sin cookie/bearer → **401** en GET y PUT.
  6. `PUT /providers/active { provider: "github" }` → 400.
  7. `GET /providers` muestra `providers.github.linked: true` para A y `runnable: false`. `activeProvider` no es `"github"`.

Si e2e-phase1 requiere DB local, reutilizar su helper de signup. No imprimir los PAT en logs más que un `linked ok`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/git-can-use.test.ts src/llm/git-commit.test.ts \
  src/llm/git-pr.test.ts src/llm/watch-format.test.ts
cd cli && bun run scripts/git-workspace-smoke.ts
cd api && bun run scripts/e2e-git-vault.ts
```

Esperado: exit 0. Si la API/DB no está arriba, el e2e falla explícito (no silenciar). Los unit tests no necesitan API.

- [ ] Commit:

```bash
git add cli/scripts/git-workspace-smoke.ts api/scripts/e2e-git-vault.ts \
  cli/package.json api/package.json
git commit -m "test(git): gherkin smokes for status, modes, guards, vault isolation"
```

---

## Orden de implementación y riesgos

1. Task 1 (puro) → Task 2 (git real) se pueden mergear antes de tocar el runner.
2. Task 3 cablea el modelo. Sin Task 3, CLI/TUI/Web ya sirven status/diff user-RPC (Tasks 4–7).
3. Task 4 vault es el único cambio de API de auth; no migrar schema.
4. Si plan 3 aún no aterrizó, `executionMode` default `ask` y `gateGitTool` vive solo en `git-can-use.ts`; al aterrizar plan 3, **una** llamada desde `decideCanUseTool`.
5. Si plan 8 no aterrizó, `git-secret-guard.ts` mínimo; al aterrizar, no cambiar el string de deny.
6. Si plan 12 no aterrizó, crear `git-exec`/`git-detect` aquí; plan 12 los reutiliza (misma firma).
7. Riesgo: MCP tool names reales pueden venir como `mcp__chavez-git__git_commit`. `parseGitSdkName` cubre ambos.
8. Riesgo: `createSdkMcpServer` + `allowedTools: ["mcp__chavez-git"]` — si una versión del SDK exige tools enumeradas, pasar `GIT_TOOL_IDS.map(gitSdkName)`.
9. Riesgo: `zod` v4 vs v3 en `tool()`. El SDK declara `AnyZodRawShape`. Usar `z.string()` del `zod` del package CLI (ya en `cli/package.json`).
10. No implementar slash `/git`. Dejar el RPC listo.

## Verificación manual (cuando el stack corre)

```bash
# terminal A
chavez login && chavez provider link claude && chavez provider link github
chavez headless workspace open
# terminal B — repo
chavez headless git status
chavez tui          # tecla g
# Web /providers — GitHub linked, sin Activar
# Web chat — GitPanel vs HEAD; pedir en ask "commitea"; y; git log cambia
# auto: "commitea estos cambios" en work branch → tool git_commit done
# plan: "commitea y abre PR" → sin commit, texto de plan
# watch: git · pr https://…
```
