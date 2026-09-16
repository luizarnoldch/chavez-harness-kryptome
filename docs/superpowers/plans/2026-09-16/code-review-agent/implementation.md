# Code review agent Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, cola de turns (plan 29), worktrees paralelos (plan 28), notificaciones OS/email, CI GitHub Action, ni un provider nuevo. Spec: [`plan.md`](./plan.md). Depende de diffs ([`diffs-review`](../diffs-review/implementation.md)), git/PR ([`git-workspace`](../git-workspace/implementation.md)), modos ([`execution-modes`](../execution-modes/implementation.md)), approvals ([`approvals`](../approvals/implementation.md)), tools ([`agent-tools`](../agent-tools/implementation.md)) y slash ([`slash-commands`](../slash-commands/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario pide un **turn de review** (no otro provider). El daemon hidrata el diff — el del último turn (plan 6) o `git diff HEAD` — y el agente comenta hallazgos. En `plan` no escribe. En `ask`, los writes de “fix” se aprueban uno a uno. Si el usuario pasa URL o número de PR y GitHub está vinculado, el contexto es ese PR; el resultado puede quedarse en el chat. Publicar el review en GitHub pide `ask`. `auto` no publica reviews en GitHub salvo que el usuario lo pida de forma explícita (mismo listón que commit). Sin PR, el review es local del working tree y **no falla** por falta de GitHub.

**Architecture:** El filesystem, `git` y las llamadas a `api.github.com` viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). Review **no** es un provider: es `metadata.kind === "code_review"` en un `agent.turn.request` normal. La API **no** lee el cwd ni habla con GitHub: reenvía `metadata.review` en el dispatch, persiste el kind y hace fan-out. Las tools nuevas (`git_pr_get` lectura, `git_pr_review` escritura) se registran en el MCP `chavez-git` del plan 7.

```
Composer / /review / tecla r / chat review
        |
        v
  agent.turn.request
        { prompt, metadata.kind = "code_review", metadata.review }
        |
        v
  API  hub.findDaemon
        |  no daemon → NO_DAEMON_ERROR
        |  dispatch { prompt, metadata.review, executionMode }
        v
  daemon  resolveReviewTarget(cwd, chat, review)
        |  PR URL/número + GitHub linked → GET pulls + files (vault)
        |  PR pedido + unlinked          → GITHUB_UNLINKED (no LLM)
        |  else último turn_file_diffs   → target turn_diff
        |  else git diff HEAD            → target working_tree
        |  no git y no diffs y no PR     → REVIEW_NO_DIFF (no LLM)
        |  git limpio                    → review igual (agente dice “sin cambios”)
        |
        |  hidrata en el daemon (nunca en API/browser)
        |  chat.append user  metadata.kind=code_review
        |  query() + REVIEW_*_PREAMBLE + <review>diff</review>
        |
        |  Read/Grep/Glob/LS/git_status/git_diff/git_pr_get → allow
        |  Write/Edit/Bash “fix”:
        |     plan → PLAN_MUTATION_DENIED (disco intacto)
        |     ask  → awaiting_approval uno a uno
        |     auto → allow + sandbox
        |  git_pr_review:
        |     plan → PLAN_REVIEW_PUBLISH_DENIED
        |     ask  → awaiting_approval (body + event + PR)
        |     auto → allow solo si explicitPublish; si no AUTO_REVIEW_PUBLISH_DENIED
        v
  chat.stream.end metadata.review + (si publicó) github.review.submitted
        v
  Web ReviewBanner | TUI review · | CLI watch  (mismo contrato)
```

Estado actual que este plan extiende (no reescribir):

- `api/src/ws/handlers.ts` `agent.turn.request` exige `chatId` + `prompt` y despacha `{ chatId, prompt, path, … }` **sin** `metadata`. Sin daemon: `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
- `cli/src/ws/daemon.ts` y `tui/src/App.tsx` reciben `agent.turn.dispatch` y llaman `publishAgentTurn({ chatId, prompt, cwd })`. **No** leen `metadata.kind`.
- `cli/src/llm/publish-turn.ts` hace `chat.append` user y `runClaudeTurn` con el prompt crudo. No inyecta brief de review.
- Plan 6 (`diffs-review`): `GET /chats/:id` incluye `diffs[]` preview por `streamId`. Si la tabla aún no existe, `resolveReviewTarget` cae a working tree (no inventar diffs).
- Plan 7 (`git-workspace`): `collectDiffVsHead`, MCP `chavez-git` (`git_status|git_diff|git_branch|git_commit|git_push|git_pr`), vault `provider="github"`, `GET /providers/github/credentials`. **No** hay `git_pr_get` ni `git_pr_review`. Si esos módulos no existen aún, Task 2 crea wrappers mínimos sobre `runGit` / `fetch` y Task 3 registra las dos tools nuevas en el MCP cuando exista.
- Plan 3: `canUseTool` + modos `plan|auto|ask`. Lecturas allow; write/edit/bash dependen del modo. No volver a `bypassPermissions`.
- Plan 13: aprobaciones una a una, timeout 300s, headless no auto-aprueba. Reusar waiter. Añadir kind `git_pr_review` al prompt de ask.
- Plan 11: `cli/src/llm/slash.ts` catálogo de 9 comandos. **No** hay `/review`. Si el archivo no existe, interceptar el string que empieza por `/review` en TUI/Web/CLI ask (mismo parser).
- `cli/src/commands/headless.ts` chat: `create|list|append|get|ask|watch`. **No** hay `review`.
- TUI teclas: `p` `[` `]` `{` `}` (`o` modo, `g` git si aterrizaron). **`r` está libre.**
- Web `ChatDetailPanel.tsx`: form `agent.turn.request` con textarea. Sin botón Review.
- Cursor `runnable: false`. El kind se persiste igual; no simular un review Cursor. Cuando el plan 4 ejecute, el mismo brief se prepende en `cursor-runner`.
- Undo (plan 12) no se implementa. Un write de “fix” sí queda en el working tree (y undo posterior podría revertirlo).

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva, **sin** migración), Claude Agent SDK `query` + MCP `chavez-git` (`permissionMode: "default"`, `canUseTool`), git CLI en el daemon, GitHub REST `fetch` (sin octokit), Ink TUI, Astro/React web. Tests: `bun test`. Web y API **no** importan CLI: duplicar parser/labels (comentario `keep-in-sync: code-review`).

**Global Constraints:**

1. El filesystem, `git` y `api.github.com` se tocan **solo** en el daemon (cwd del workspace). API y browser no hidratan diffs, no clonan el PR, no publican reviews. El PAT se descifra en `GET /providers/github/credentials` y **solo** el daemon lo usa.
2. Sin daemon bound, `agent.turn.request` (incluido review) falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Review es un **tipo de turn** (`metadata.kind === "code_review"`), no un provider. `PUT /providers/active` sigue aceptando solo `claude` | `cursor`.
4. Resolución de target (orden fijo, no heurística extra):
   1. El usuario pasó URL o número de PR → contexto GitHub. Sin token → `GITHUB_UNLINKED` y **no** se llama al LLM. No caer a working tree en silencio.
   2. Si no hay PR: diffs `applied`/`proposed` del **último** `streamId` del chat (plan 6) → `turn_diff`.
   3. Si no hay esos diffs: `git diff HEAD` del cwd → `working_tree`. Repo limpio **sí** corre el turn (el agente dice que no hay cambios).
   4. Sin PR, sin diffs de turn y sin `.git` → `REVIEW_NO_DIFF`, no LLM. **No** se emite `GITHUB_UNLINKED`.
5. Sin PR, GitHub unlinked **no es error**. El escenario Gherkin “Sin PR” pasa con review local.
6. Un PR GitHub **no se checkout**. Decision 17: 1 turn por daemon, cwd del workspace. El diff se hidrata vía REST. `Read` local ve el cwd, que puede no ser la branch del PR; el preamble lo dice.
7. Lecturas (`Read`, `Grep`, `Glob`, `LS`, `git_status`, `git_diff`, `git_pr_get`) **nunca** piden confirmación, en ningún modo.
8. Writes de “fix” (`Write`, `Edit`, `NotebookEdit`, `Bash`):
   - `ask` → `awaiting_approval` uno a uno. El disco no cambia hasta approve.
   - `auto` → allow tras sandbox de path.
   - `plan` → deny `PLAN_MUTATION_DENIED`. Cero writes. El agente solo comenta hallazgos.
9. Publicar review en GitHub (`git_pr_review`):
   - `plan` → deny `PLAN_REVIEW_PUBLISH_DENIED`. GitHub no cambia.
   - `ask` → `awaiting_approval` con PR + event + extracto del body. Hasta approve, no hay POST.
   - `auto` → allow **solo** si `explicitPublish === true` (flag `--publish`/`--submit` o frase “publica el review” / “submit the review”). Si no, deny `AUTO_REVIEW_PUBLISH_DENIED` (mismo listón que commit: no se publica solo porque el modelo lo intentó).
10. Aprobaciones **una a una**. Sin lote ni “siempre permitir”. Reusar `waitForApproval` / `agent.tool.approve`. El primero gana.
11. El token GitHub **nunca** viaja en `chat.tool.start` input, stream, watch ni metadata de review. Reusar redacción `ghp_` / `github_pat_`.
12. 1 turn por daemon. Un segundo review con `turnBusy` falla `TURN_BUSY_ERROR` (o el ignore existente del daemon). Esta fase **no** implementa cola.
13. Claude es el provider ejecutable. Cursor vinculado no ejecuta aquí; el kind se muestra. Cuando el plan 4 lo haga, reutiliza el mismo brief y las mismas tools MCP (host-side).
14. Web, TUI y CLI `watch` ven el mismo contrato: user `kind=code_review`, tools canónicas, `github.review.submitted` solo **después** de un POST 200 real.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, checkout del PR, GitLab, lote, “siempre permitir”, CI Action, JSON schema.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `REVIEW_KIND` | `"code_review"` |
| `REVIEW_TARGETS` | `"turn_diff"` \| `"working_tree"` \| `"github_pr"` |
| `REVIEW_DIFF_MAX_CHARS` | `80_000` |
| `REVIEW_FILE_MAX_CHARS` | `8_000` (igual que `GIT_DIFF_MAX_CHARS` si existe) |
| `REVIEW_PR_FILES_CAP` | `50` |
| `REVIEW_USER_PROMPT` | `"Revisa los cambios."` |
| `REVIEW_NO_DIFF` | `"Nothing to review: no turn diffs, no git working tree, and no PR given"` |
| `PLAN_REVIEW_PUBLISH_DENIED` | `"Plan mode: publishing a GitHub review is disabled. Switch to ask to submit it, or keep findings in the chat."` |
| `AUTO_REVIEW_PUBLISH_DENIED` | `"Auto mode does not publish GitHub reviews unless you explicitly ask (e.g. /review --publish). Findings stay in the chat."` |
| `REVIEW_PUBLISH_EVENT` | `"github.review.submitted"` |
| `GIT_PR_GET` | `"git_pr_get"` |
| `GIT_PR_REVIEW` | `"git_pr_review"` |
| `REVIEW_DEFAULT_EVENT` | `"COMMENT"` |
| `REVIEW_EVENTS` | `"COMMENT"` \| `"APPROVE"` \| `"REQUEST_CHANGES"` |
| `SLASH_USAGE_REVIEW` | `"Usage: /review [pr\|URL\|#n] [--publish]"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `GITHUB_UNLINKED` | `"GitHub is not linked. Run: chavez provider link github"` (reusar plan 7) |
| `PR_REQUIRES_GITHUB_REMOTE` | `"Pull requests require a GitHub origin remote"` (reusar plan 7) |
| `GITHUB_API` | `"https://api.github.com"` (reusar plan 7) |
| `GIT_MCP_SERVER` | `"chavez-git"` (reusar plan 7) |
| `GIT_PR_TIMEOUT_MS` | `30_000` (reusar plan 7) |
| `REVIEW_PREAMBLE` | ver Task 1 |
| `REVIEW_PLAN_PREAMBLE` | ver Task 1 |
| `REVIEW_AUTO_PREAMBLE` | ver Task 1 |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` / `GITHUB_UNLINKED` / `PLAN_MUTATION_DENIED` / `ASK_APPROVAL_TIMEOUT_MS` si ya existen; **no** cambiar esos strings.

Nombres canónicos (timeline; el PascalCase/MCP no es el único label):

| SDK `toolName` | Canónico |
|---|---|
| `git_pr_get`, `mcp__chavez-git__git_pr_get` | `git_pr_get` |
| `git_pr_review`, `mcp__chavez-git__git_pr_review` | `git_pr_review` |

Clases (extender plan 7, no sustituir):

- **read:** `git_pr_get` (+ `git_status`, `git_diff`, Read/Grep/Glob/LS).
- **write (git):** `git_pr_review` (+ `git_branch`, `git_commit`, `git_push`, `git_pr`).

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `agent.turn.request` | cliente → API | Ya existe. Esta fase **añade** `metadata.kind` / `metadata.review` al payload. |
| `agent.turn.dispatch` | API → daemon | Mismos campos + `metadata`. |
| `chat.append` / `message.appended` | ya existe | User con `kind=code_review`. |
| `chat.tool.start` / `update` / `result` | ya existe | Tools canónicas; `git_pr_review` en ask lleva `prompt`. |
| `github.review.submitted` | API → broadcast | `{ url, number, event, owner, repo }` **después** de un POST 200. Error de GitHub **no** lo emite. |

HTTP: ninguno nuevo. Vault GitHub ya es plan 7. `chat.get` ya devuelve `metadata`; un reload reconstruye el banner de review.

Tipos (congelados):

```ts
export const REVIEW_KIND = "code_review";
export const REVIEW_TARGETS = ["turn_diff", "working_tree", "github_pr"] as const;
export type ReviewTargetKind = (typeof REVIEW_TARGETS)[number];

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewPublishEvent = (typeof REVIEW_EVENTS)[number];

export type GitHubPrRef = {
  owner: string;
  repo: string;
  number: number;
  url: string;
};

export type ReviewRequest = {
  pr?: GitHubPrRef | { number: number };
  explicitPublish: boolean;
  note?: string;
};

export type ReviewMeta = {
  kind: typeof REVIEW_KIND;
  target: ReviewTargetKind;
  streamId?: string;
  pr?: GitHubPrRef;
  explicitPublish: boolean;
  files: number;
  truncated: boolean;
  published?: boolean;
  publishedUrl?: string;
};

export type HydratedReview = {
  target: ReviewTargetKind;
  title: string;
  body: string;
  files: number;
  truncated: boolean;
  pr?: GitHubPrRef;
  streamId?: string;
  empty: boolean;
};
```

`metadata.review` en el user message y en el assistant `chat.stream.end`:

```ts
{
  kind: "code_review",
  target: "turn_diff" | "working_tree" | "github_pr",
  streamId?: string,
  pr?: { owner, repo, number, url },
  explicitPublish: boolean,
  files: number,
  truncated: boolean,
  published?: boolean,
  publishedUrl?: string,
}
```

---

## Task 1: Módulos puros — constantes, parser PR, `/review`, picker de diffs, brief

**Files:**

- Create: `cli/src/llm/review-constants.ts`
- Create: `cli/src/llm/review-parse.ts`
- Create: `cli/src/llm/review-pick.ts`
- Create: `cli/src/llm/review-format.ts`
- Test: `cli/src/llm/review-parse.test.ts`
- Test: `cli/src/llm/review-pick.test.ts`
- Test: `cli/src/llm/review-format.test.ts`
- Create: `api/src/llm/review-constants.ts`
- Create: `web/src/lib/review.ts`
- Test: `web/src/lib/review.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`

Sin I/O de red ni git. TUI importa desde `cli/src/llm/…`. API y Web **no** importan CLI: copiar parser + constantes (comentario `keep-in-sync: code-review`).

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe. Dejar `start`/`dev`/`bin`/`db:*`/`build` intactos.

- [ ] Crear `cli/src/llm/review-constants.ts`:

```ts
export const REVIEW_KIND = "code_review";

export const REVIEW_TARGETS = ["turn_diff", "working_tree", "github_pr"] as const;
export type ReviewTargetKind = (typeof REVIEW_TARGETS)[number];

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewPublishEvent = (typeof REVIEW_EVENTS)[number];

export const REVIEW_DIFF_MAX_CHARS = 80_000;
export const REVIEW_FILE_MAX_CHARS = 8_000;
export const REVIEW_PR_FILES_CAP = 50;
export const REVIEW_DEFAULT_EVENT = "COMMENT" as const;

export const REVIEW_USER_PROMPT = "Revisa los cambios.";

export const REVIEW_NO_DIFF =
  "Nothing to review: no turn diffs, no git working tree, and no PR given";

export const PLAN_REVIEW_PUBLISH_DENIED =
  "Plan mode: publishing a GitHub review is disabled. Switch to ask to submit it, or keep findings in the chat.";

export const AUTO_REVIEW_PUBLISH_DENIED =
  "Auto mode does not publish GitHub reviews unless you explicitly ask (e.g. /review --publish). Findings stay in the chat.";

export const REVIEW_PUBLISH_EVENT = "github.review.submitted";

export const GIT_PR_GET = "git_pr_get";
export const GIT_PR_REVIEW = "git_pr_review";

export const SLASH_USAGE_REVIEW = "Usage: /review [pr|URL|#n] [--publish]";

export const REVIEW_PREAMBLE =
  "You are doing a code review. Read the hydrated diff below. Comment findings (bugs, risks, missing tests, style only if it hides a bug). Do not write, edit, or run mutating shell unless the user asked to fix. Do not publish a GitHub review unless the user explicitly asked to publish/submit. Prefer staying in the chat.";

export const REVIEW_PLAN_PREAMBLE =
  "You are in plan mode doing a code review. You may read, grep, glob, inspect git status/diff, and fetch PR files. Do not write, edit, run mutating shell, or publish a GitHub review. Comment findings in the chat.";

export const REVIEW_AUTO_PREAMBLE =
  "GitHub review publish is available only if the user explicitly asked (e.g. /review --publish or 'submit the review'). Otherwise keep findings in the chat. Never force-push. Never commit secrets. Writes still follow the workspace sandbox.";

export const REVIEW_PR_CWD_HINT =
  "The PR diff is hydrated from GitHub. The workspace cwd may not be that PR branch. Prefer the hydrated diff. Use Read only for files that exist locally.";

export function reviewTruncatedMarker(shown: number, total: number): string {
  return `[truncated: showing ${shown} of ${total} chars]`;
}

export function isReviewKind(v: unknown): boolean {
  return v === REVIEW_KIND;
}

export function isReviewTarget(v: unknown): v is ReviewTargetKind {
  return v === "turn_diff" || v === "working_tree" || v === "github_pr";
}

export function isReviewPublishEvent(v: unknown): v is ReviewPublishEvent {
  return v === "COMMENT" || v === "APPROVE" || v === "REQUEST_CHANGES";
}
```

Si `GIT_DIFF_MAX_CHARS` ya existe en `cli/src/llm/git-constants.ts`, `REVIEW_FILE_MAX_CHARS` reexporta ese número (mismo 8000). No inventar 8001.

- [ ] Crear `cli/src/llm/review-parse.ts`:

```ts
import { SLASH_USAGE_REVIEW } from "./review-constants";

export type GitHubPrRef = {
  owner: string;
  repo: string;
  number: number;
  url: string;
};

export type ParsedReview = {
  command: true;
  pr: GitHubPrRef | { number: number } | null;
  explicitPublish: boolean;
  note: string;
};

const PR_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const OWNER_REPO_HASH_RE =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const HASH_NUM_RE = /^#(\d+)$/;
const PLAIN_NUM_RE = /^(\d+)$/;

const PUBLISH_FLAGS = new Set(["--publish", "--submit", "-p"]);
const PUBLISH_PHRASE =
  /\b((submit|publish|post|send)\s+(the\s+)?(review|pr review)|publica(r)?\s+(el\s+)?review|env[ií]a(r)?\s+(el\s+)?review)\b/i;

export function prUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

export function parseGitHubPrRef(raw: string): GitHubPrRef | { number: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const url = s.match(PR_URL_RE);
  if (url) {
    const owner = url[1]!;
    const repo = url[2]!;
    const number = Number(url[3]);
    return { owner, repo, number, url: prUrl(owner, repo, number) };
  }
  const ownerRepo = s.match(OWNER_REPO_HASH_RE);
  if (ownerRepo) {
    const owner = ownerRepo[1]!;
    const repo = ownerRepo[2]!;
    const number = Number(ownerRepo[3]);
    return { owner, repo, number, url: prUrl(owner, repo, number) };
  }
  const hash = s.match(HASH_NUM_RE);
  if (hash) return { number: Number(hash[1]) };
  const plain = s.match(PLAIN_NUM_RE);
  if (plain) return { number: Number(plain[1]) };
  return null;
}

export function userAskedToPublishReview(text: string): boolean {
  const tokens = text.split(/\s+/);
  if (tokens.some((t) => PUBLISH_FLAGS.has(t.toLowerCase()))) return true;
  return PUBLISH_PHRASE.test(text);
}

/**
 * True when the whole prompt is a review command, not a free-form
 * sentence that happens to contain the word "review".
 */
export function isReviewCommand(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  if (/^\/review(?:\s|$)/i.test(t)) return true;
  if (/^review(?:\s|$)/i.test(t) && t.length <= 200) {
    const rest = t.slice("review".length).trim();
    if (!rest) return true;
    if (PUBLISH_FLAGS.has(rest.toLowerCase())) return true;
    if (parseGitHubPrRef(rest.split(/\s+/)[0]!) || rest.toLowerCase() === "pr") {
      return true;
    }
  }
  return false;
}

export function parseReviewPrompt(prompt: string): ParsedReview | null {
  const t = prompt.trim();
  if (!isReviewCommand(t)) return null;
  const withoutSlash = t.replace(/^\/?review\b/i, "").trim();
  const tokens = withoutSlash.split(/\s+/).filter(Boolean);
  const flags: string[] = [];
  const positional: string[] = [];
  for (const tok of tokens) {
    if (PUBLISH_FLAGS.has(tok.toLowerCase())) flags.push(tok);
    else positional.push(tok);
  }
  const explicitPublish =
    flags.length > 0 || userAskedToPublishReview(withoutSlash);
  let pr: ParsedReview["pr"] = null;
  const noteParts: string[] = [];
  for (const tok of positional) {
    if (tok.toLowerCase() === "pr") continue;
    const parsed = parseGitHubPrRef(tok);
    if (parsed && !pr) {
      pr = parsed;
      continue;
    }
    noteParts.push(tok);
  }
  return {
    command: true,
    pr,
    explicitPublish,
    note: noteParts.join(" "),
  };
}

export function reviewUsageError(got: string): string {
  return `${SLASH_USAGE_REVIEW} (got: ${got})`;
}
```

- [ ] Crear `cli/src/llm/review-pick.ts`:

```ts
export type TurnDiffRow = {
  streamId?: string;
  path: string;
  kind?: string;
  status?: string;
  preview?: string;
  additions?: number;
  deletions?: number;
  truncated?: boolean;
};

export type PickedTurnDiffs = {
  streamId: string;
  files: TurnDiffRow[];
};

/** Last streamId that has proposed/applied diffs. Rejected rows are omitted. */
export function pickLastTurnDiffs(diffs: TurnDiffRow[] | null | undefined): PickedTurnDiffs | null {
  if (!diffs || diffs.length === 0) return null;
  const visible = diffs.filter(
    (d) => d.status === "applied" || d.status === "proposed" || d.status == null,
  );
  if (!visible.length) return null;
  let lastId: string | null = null;
  for (let i = visible.length - 1; i >= 0; i--) {
    const id = visible[i]!.streamId;
    if (id) {
      lastId = id;
      break;
    }
  }
  if (!lastId) {
    return { streamId: "unknown", files: visible };
  }
  const files = visible.filter((d) => d.streamId === lastId);
  return files.length ? { streamId: lastId, files } : null;
}

export function turnDiffsToUnified(files: TurnDiffRow[]): { body: string; truncated: boolean } {
  const chunks: string[] = [];
  let truncated = false;
  for (const f of files) {
    const header = `--- a/${f.path}\n+++ b/${f.path}`;
    const preview = (f.preview || "").trim();
    if (f.truncated) truncated = true;
    chunks.push(preview ? `${header}\n${preview}` : header);
  }
  return { body: chunks.join("\n\n"), truncated };
}
```

- [ ] Crear `cli/src/llm/review-format.ts`:

```ts
import {
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_PLAN_PREAMBLE,
  REVIEW_PR_CWD_HINT,
  REVIEW_PREAMBLE,
  REVIEW_AUTO_PREAMBLE,
  reviewTruncatedMarker,
  type ReviewTargetKind,
} from "./review-constants";
import type { GitHubPrRef } from "./review-parse";

export type ReviewBriefInput = {
  target: ReviewTargetKind;
  title: string;
  diff: string;
  stat?: string;
  pr?: GitHubPrRef;
  streamId?: string;
  files: number;
  empty: boolean;
  executionMode: "plan" | "auto" | "ask";
};

export function clipReviewDiff(diff: string): { text: string; truncated: boolean } {
  if (diff.length <= REVIEW_DIFF_MAX_CHARS) return { text: diff, truncated: false };
  return {
    text:
      diff.slice(0, REVIEW_DIFF_MAX_CHARS) +
      "\n" +
      reviewTruncatedMarker(REVIEW_DIFF_MAX_CHARS, diff.length),
    truncated: true,
  };
}

export function formatReviewBrief(input: ReviewBriefInput): string {
  const clipped = clipReviewDiff(input.diff);
  const lines = [
    `# Code review`,
    `Target: ${input.target}`,
    `Title: ${input.title}`,
    `Files: ${input.files}`,
  ];
  if (input.streamId) lines.push(`Turn streamId: ${input.streamId}`);
  if (input.pr) {
    lines.push(`PR: ${input.pr.url}`);
    lines.push(REVIEW_PR_CWD_HINT);
  }
  if (input.empty) lines.push(`Status: no changes`);
  if (clipped.truncated) lines.push(`Truncated: yes`);
  if (input.stat) {
    lines.push("");
    lines.push(input.stat);
  }
  lines.push("");
  lines.push("```diff");
  lines.push(clipped.text || "(empty diff)");
  lines.push("```");
  return lines.join("\n");
}

export function reviewSystemPrompt(mode: "plan" | "auto" | "ask"): string {
  if (mode === "plan") return REVIEW_PLAN_PREAMBLE;
  if (mode === "auto") return `${REVIEW_PREAMBLE}\n${REVIEW_AUTO_PREAMBLE}`;
  return REVIEW_PREAMBLE;
}

export function composeReviewPrompt(input: {
  userPrompt: string;
  brief: string;
  mode: "plan" | "auto" | "ask";
}): string {
  return [reviewSystemPrompt(input.mode), "", "<review>", input.brief, "</review>", "", input.userPrompt].join(
    "\n",
  );
}
```

- [ ] Tests `cli/src/llm/review-parse.test.ts`:

  1. `parseGitHubPrRef("https://github.com/acme/demo/pull/42")` → `{ owner: "acme", repo: "demo", number: 42, url: "https://github.com/acme/demo/pull/42" }`.
  2. `parseGitHubPrRef("github.com/acme/demo/pull/42/files")` igual.
  3. `parseGitHubPrRef("acme/demo#7")` → number 7.
  4. `parseGitHubPrRef("#9")` y `"9"` → `{ number: 9 }` (sin owner; se resuelve con origin en Task 2).
  5. `parseGitHubPrRef("https://gitlab.com/acme/demo/-/merge_requests/1")` → `null`.
  6. `isReviewCommand("/review")` true; `isReviewCommand("please review this later")` **false**.
  7. `parseReviewPrompt("/review")` → `pr: null, explicitPublish: false`.
  8. `parseReviewPrompt("/review 42 --publish")` → `pr.number === 42`, `explicitPublish: true`.
  9. `parseReviewPrompt("review https://github.com/acme/demo/pull/1")` parsea el PR.
  10. `userAskedToPublishReview("publica el review")` true; `"looks good"` false.
  11. `userAskedToPublishReview("/review --submit")` true.

- [ ] Tests `cli/src/llm/review-pick.test.ts`:

  1. Dos `streamId`, el último con 2 `applied` → pick ese id, 2 files.
  2. Solo `rejected` → `null`.
  3. `proposed` cuenta (ask aún no aplicado).
  4. Array vacío / `undefined` → `null`.

- [ ] Tests `cli/src/llm/review-format.test.ts`:

  1. Brief incluye `Target: working_tree` y el unificado.
  2. Diff de `REVIEW_DIFF_MAX_CHARS + 10` chars lleva `truncated: showing`.
  3. `reviewSystemPrompt("plan")` === `REVIEW_PLAN_PREAMBLE` y no menciona publish como permitido.
  4. `composeReviewPrompt` envuelve `<review>` y deja el user prompt al final.

- [ ] Copiar a `api/src/llm/review-constants.ts` los strings que la API/UI comparte: `REVIEW_KIND`, `REVIEW_NO_DIFF`, `REVIEW_PUBLISH_EVENT`, `PLAN_REVIEW_PUBLISH_DENIED`, `AUTO_REVIEW_PUBLISH_DENIED`, `SLASH_USAGE_REVIEW`. Mismos literales. Comentario `keep-in-sync: code-review`.

- [ ] Copiar a `web/src/lib/review.ts` `REVIEW_KIND`, `isReviewKind`, `parseGitHubPrRef`, `parseReviewPrompt`, `isReviewCommand`, `userAskedToPublishReview`, `SLASH_USAGE_REVIEW`, `REVIEW_USER_PROMPT`. Comentario `keep-in-sync: code-review`. Test `web/src/lib/review.test.ts` con los casos 1, 6, 8 de parse (URL, no-comando, `--publish`).

- [ ] Correr:

```bash
cd cli && bun test src/llm/review-parse.test.ts src/llm/review-pick.test.ts src/llm/review-format.test.ts
cd api && bun test src/llm/review-constants.ts
cd web && bun test src/lib/review.test.ts
```

El test de API puede ser un `review-constants.test.ts` de una línea que importa y compara `REVIEW_KIND === "code_review"` si no hay lógica. Si el archivo de constantes no es ejecutable como test, crear `api/src/llm/review-constants.test.ts`.

- [ ] Commit:

```bash
git add cli/src/llm/review-constants.ts cli/src/llm/review-parse.ts \
  cli/src/llm/review-pick.ts cli/src/llm/review-format.ts \
  cli/src/llm/review-parse.test.ts cli/src/llm/review-pick.test.ts \
  cli/src/llm/review-format.test.ts cli/package.json \
  api/src/llm/review-constants.ts api/src/llm/review-constants.test.ts \
  api/package.json web/src/lib/review.ts web/src/lib/review.test.ts \
  web/package.json
git commit -m "feat(review): parse PR refs, /review flags, turn-diff picker"
```

---

## Task 2: Hidratar el target en el daemon — turn diffs, vs HEAD, PR GitHub

**Files:**

- Create: `cli/src/llm/review-hydrate.ts`
- Create: `cli/src/llm/review-github.ts`
- Test: `cli/src/llm/review-hydrate.test.ts`
- Test: `cli/src/llm/review-github.test.ts`

I/O de git y `fetch` **solo** aquí, en funciones inyectables. API y browser no las llaman.

- [ ] Crear `cli/src/llm/review-github.ts`:

```ts
import {
  GITHUB_API,
  GITHUB_UNLINKED,
  GIT_PR_TIMEOUT_MS,
  PR_REQUIRES_GITHUB_REMOTE,
} from "./git-constants";
import {
  REVIEW_FILE_MAX_CHARS,
  REVIEW_PR_FILES_CAP,
  reviewTruncatedMarker,
} from "./review-constants";
import { prUrl, type GitHubPrRef } from "./review-parse";

export type GhPrFile = {
  path: string;
  status: string;
  patch: string;
  truncated: boolean;
};

export type GhPrContext = {
  ref: GitHubPrRef;
  title: string;
  body: string;
  head: string;
  base: string;
  files: GhPrFile[];
  truncated: boolean;
};

async function ghFetch(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  accept = "application/vnd.github+json",
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | unknown[] }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GIT_PR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${GITHUB_API}${path}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": "chavez",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: ac.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> | unknown[];
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

export async function resolvePrRefForCwd(input: {
  cwd: string;
  pr: GitHubPrRef | { number: number };
  resolveOrigin: () => Promise<{ owner: string; repo: string } | null>;
}): Promise<GitHubPrRef> {
  if ("owner" in input.pr && input.pr.owner) {
    return {
      owner: input.pr.owner,
      repo: input.pr.repo,
      number: input.pr.number,
      url: input.pr.url || prUrl(input.pr.owner, input.pr.repo, input.pr.number),
    };
  }
  const origin = await input.resolveOrigin();
  if (!origin) throw new Error(PR_REQUIRES_GITHUB_REMOTE);
  return {
    owner: origin.owner,
    repo: origin.repo,
    number: input.pr.number,
    url: prUrl(origin.owner, origin.repo, input.pr.number),
  };
}

export async function fetchPullRequestContext(input: {
  token: string | null;
  ref: GitHubPrRef;
  fetchImpl?: typeof fetch;
}): Promise<GhPrContext> {
  if (!input.token) throw new Error(GITHUB_UNLINKED);
  const fetchImpl = input.fetchImpl ?? fetch;
  const { owner, repo, number } = input.ref;
  const pr = await ghFetch(input.token, `/repos/${owner}/${repo}/pulls/${number}`, fetchImpl);
  if (!pr.ok || Array.isArray(pr.json)) {
    const msg =
      !Array.isArray(pr.json) && typeof pr.json.message === "string"
        ? pr.json.message
        : `GitHub PR fetch failed (${pr.status})`;
    throw new Error(msg);
  }
  const filesRes = await ghFetch(
    input.token,
    `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    fetchImpl,
  );
  const rawFiles = Array.isArray(filesRes.json) ? filesRes.json : [];
  let truncated = rawFiles.length > REVIEW_PR_FILES_CAP;
  const files: GhPrFile[] = rawFiles.slice(0, REVIEW_PR_FILES_CAP).map((f) => {
    const rec = f as {
      filename?: string;
      status?: string;
      patch?: string;
    };
    let patch = rec.patch || "";
    let fileTrunc = false;
    if (patch.length > REVIEW_FILE_MAX_CHARS) {
      patch =
        patch.slice(0, REVIEW_FILE_MAX_CHARS) +
        "\n" +
        reviewTruncatedMarker(REVIEW_FILE_MAX_CHARS, rec.patch?.length || 0);
      fileTrunc = true;
      truncated = true;
    }
    return {
      path: rec.filename || "unknown",
      status: rec.status || "modified",
      patch,
      truncated: fileTrunc,
    };
  });
  return {
    ref: input.ref,
    title: String(pr.json.title || `PR #${number}`),
    body: String(pr.json.body || ""),
    head: String((pr.json.head as { ref?: string } | undefined)?.ref || ""),
    base: String((pr.json.base as { ref?: string } | undefined)?.ref || ""),
    files,
    truncated,
  };
}

export async function submitPullRequestReview(input: {
  token: string | null;
  ref: GitHubPrRef;
  body: string;
  event?: string;
  comments?: Array<{ path: string; line: number; body: string }>;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string; id: number; event: string }> {
  if (!input.token) throw new Error(GITHUB_UNLINKED);
  const event = input.event && ["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(input.event)
    ? input.event
    : "COMMENT";
  const fetchImpl = input.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GIT_PR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${input.ref.owner}/${input.ref.repo}/pulls/${input.ref.number}/reviews`,
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
          body: input.body,
          event,
          comments: input.comments,
        }),
        signal: ac.signal,
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      html_url?: string;
      id?: number;
      message?: string;
    };
    if (!res.ok || !json.html_url || !json.id) {
      throw new Error(json.message || `GitHub review failed (${res.status})`);
    }
    return { url: json.html_url, id: json.id, event };
  } finally {
    clearTimeout(t);
  }
}
```

Si `cli/src/llm/git-constants.ts` aún no existe, definir **en este archivo** (y solo aquí) los cuatro strings `GITHUB_API`, `GITHUB_UNLINKED`, `GIT_PR_TIMEOUT_MS`, `PR_REQUIRES_GITHUB_REMOTE` con los literales del plan 7. Cuando el plan 7 aterrice, borrar el duplicado e importar.

- [ ] Crear `cli/src/llm/review-hydrate.ts`:

```ts
import { REVIEW_NO_DIFF, type ReviewTargetKind } from "./review-constants";
import { formatReviewBrief, clipReviewDiff } from "./review-format";
import { pickLastTurnDiffs, turnDiffsToUnified, type TurnDiffRow } from "./review-pick";
import type { GitHubPrRef } from "./review-parse";
import {
  fetchPullRequestContext,
  resolvePrRefForCwd,
  type GhPrContext,
} from "./review-github";

export type ReviewHydrateInput = {
  cwd: string;
  executionMode: "plan" | "auto" | "ask";
  pr?: GitHubPrRef | { number: number } | null;
  diffs?: TurnDiffRow[] | null;
  githubToken: string | null;
  collectDiffVsHead: (cwd: string) => Promise<{
    isRepo: boolean;
    unified: string;
    stat: string;
    paths: string[];
    truncated: boolean;
    message?: string;
  }>;
  resolveOrigin: () => Promise<{ owner: string; repo: string } | null>;
  fetchImpl?: typeof fetch;
};

export type ReviewHydrateResult =
  | {
      ok: true;
      target: ReviewTargetKind;
      brief: string;
      files: number;
      truncated: boolean;
      empty: boolean;
      pr?: GitHubPrRef;
      streamId?: string;
      title: string;
    }
  | { ok: false; error: string };

export async function hydrateReview(input: ReviewHydrateInput): Promise<ReviewHydrateResult> {
  if (input.pr) {
    try {
      const ref = await resolvePrRefForCwd({
        cwd: input.cwd,
        pr: input.pr,
        resolveOrigin: input.resolveOrigin,
      });
      const ctx: GhPrContext = await fetchPullRequestContext({
        token: input.githubToken,
        ref,
        fetchImpl: input.fetchImpl,
      });
      const diff = ctx.files
        .map((f) => `--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`)
        .join("\n\n");
      const clipped = clipReviewDiff(diff);
      const title = `${ctx.title} (${ctx.base} ← ${ctx.head})`;
      const brief = formatReviewBrief({
        target: "github_pr",
        title,
        diff: clipped.text,
        stat: ctx.body ? ctx.body.slice(0, 2000) : undefined,
        pr: ctx.ref,
        files: ctx.files.length,
        empty: ctx.files.length === 0,
        executionMode: input.executionMode,
      });
      return {
        ok: true,
        target: "github_pr",
        brief,
        files: ctx.files.length,
        truncated: ctx.truncated || clipped.truncated,
        empty: ctx.files.length === 0,
        pr: ctx.ref,
        title,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const picked = pickLastTurnDiffs(input.diffs);
  if (picked && picked.files.length) {
    const unified = turnDiffsToUnified(picked.files);
    const clipped = clipReviewDiff(unified.body);
    const title = `Turn diff (${picked.files.length} files)`;
    const brief = formatReviewBrief({
      target: "turn_diff",
      title,
      diff: clipped.text,
      streamId: picked.streamId,
      files: picked.files.length,
      empty: false,
      executionMode: input.executionMode,
    });
    return {
      ok: true,
      target: "turn_diff",
      brief,
      files: picked.files.length,
      truncated: unified.truncated || clipped.truncated,
      empty: false,
      streamId: picked.streamId,
      title,
    };
  }

  const head = await input.collectDiffVsHead(input.cwd);
  if (!head.isRepo) {
    return { ok: false, error: REVIEW_NO_DIFF };
  }
  const clipped = clipReviewDiff(head.unified || "");
  const files = head.paths.length;
  const empty = files === 0 && !(head.unified || "").trim();
  const title = empty ? "Working tree vs HEAD (clean)" : "Working tree vs HEAD";
  const brief = formatReviewBrief({
    target: "working_tree",
    title,
    diff: clipped.text,
    stat: head.stat,
    files,
    empty,
    executionMode: input.executionMode,
  });
  return {
    ok: true,
    target: "working_tree",
    brief,
    files,
    truncated: head.truncated || clipped.truncated,
    empty,
    title,
  };
}
```

Si `collectDiffVsHead` de `cli/src/llm/git-diff-head.ts` existe, el caller lo pasa. Si no, el caller de Task 4 implementa:

```ts
async function collectDiffVsHeadFallback(cwd: string) {
  const { runGit } = await import("./git-exec");
  const ident = await (await import("./git-detect")).detectGit(cwd);
  if (!ident.isRepo) {
    return { isRepo: false, unified: "", stat: "", paths: [], truncated: false };
  }
  const diff = await runGit(cwd, ["diff", "HEAD"]);
  const stat = await runGit(cwd, ["diff", "--stat", "HEAD"]);
  const names = await runGit(cwd, ["diff", "--name-only", "HEAD"]);
  return {
    isRepo: true,
    unified: diff.stdout,
    stat: stat.stdout,
    paths: names.stdout.split("\n").filter(Boolean),
    truncated: false,
  };
}
```

`resolveOrigin` usa `parseGitHubRemote` + `git remote get-url origin` del plan 7 si existen; si no, parsea `git remote get-url origin` con el regex de Task 1 (`github.com/owner/repo`).

- [ ] Tests `cli/src/llm/review-github.test.ts` (sin red: `fetchImpl` mock):

  1. Token `null` → throw `GITHUB_UNLINKED`. `fetchImpl` **no** se llama.
  2. GET 200 `{ title, body, head, base }` + files con `patch` largo → `truncated: true` y patch recortado a `REVIEW_FILE_MAX_CHARS`.
  3. `submitPullRequestReview` POST 200 `{ html_url, id }` → `{ url, id, event: "COMMENT" }`.
  4. POST 401 `{ message: "Bad credentials" }` → throw que incluye el message. El caller **no** emite `github.review.submitted`.
  5. Número solo + `resolveOrigin` null → `PR_REQUIRES_GITHUB_REMOTE`.
  6. Número solo + origin `acme/demo` → ref completa `https://github.com/acme/demo/pull/N`.
  7. El token **no** aparece en ningún string de `GhPrContext`.

- [ ] Tests `cli/src/llm/review-hydrate.test.ts`:

  1. **PR pedido + token null** → `{ ok: false, error: GITHUB_UNLINKED }`. No llama `collectDiffVsHead`.
  2. **Sin PR + diffs del último stream** → `target: "turn_diff"`, brief contiene el preview.
  3. **Sin PR + diffs vacíos + repo sucio** → `target: "working_tree"`, brief contiene el unificado.
  4. **Sin PR + diffs vacíos + no repo** → `{ ok: false, error: REVIEW_NO_DIFF }`. El error **no** es `GITHUB_UNLINKED`.
  5. **Sin PR + repo limpio** → `{ ok: true, target: "working_tree", empty: true }`. El turn **sí** puede correr.
  6. PR URL completa no llama `resolveOrigin`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/review-github.test.ts src/llm/review-hydrate.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/review-github.ts cli/src/llm/review-hydrate.ts \
  cli/src/llm/review-github.test.ts cli/src/llm/review-hydrate.test.ts
git commit -m "feat(review): hydrate turn diff, HEAD diff, or GitHub PR"
```

---

## Task 3: MCP `git_pr_get` / `git_pr_review` + gate de modo + intercept `gh`

**Files:**

- Modify: `cli/src/llm/git-names.ts` (si existe; si no, Create con las dos ids nuevas + las 6 del plan 7)
- Modify: `cli/src/llm/git-can-use.ts`
- Test: `cli/src/llm/git-can-use.test.ts` (extender)
- Modify: `cli/src/llm/git-bash.ts`
- Test: `cli/src/llm/git-bash.test.ts` (extender)
- Modify: `cli/src/llm/git-mcp.ts`
- Test: `cli/src/llm/git-mcp.test.ts` (extender)
- Modify: `cli/src/llm/git-approval.ts` (o `cli/src/llm/approval-prompt.ts`)
- Test: `cli/src/llm/git-approval.test.ts` (extender)
- Modify: `cli/src/llm/tool-names.ts`
- Modify: `cli/src/llm/tool-display.ts`
- Modify: `cli/src/llm/execution-gate.ts`
- Create: `cli/src/llm/review-gate.ts`
- Test: `cli/src/llm/review-gate.test.ts`

El MCP corre **en el daemon**. `canUseTool` decide **antes** del POST a GitHub.

- [ ] Extender `GIT_TOOL_IDS` con `"git_pr_get"` y `"git_pr_review"`. `GIT_READ_TOOLS` añade `git_pr_get`. `GIT_WRITE_TOOLS` añade `git_pr_review`. `parseGitSdkName("mcp__chavez-git__git_pr_review")` → `"git_pr_review"`.

- [ ] Crear `cli/src/llm/review-gate.ts`:

```ts
import type { ExecutionMode } from "./execution-mode";
import {
  AUTO_REVIEW_PUBLISH_DENIED,
  GIT_PR_GET,
  GIT_PR_REVIEW,
  PLAN_REVIEW_PUBLISH_DENIED,
} from "./review-constants";
import { parseGitSdkName } from "./git-names";

export type ReviewGate =
  | { decision: "allow" }
  | { decision: "deny"; message: string }
  | { decision: "ask" }
  | { decision: "passthrough" };

export function gateReviewTool(input: {
  mode: ExecutionMode;
  sdkName: string;
  explicitPublish: boolean;
}): ReviewGate {
  const id = parseGitSdkName(input.sdkName);
  if (id === GIT_PR_GET) return { decision: "allow" };
  if (id !== GIT_PR_REVIEW) return { decision: "passthrough" };
  if (input.mode === "plan") {
    return { decision: "deny", message: PLAN_REVIEW_PUBLISH_DENIED };
  }
  if (input.mode === "auto") {
    if (!input.explicitPublish) {
      return { decision: "deny", message: AUTO_REVIEW_PUBLISH_DENIED };
    }
    return { decision: "allow" };
  }
  return { decision: "ask" };
}
```

Si `execution-mode.ts` no existe, `type ExecutionMode = "plan" | "auto" | "ask"` local y unificar cuando plan 3 aterrice.

- [ ] En `gateGitTool` (plan 7): **antes** del switch write/read, si `gateReviewTool` no es `passthrough`, devolver eso. Así `git_pr_review` en plan usa `PLAN_REVIEW_PUBLISH_DENIED`, no `PLAN_GIT_DENIED`.

- [ ] En `cli/src/llm/can-use-tool.ts` (o el `canUseTool` inline de `claude-runner.ts`): pasar `explicitPublish` del turn (campo en el closure de `publishAgentTurn`). Orden: sandbox path → `gateReviewTool` → `gateGitTool` → `gateMutation`.

- [ ] Extender `cli/src/llm/git-bash.ts` `classifyGitBash`:

  - Comandos que parsean como `gh pr review`, `gh pr comment`, `gh api …/pulls/…/reviews` → `kind: "forbidden"` con mensaje `GIT_USE_DEDICATED_TOOLS` actualizado **o** un string nuevo `REVIEW_USE_DEDICATED_TOOL = "Use git_pr_review instead of bash gh pr review"`. Preferir string nuevo y no cambiar `GIT_USE_DEDICATED_TOOLS` (los tests del plan 7 siguen verdes).
  - `gh pr view` / `gh pr diff` → deny con `REVIEW_USE_GET = "Use git_pr_get instead of bash gh pr view"`.

- [ ] En `cli/src/llm/git-mcp.ts` registrar dos tools más en el mismo `createSdkMcpServer("chavez-git")`:

```ts
tool(
  "git_pr_get",
  "Fetch a GitHub pull request (title, body, files, patches). Read-only.",
  {
    number: z.number().int().positive().optional(),
    url: z.string().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async (args) => {
    // resolve ref, fetchPullRequestContext, return textResult(brief)
  },
);

tool(
  "git_pr_review",
  "Publish a review on a GitHub pull request. Default event COMMENT. Only if the user asked.",
  {
    body: z.string().min(1),
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional(),
    number: z.number().int().positive().optional(),
    url: z.string().optional(),
    comments: z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          body: z.string(),
        }),
      )
      .optional(),
  },
  async (args) => {
    // submitPullRequestReview; never log token
  },
);
```

`GitMcpContext` gana `explicitPublish?: boolean` (el handler **no** lo usa para saltarse el gate: el gate corre en `canUseTool` antes). `getGitHubToken` ya está.

Si `git-mcp.ts` no existe, crear un MCP mínimo **solo** con estas dos tools y `GIT_MCP_SERVER = "chavez-git"`. Cuando plan 7 aterrice, fusionar en el mismo server (un solo `mcp__chavez-git`).

- [ ] Extender `canonicalToolName` / `summarizeToolInput`:

  - `git_pr_get` → `pr #N` o `pr URL`
  - `git_pr_review` → `review COMMENT pr #N` (primeras 80 chars del body; **nunca** el PAT)

- [ ] Approval prompt kind nuevo:

```ts
| {
    kind: "git_pr_review";
    event: string;
    body: string;
    pr: string; // url o owner/repo#n
  }
```

Texto: `Publicar review ${event} en ${pr}\n\n${body.slice(0, 500)}`. Paths no aplican.

- [ ] Tests `cli/src/llm/review-gate.test.ts`:

  1. `git_pr_get` en plan/auto/ask → allow.
  2. `git_pr_review` + plan → deny `PLAN_REVIEW_PUBLISH_DENIED`.
  3. `git_pr_review` + ask → ask (aunque `explicitPublish: false`).
  4. `git_pr_review` + auto + `explicitPublish: false` → deny `AUTO_REVIEW_PUBLISH_DENIED`.
  5. `git_pr_review` + auto + `explicitPublish: true` → allow.
  6. `mcp__chavez-git__git_pr_review` se parsea igual.
  7. `Write` → passthrough.

- [ ] Tests bash: `gh pr review 1 --approve` deny `REVIEW_USE_DEDICATED_TOOL`; `ls` passthrough.

- [ ] Test MCP: handler `git_pr_review` con `fetchImpl` 200; el output contiene `html_url` y **no** el token. Handler con token null → `isError` + `GITHUB_UNLINKED`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/review-gate.test.ts src/llm/git-can-use.test.ts \
  src/llm/git-bash.test.ts src/llm/git-mcp.test.ts src/llm/git-approval.test.ts \
  src/llm/tool-names.test.ts src/llm/tool-display.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/review-gate.ts cli/src/llm/review-gate.test.ts \
  cli/src/llm/git-names.ts cli/src/llm/git-can-use.ts cli/src/llm/git-can-use.test.ts \
  cli/src/llm/git-bash.ts cli/src/llm/git-bash.test.ts \
  cli/src/llm/git-mcp.ts cli/src/llm/git-mcp.test.ts \
  cli/src/llm/git-approval.ts cli/src/llm/git-approval.test.ts \
  cli/src/llm/approval-prompt.ts cli/src/llm/tool-names.ts \
  cli/src/llm/tool-display.ts cli/src/llm/execution-gate.ts \
  cli/src/llm/can-use-tool.ts
git commit -m "feat(review): git_pr_get/git_pr_review MCP and mode gate"
```

---

## Task 4: `publishAgentTurn` + daemon/TUI dispatch — el turn de review

**Files:**

- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx` (solo el handler de `agent.turn.dispatch`: pasar `metadata`)
- Create: `cli/src/llm/review-turn.ts`
- Test: `cli/src/llm/review-turn.test.ts`

El LLM se llama **después** de hidratar. Si hydrate falla, `chat.stream.error` + `agent.turn.ended`, sin `query()`.

- [ ] Crear `cli/src/llm/review-turn.ts` — orquesta parse + hydrate + metadata. Firma:

```ts
export async function prepareReviewTurn(input: {
  cwd: string;
  chatId: string;
  prompt: string;
  metadata?: Record<string, unknown> | null;
  executionMode: "plan" | "auto" | "ask";
  client: { request: (msg: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }> };
  getGitHubToken: () => Promise<string | null>;
  collectDiffVsHead: ReviewHydrateInput["collectDiffVsHead"];
  resolveOrigin: ReviewHydrateInput["resolveOrigin"];
}): Promise<
  | {
      ok: true;
      llmPrompt: string;
      userPrompt: string;
      explicitPublish: boolean;
      meta: ReviewMeta;
    }
  | { ok: false; error: string }
>;
```

Algoritmo:

1. `parsed = parseReviewPrompt(input.prompt)` o `input.metadata.review` si ya viene estructurado (`pr`, `explicitPublish`).
2. `explicitPublish = parsed.explicitPublish || userAskedToPublishReview(input.prompt) || metadata.review.explicitPublish === true`.
3. `chat.get` → `diffs` (si el payload no los trae, `[]`).
4. `hydrateReview({ pr: parsed.pr ?? metadata.review.pr, diffs, githubToken, … })`.
5. Si `!ok`, devolver el error (no throw).
6. `userPrompt = parsed?.note || (isReviewCommand(prompt) ? REVIEW_USER_PROMPT : prompt)`.
7. `llmPrompt = composeReviewPrompt({ userPrompt, brief, mode })`.
8. `meta: { kind: REVIEW_KIND, target, streamId, pr, explicitPublish, files, truncated }`.

- [ ] Test `cli/src/llm/review-turn.test.ts` con `client.request` fake y `collectDiffVsHead` stub:

  1. Prompt `/review` + diffs del turn → `meta.target === "turn_diff"`, `llmPrompt` contiene `<review>` y el preview, `userPrompt === REVIEW_USER_PROMPT`.
  2. Prompt `/review` + diffs `[]` + HEAD sucio → `working_tree`.
  3. Prompt `/review` + no git + no diffs → `{ ok: false, error: REVIEW_NO_DIFF }`.
  4. Prompt `/review 12` + token null → `{ ok: false, error: GITHUB_UNLINKED }` (aunque haya diffs locales: el usuario pidió PR).
  5. Prompt `/review --publish` + working tree → `explicitPublish: true`.
  6. Prompt `explica el módulo` **no** entra a hydrate (el caller no llama `prepareReviewTurn` si `!isReviewCommand && metadata.kind !== REVIEW_KIND`). Exportar helper:

```ts
export function shouldRunReviewTurn(
  prompt: string,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (metadata && metadata.kind === REVIEW_KIND) return true;
  return isReviewCommand(prompt);
}
```

  Test: `"please review this later"` → false. `{ kind: "code_review" }` → true.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Aceptar `metadata?: Record<string, unknown>` y `executionMode?: "plan"|"auto"|"ask"` (si no viene, leer prefs como ya hace el plan 3; si plan 3 no aterrizó, default `"ask"`).
  2. Si `shouldRunReviewTurn(prompt, metadata)`:
     - `prep = await prepareReviewTurn(…)`.
     - Si `!prep.ok`: `chat.append` user con el prompt original + `metadata: { kind: REVIEW_KIND, error: prep.error }` **o** no appendear y emitir `chat.stream.error` + return. Preferir: append user (el usuario ve lo que pidió) y `chat.stream.error` con `prep.error`. **No** llamar `runClaudeTurn`.
     - Si ok: `chat.append` user `content: prep.userPrompt` `metadata: prep.meta`. `runClaudeTurn({ prompt: prep.llmPrompt, …, explicitPublish: prep.explicitPublish })`.
  3. `chat.stream.end` del assistant mergea `metadata.review = prep.meta`.
  4. En `tool_result` de `git_pr_review`: si el output matchea `https://github.com/.*/pull/\d+#(?:discussion_)?reviews?/\d+` o `html_url` de reviews, poner `metadata.reviewUrl` y `metadata.published = true`. Extraer `extractReviewUrl(text: string): string | null`.
  5. El PAT no se appendea.

- [ ] En `cli/src/llm/claude-runner.ts`:

  - Aceptar `appendSystemPrompt` extra (si ya hay de modos/git, concatenar `reviewSystemPrompt(mode)` cuando el turn es review; `composeReviewPrompt` ya lo mete en el user prompt — **no duplicar**: o va en `appendSystemPrompt` **o** en el prompt, no ambos. Esta fase lo deja en el prompt de `composeReviewPrompt` y **no** toca `appendSystemPrompt` salvo que el runner ya lo use para plan/git; en ese caso no re-prependar `REVIEW_PREAMBLE`).
  - Pasar `explicitPublish` al closure de `canUseTool`.
  - Registrar MCP git si plan 7 lo hace; las tools nuevas ya están en Task 3.

- [ ] En `cli/src/ws/daemon.ts` y el `onPush` de `tui/src/App.tsx`:

```ts
const data = (msg.data || {}) as {
  chatId?: string;
  prompt?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  executionMode?: "plan" | "auto" | "ask";
};
await publishAgentTurn({
  client,
  chatId: data.chatId,
  prompt: data.prompt,
  cwd: data.path || path,
  token: config.accessToken,
  metadata: data.metadata,
  executionMode: data.executionMode,
});
```

No cambiar el lock `turnBusy` / `turnBusyRef`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/review-turn.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/review-turn.ts cli/src/llm/review-turn.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/claude-runner.ts \
  cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(review): hydrate and run code_review turns on the daemon"
```

---

## Task 5: API — dispatch con `metadata.review`, persistencia, fan-out `github.review.submitted`

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `api/openapi/openapi.yaml`
- Test: `api/src/ws/review-dispatch.test.ts`

La API **no** llama a GitHub. **No** hay migración.

- [ ] `ClientMessage` ya tiene `metadata?: Record<string, unknown>`. Dejarlo. No hace falta campo top-level `review`. Documentar en comentario que `metadata.kind === "code_review"` viaja en `agent.turn.request`.

- [ ] En `api/src/ws/handlers.ts` case `agent.turn.request`:

  1. Seguir exigiendo `chatId` + `prompt.trim()`. Un review sin prompt: si `metadata.kind === REVIEW_KIND` y el prompt vacío, sustituir por `REVIEW_USER_PROMPT` (importar de `api/src/llm/review-constants.ts`). Si no es review y prompt vacío, el 400 existente.
  2. El `hub.pushEvent("agent.turn.dispatch", { … })` **añade**:

```ts
metadata: msg.metadata || undefined,
executionMode: /* prefs.activeExecutionMode si plan 3 aterrizó; si no, omitir */,
```

  3. No hidratar. No `fetch` a `api.github.com`. No leer `turn_file_diffs` aquí (el daemon hace `chat.get`).

- [ ] Case nuevo `github.review.submitted` **no** lo manda el cliente. Lo manda el daemon como request tras un POST 200:

  - Tipo: el daemon hace `client.request({ type: "github.review.submitted", metadata: { url, number, event, owner, repo, chatId, streamId } })`.
  - Handler API: valida `userId` de la conexión daemon, broadcast `github.review.submitted` a todos los sockets del user, responde `{ ok: true }`.
  - Si `metadata.url` falta, `fail` y **no** broadcast.

Alternativa más simple (preferida, menos RPC): en `chat.tool.result`, si `toolName` canónico es `git_pr_review` y `metadata.reviewUrl`, la API broadcast `github.review.submitted` con esos campos. Implementar **esta** vía (un solo camino, igual que `github.pr.created` del plan 7).

En el handler existente `chat.tool.result` (después de persistir):

```ts
const meta = (msg.metadata || {}) as Record<string, unknown>;
const name = String(msg.toolName || meta.toolName || "");
const reviewUrl = typeof meta.reviewUrl === "string" ? meta.reviewUrl : null;
if ((name === "git_pr_review" || name.endsWith("__git_pr_review")) && reviewUrl && msg.status !== "error") {
  broadcast(userId, "github.review.submitted", {
    url: reviewUrl,
    chatId: msg.chatId,
    event: meta.event || "COMMENT",
    number: meta.prNumber,
    owner: meta.owner,
    repo: meta.repo,
  });
}
```

- [ ] `chat.append` / `chat.stream.end` ya persisten `metadata`. Verificar que el spread `…msg.metadata` **no** se pierde (plan 2/6). Si `chat.stream.end` solo guarda `streamId`, extender a `{ streamId, ...msg.metadata }` — **sin** borrar `streamId`.

- [ ] Extraer `shouldStampReviewDispatch(msg: { prompt?: string; metadata?: Record<string, unknown> }): string` (prompt efectivo) en `api/src/ws/review-dispatch.ts` para testearlo sin Hono:

```ts
import { REVIEW_KIND, REVIEW_USER_PROMPT } from "../llm/review-constants";

export function effectiveReviewPrompt(msg: {
  prompt?: string;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const prompt = (msg.prompt || "").trim();
  const isReview = msg.metadata?.kind === REVIEW_KIND;
  if (isReview) return prompt || REVIEW_USER_PROMPT;
  return prompt || null;
}
```

Test: review + prompt vacío → `REVIEW_USER_PROMPT`; no-review + vacío → `null`; review + “mira el auth” → ese texto.

- [ ] OpenAPI: tag WebSocket, documentar `metadata.kind = code_review` en `agent.turn.request` y el push `github.review.submitted`. Nota: API no llama a GitHub.

- [ ] Correr:

```bash
cd api && bun test src/ws/review-dispatch.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/handlers.ts api/src/ws/review-dispatch.ts \
  api/src/ws/review-dispatch.test.ts api/src/ws/protocol.ts \
  api/openapi/openapi.yaml cli/src/ws/client.ts web/src/lib/ws-client.ts
git commit -m "feat(review): dispatch metadata.kind=code_review and fan-out submitted reviews"
```

---

## Task 6: Slash `/review` + CLI `headless chat review` + watch

**Files:**

- Modify: `cli/src/llm/slash.ts`
- Test: `cli/src/llm/slash.test.ts` (extender)
- Modify: `web/src/lib/slash.ts` (si el plan 11 lo copió; si no, Task 8 usa `web/src/lib/review.ts`)
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (crear casos review si el archivo no existe)
- Test: `cli/src/llm/watch-format.test.ts`
- Modify: `cli/src/llm/history.ts` (solo si `slash_result` se salta; review **sí** entra al LLM)

`/review` **no** es un `slash_result` mudo: dispara un turn. El compositor intercepta Enter y llama `agent.turn.request` con `metadata.kind = "code_review"`.

- [ ] Extender `SLASH_COMMAND_IDS` con `"review"` (al final, no reordenar los 9 existentes). Catálogo:

| id | usage | summary |
|---|---|---|
| `review` | `/review [pr\|URL\|#n] [--publish]` | Turn de review del diff, working tree o PR |

Picker: máx 10. Args que completa:

| Prefijo | Candidatos |
|---|---|
| `/review ` | `--publish`, `--submit`, `pr` |
| `/review pr ` | (nada más; el número lo escribe el usuario) |

`parseSlash("/review 42 --publish")` → `{ id: "review", args: "42 --publish" }`. Unknown sigue `UNKNOWN_SLASH`. `/help` lista el nuevo comando **y** los 3 modos (no borrar `HELP_MODES`).

Si `cli/src/llm/slash.ts` no existe, crear un parser mínimo **solo** para `/review` (`parseReviewPrompt` ya cubre el string) y documentar que plan 11 lo fusiona en el catálogo.

- [ ] Dispatcher slash (TUI/CLI, el módulo que plan 11 llama `dispatchSlash`):

```ts
if (parsed.id === "review") {
  const raw = `/review ${parsed.args}`.trim();
  const req = parseReviewPrompt(raw) || {
    command: true as const,
    pr: null,
    explicitPublish: false,
    note: "",
  };
  return {
    kind: "turn",
    prompt: req.note || REVIEW_USER_PROMPT,
    metadata: {
      kind: REVIEW_KIND,
      review: {
        pr: req.pr,
        explicitPublish: req.explicitPublish,
      },
    },
  };
}
```

El compositor **no** manda el texto `/review` crudo al LLM. Headless `chat ask <id> /review` también: si `shouldRunReviewTurn(prompt)`, `agent.turn.request` con metadata (el daemon hidrata igual aunque el cliente olvide el kind).

- [ ] Tests slash: picker `/rev` incluye `review`; `/review --pub` afina a `--publish`; `/reviewito` no es review; help contiene `/review`.

- [ ] En `cli/src/commands/headless.ts` acción `review` (junto a `ask`):

```
chavez headless chat review <chatId> [prUrlOrNumber] [--publish]
```

Implementación:

```ts
if (action === "review") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: … chat review <chatId> [prUrl|#n] [--publish]");
  const raw = ["review", ...rest.slice(1)].join(" ");
  const parsed = parseReviewPrompt(raw) || {
    command: true as const,
    pr: null,
    explicitPublish: userAskedToPublishReview(raw),
    note: "",
  };
  const res = await client.request(
    {
      type: "agent.turn.request",
      chatId,
      prompt: parsed.note || REVIEW_USER_PROMPT,
      metadata: {
        kind: REVIEW_KIND,
        review: { pr: parsed.pr, explicitPublish: parsed.explicitPublish },
      },
    },
    30_000,
  );
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  console.log("Review aceptado por el daemon. Usa `chat watch` o el hub web para ver el stream.");
  return;
}
```

Sin daemon: el error del RPC se imprime tal cual (`NO_DAEMON_ERROR`). Exit ≠ 0.

- [ ] `cli/src/index.ts` `usage()`: añadir `chavez headless chat review <chatId> [pr|#n] [--publish]`.

- [ ] Extender `formatWatchLine`:

```ts
if (meta.kind === REVIEW_KIND || data.kind === REVIEW_KIND) {
  const target = String(meta.target || data.target || "review");
  const files = meta.files ?? data.files;
  const pr = meta.pr && typeof meta.pr === "object" ? meta.pr as { url?: string; number?: number } : null;
  const prBit = pr?.url ? pr.url : pr?.number != null ? `#${pr.number}` : "";
  return `review · ${target}${files != null ? ` · ${files} files` : ""}${prBit ? ` · ${prBit}` : ""}`;
}
if (msg.type === "github.review.submitted") {
  const url = String(data.url || "");
  return url ? `review · published ${url}` : "review · published";
}
```

En `chat.tool.result` canónico `git_pr_review` + `reviewUrl` → `review · published ${url}`.

Tests: user append kind review working_tree 3 files; submitted url; un `ghp_SECRETO` en input se redacta (reusar sanitize).

- [ ] `historyFromChatMessages`: el user `code_review` **entra** al historial (es un turn real). Los `slash_result` siguen fuera. No filtrar `kind === code_review`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/slash.test.ts src/llm/watch-format.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/slash.ts cli/src/llm/slash.test.ts \
  web/src/lib/slash.ts cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  cli/src/llm/history.ts
git commit -m "feat(review): /review slash, headless chat review, watch lines"
```

---

## Task 7: TUI — tecla `r`, banner `review ·`, findings en la timeline

**Files:**

- Modify: `tui/src/App.tsx`

TUI es daemon: hidrata **y** pinta. Importa `cli/src/llm/review-*.ts`.

- [ ] State:

```ts
type ReviewBanner = {
  target: string | null;
  prUrl: string | null;
  publishedUrl: string | null;
  error: string | null;
};
```

- [ ] Tecla `r` en modo command (no compose, no busy): dispara review del target automático (`prompt: REVIEW_USER_PROMPT`, `metadata: { kind: REVIEW_KIND, review: { explicitPublish: false } }`) vía `publishAgentTurn` local (la TUI **es** el daemon) **o** `agent.turn.request` si se prefiere paridad Web — usar `publishAgentTurn` directo como `sendWithLlm`, con `metadata`. Si no hay `activeChatId`, `setLog(NO_CHAT_ERROR)` (`"No hay chat activo"` del plan 11, o el string existente).

- [ ] Tecla `R` (shift): igual con `explicitPublish: true` (el usuario lo pidió de forma explícita). El gate de auto/ask/plan sigue aplicando: en plan se deniega el POST; en ask pide approve; en auto publica.

- [ ] Footer/help: `r review` junto a las teclas existentes. No reutilizar `p` (provider) ni `g` (git).

- [ ] `Message` type: si aún no tiene `metadata`, añadir `metadata?: Record<string, unknown>` (varios planes lo piden; si ya está, no duplicar).

- [ ] Pintado:

  - User con `metadata.kind === "code_review"`: prefijo `review · {target}` + content. Si `pr.url`, mostrarlo.
  - Tool `git_pr_get` / `git_pr_review`: misma `ToolCard`/línea que el resto (status `start` / `awaiting_approval` / `done` / `error`). En ask, `[y]/[n]` del plan 13 aplica a `git_pr_review` y a Write de fix **uno a uno**.
  - Push `github.review.submitted` → `setReviewBanner({ publishedUrl })` y log `review · published {url}`.

- [ ] Error `REVIEW_NO_DIFF` / `GITHUB_UNLINKED` / `NO_DAEMON_ERROR`: `setLog` con el string exacto. No crashear la TUI.

- [ ] `preview` de lista (si hay recorte de últimos N): un review se ve `review · {target}`, no un user vacío.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(review): TUI r/R starts a code_review turn"
```

---

## Task 8: Web — botón Review, PR opcional, banner, misma timeline

**Files:**

- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Test: `web/src/lib/review.test.ts` (ya en Task 1; extender labels si se añaden)

Web **no** hidrata. Manda `agent.turn.request` y pinta el fan-out.

- [ ] Extender `useWsAgentTurn` para aceptar metadata:

```ts
export function useWsAgentTurn() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      prompt: string;
      metadata?: Record<string, unknown>;
    }) =>
      ws.request({
        type: "agent.turn.request",
        chatId: input.chatId,
        prompt: input.prompt,
        metadata: input.metadata,
      }),
  });
}
```

El form existente de prompt **sigue** mandando sin metadata (turn normal). No romper `onAgent`.

- [ ] En `ChatDetailPanel.tsx`, panel “Review” debajo del compositor (o un botón al lado de submit):

  - Input opcional `prRef` (placeholder `URL o #n`).
  - Checkbox `Publicar en GitHub` → `explicitPublish`.
  - Botón `Review`. Disabled si `agent.isPending || ws.status !== "open"`.

```ts
async function onReview(e: FormEvent) {
  e.preventDefault();
  const parsed = parseReviewPrompt(
    ["review", prRef.trim(), explicitPublish ? "--publish" : ""].filter(Boolean).join(" "),
  );
  try {
    await agent.mutateAsync({
      chatId,
      prompt: parsed?.note || REVIEW_USER_PROMPT,
      metadata: {
        kind: REVIEW_KIND,
        review: {
          pr: parsed?.pr ?? parseGitHubPrRef(prRef.trim()),
          explicitPublish,
        },
      },
    });
    setMsg({ kind: "ok", text: "Review enviado al daemon" });
  } catch (err) {
    setMsg({ kind: "error", text: formatQueryError(err) });
  }
}
```

Sin daemon, el error del RPC se muestra (`NO_DAEMON_ERROR`). No hay file input (fuera de alcance: upload desde el navegador).

- [ ] Timeline:

  - User `isReviewKind(m.metadata)` → badge `review · {target}` + content. Si `metadata.pr.url`, link.
  - Assistant del mismo turn: findings normales (no sustituir `DiffsPanel` del plan 6; el review **lee** esos diffs, no los reemplaza).
  - Tool cards: `git_pr_review` en `awaiting_approval` usa los botones Aprobar/Rechazar existentes (plan 3/13). Un Write de fix en el mismo turn es **otro** pedido, uno a uno.

- [ ] Banner persistente (reload-friendly, derivado de `chat.get`):

  - Si el último user/assistant tiene `kind=code_review`, mostrar `Review · {target}` + files.
  - Si llegó `github.review.submitted` o `metadata.publishedUrl`, mostrar el URL.
  - Escuchar `github.review.submitted` en `ws.onPush` e invalidar `queryKeys.chat(chatId)`.

- [ ] `WorkspaceDetailPanel.tsx` `previewLabel`: si `isReviewKind(m.metadata)` devolver `review · {target}`; si tool `git_pr_review`, `review · published` cuando status done.

- [ ] Si el compositor ya intercepta `/` (plan 11), `/review` usa el dispatcher de Task 6 (kind turn + metadata). No abrir el picker `@`. Test manual en steps de Task 9.

- [ ] Commit:

```bash
git add web/src/components/ChatDetailPanel.tsx web/src/lib/ws-hooks.ts \
  web/src/components/WorkspaceDetailPanel.tsx web/src/lib/review.ts \
  web/src/lib/review.test.ts
git commit -m "feat(review): Web Review button, PR field, live banner"
```

---

## Task 9: Escenarios Gherkin — CLI + TUI + Web, mismos strings

**Files:**

- Create: `cli/src/llm/review-gherkin.test.ts`
- Modify: `cli/scripts/ws-sync-smoke.ts` (solo un caso review-sin-daemon; no reescribir el smoke)

Cerrar los 3 escenarios del [`plan.md`](./plan.md) con tests deterministas (stubs de git/GitHub). Nada de red real.

- [ ] Crear `cli/src/llm/review-gherkin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GITHUB_UNLINKED } from "./git-constants";
import { AUTO_REVIEW_PUBLISH_DENIED, PLAN_REVIEW_PUBLISH_DENIED, REVIEW_NO_DIFF } from "./review-constants";
import { gateReviewTool } from "./review-gate";
import { hydrateReview } from "./review-hydrate";
import { prepareReviewTurn, shouldRunReviewTurn } from "./review-turn";
```

Cubrir **exactamente**:

1. **Review del diff del turn.** `hydrateReview` con `diffs` applied del último `streamId` y un `collectDiffVsHead` que **throw** si se llama → `target: "turn_diff"`. `composeReviewPrompt` contiene el preview. `gateMutation`/`gateReviewTool`: `Write` en `plan` deny (`PLAN_MUTATION_DENIED` o el gate de plan 3); `Write` en `ask` → ask; `git_pr_review` no hace falta en este escenario.

2. **En plan no escribe.** `gateReviewTool({ mode: "plan", sdkName: "git_pr_review", explicitPublish: true })` deny `PLAN_REVIEW_PUBLISH_DENIED`. Documentar en el test que Write/Edit/Bash siguen el gate de plan 3 (`PLAN_MUTATION_DENIED`) — si `execution-gate.ts` existe, assert `gateMutation("plan", "Write") === "deny"`.

3. **En ask los writes de fix se aprueban uno a uno.** `gateMutation("ask", "Write") === "ask"` y `gateMutation("ask", "Read") === "allow"`. `gateReviewTool` ask + `git_pr_review` → `ask`. No hay API de lote en el gate.

4. **Review de un PR GitHub.** `parseGitHubPrRef` URL → ref. `hydrateReview` con `fetchImpl` 200 + files → `target: "github_pr"`, brief con title y patches. Token null → error `GITHUB_UNLINKED` (no se llama fetch).

5. **Resultado puede ser comentario en el chat.** `prepareReviewTurn` ok **no** llama `submitPullRequestReview`. `explicitPublish: false` + auto + `git_pr_review` → `AUTO_REVIEW_PUBLISH_DENIED`. El assistant del turn es el comentario.

6. **Publicar review pide ask.** `gateReviewTool({ mode: "ask", sdkName: "git_pr_review", explicitPublish: false })` → `ask`.

7. **Auto no publica salvo explícito.** `explicitPublish: false` deny `AUTO_REVIEW_PUBLISH_DENIED`; `true` allow. Mismo listón que commit: el preamble de git dice “only if the user asked”; aquí el flag es el testigo.

8. **Sin PR: review local, no falla por GitHub.** `hydrateReview` sin `pr`, token `null`, repo sucio → `ok: true, target: "working_tree"`. El error **no** es `GITHUB_UNLINKED`. Sin repo y sin diffs → `REVIEW_NO_DIFF`, tampoco `GITHUB_UNLINKED`.

9. **shouldRunReviewTurn.** `/review` true; `{ kind: "code_review" }` true; `"please review this later"` false.

- [ ] En `cli/scripts/ws-sync-smoke.ts`, después del caso sin daemon existente, añadir un `agent.turn.request` con `metadata.kind = "code_review"` **sin** daemon y assert que el error es exactamente `NO_DAEMON_ERROR`. No abrir un review real contra GitHub.

- [ ] Correr:

```bash
cd cli && bun test src/llm/review-gherkin.test.ts \
  src/llm/review-parse.test.ts src/llm/review-pick.test.ts \
  src/llm/review-format.test.ts src/llm/review-hydrate.test.ts \
  src/llm/review-github.test.ts src/llm/review-gate.test.ts \
  src/llm/review-turn.test.ts src/llm/slash.test.ts \
  src/llm/watch-format.test.ts
cd api && bun test src/ws/review-dispatch.test.ts src/llm/review-constants.test.ts
cd web && bun test src/lib/review.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/review-gherkin.test.ts cli/scripts/ws-sync-smoke.ts
git commit -m "test(review): Gherkin turn diff, GitHub PR, local working tree"
```

---

## Verificación manual (no sustituye los tests)

Tras mergear planes 3, 6 y 7:

1. `chavez headless workspace open` en un repo sucio. `chavez headless chat review <chatId>`. `chat watch` muestra `review · working_tree`. Assistant comenta. Sin GitHub linked, **no** aparece `GITHUB_UNLINKED`.
2. Un turn que escribió archivos (plan 6). `/review` en TUI o Web → `review · turn_diff · N files`. En modo `plan`, un Write del modelo se deniega y el disco queda igual. En `ask`, cada Write de fix pide `[y]/[n]` / Aprobar.
3. `chavez provider link github`. `/review https://github.com/<owner>/<repo>/pull/<n>`. Brief con title del PR. Findings en el chat. `git_pr_review` en `ask` muestra el body y espera approve. En `auto` sin `--publish`, la tool se deniega con `AUTO_REVIEW_PUBLISH_DENIED`. `/review <n> --publish` en `auto` sí POST y `watch` imprime `review · published {url}`.
4. Web, TUI y `chat watch` coinciden en target, findings y URL publicada. Reload de Web reconstruye el banner desde `chat.get`.
5. Sin daemon: el botón Review / `chat review` / tecla `r` fallan con `No daemon bound for this workspace. Run: chavez headless workspace open`.
