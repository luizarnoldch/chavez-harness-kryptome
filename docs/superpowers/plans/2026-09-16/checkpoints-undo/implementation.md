# Checkpoints undo Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, slash `/undo` (plan 11), git commit/push/PR (plan 7), cola de turns (plan 29), worktrees paralelos (plan 28), cancel-as-undo, ni restore ciego sin git. Spec: [`plan.md`](./plan.md). Depende del contrato de turns (`agent.turn.request` / `dispatch` / `publishAgentTurn`) y, si existe, de los diffs por `streamId` en [`diffs-review`](../diffs-review/implementation.md) (paths aplicados). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario deshace **solo el último turn** cuando el workspace es un repo git. Undo corre en el **daemon** (cwd real): restaura los archivos que ese turn tocó al árbol capturado **antes** del turn. Los commits que el turn hubiera creado se **revierten** o se **avisa** (nunca `reset --hard`, nunca force-push). Sin git, undo está deshabilitado con mensaje y **el disco no se toca**. Un turn en `ask` donde se rechazaron todos los edits es **no-op** y lo dice. Retry dispara un **turn nuevo** con el mismo texto y attaches; **no** re-ejecuta tools históricas. Web y TUI disparan undo; el otro cliente ve el turn marcado `undone`.

**Architecture:** El filesystem y git viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** corre git: persiste el checkpoint en `chat_messages.metadata` (jsonb, **sin migración**), hace CAS del último turn, reenvía `agent.turn.undo` al daemon y hace fan-out de `chat.checkpoint.undone`. El snapshot es un commit colgante en `refs/chavez/checkpoints/<streamId>` creado con un index aislado (`GIT_INDEX_FILE`) para no ensuciar el index ni el stash del usuario.

```
Turn start (daemon)
  detectGit(cwd)
    no repo → checkpoint.kind = "none"  (undo deshabilitado)
    repo    → isolated git add -A + write-tree + commit-tree
              refs/chavez/checkpoints/<streamId>
              { kind:"git", headSha, commitSha, branch }
  chat.append user  metadata.streamId + metadata.checkpoint
        |
        v
  query() tools (Write/Edit/Bash…)
        |
Turn end (daemon)
  finalize: paths (allowlist), commitsCreated, hadBash, appliedMutations
  chat.checkpoint.finalized  → API parchea metadata
        |
Undo (Web | TUI | CLI)
  agent.turn.undo { chatId }
        |
        v
  API  selectLastTurn  →  solo el más reciente
        |  !git / kind none     → fail UNDO_REQUIRES_GIT  (no dispatch)
        |  !appliedMutations    → ok noop UNDO_NOOP       (no dispatch)
        |  already undone       → fail UNDO_ALREADY
        |  turn busy            → fail TURN_BUSY_ERROR
        |  else                 → agent.turn.undo.dispatch → daemon
        |
  daemon  git restore --source=<commitSha>  SOLO checkpoint.paths
          created → unlink;  modified/deleted → restore
          commitsCreated → git revert --no-edit  |  warn + abort
          hadBash → SHELL_SIDE_EFFECT_WARNING
          agent.turn.undo.result
        |
  API persist metadata.undone + broadcast chat.checkpoint.undone
        |
        v
  Web badge · TUI [undone] · CLI watch  (mismo contrato)

Retry
  agent.turn.retry { chatId }
        → último prompt + mentions/attachments persistidos
        → agent.turn.dispatch  (turn NUEVO, query() fresco)
        → history.ts tira role=tool  → no tool_use históricos
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/publish-turn.ts` appendea el user **sin** `streamId`/`checkpoint`, corre Claude, emite `chat.stream.*` / `chat.tool.*`. **No** hay snapshot git.
- `cli/src/ws/daemon.ts` solo atiende `agent.turn.dispatch`. `turnBusy` ignora un segundo dispatch. **No** hay handler de undo.
- `tui/src/App.tsx` es daemon: `publishAgentTurn` local + onPush de `agent.turn.dispatch`. `Message = { id, role, content }` **sin** metadata. Tecla `m` compose; Escape mata la TUI. **No** hay `u`/`r`.
- `api/src/ws/handlers.ts` despacha `agent.turn.request` → `agent.turn.dispatch`. `chat.append` ya persiste `metadata`. **No** hay `agent.turn.undo` / `retry` / `chat.checkpoint.*`.
- `api/src/db/schema.ts` `chat_messages.metadata` jsonb **ya existe**. No hay tabla nueva. No hay migración.
- Web `ChatDetailPanel.tsx`: compositor + timeline. Sin botones Undo/Retry. Sin badge `undone`.
- CLI `chavez headless chat` : `create|list|append|get|ask|watch`. **No** hay `undo` ni `retry`.
- `cli/src/llm/history.ts` **tira** filas `role=tool`. Correcto para retry: el SDK no recibe `tool_use` viejos.
- Cursor `runnable: false`. No simular undo de Cursor. Cuando el plan 4 lo haga ejecutable, reutiliza el mismo checkpoint (el snapshot es git, no del provider).
- Plan 6 (`diffs-review`) deja `streamId` + paths `applied`. Si la tabla `turn_file_diffs` existe, `finalize` **une** esos paths al allowlist; si no, el allowlist sale de `git diff --name-only <checkpointSha>` en el instante del `finalize`.
- Plan 11 (`/undo`) **no** se implementa aquí: esta fase expone RPC + botones + `chat undo`. Slash llamará el mismo `agent.turn.undo`.
- Plan 7 (commit/push/PR) **no** se implementa. Git aquí es sensor + restore, no tool de producto.
- Cancel (plan 16) **no** es undo: un cancel deja los writes ya aplicados; undo los revierte después si hay git.

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (sin migración), git CLI en el daemon (`git -C <cwd>`), Claude Agent SDK `query` (sin cambios de tools), Ink TUI, Astro/React web. Sin paquete git.js / isomorphic-git / simple-git.

**Global Constraints:**

1. El filesystem y git se tocan **solo** en el daemon (cwd del workspace). API y browser no ejecutan `git`, no copian blobs, no “restauran” desde el servidor.
2. Sin daemon bound, `agent.turn.undo` y `agent.turn.retry` fallan con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Sin repo git (`rev-parse --is-inside-work-tree` ≠ `true`), undo está **deshabilitado**. El error es exactamente `UNDO_REQUIRES_GIT`. **Cero** writes al disco (ni `unlink`, ni copiar snapshots de diffs).
4. Undo afecta **solo el último turn** del chat (el más reciente con `metadata.streamId` / `checkpoint`). El turn anterior no se toca. Un segundo undo del mismo turn es `UNDO_ALREADY` (no camina hacia atrás).
5. Restore **allowlist**: únicamente `checkpoint.paths` congelados al `finalize`. No se restaura el working tree entero (edits del usuario a otros archivos se quedan).
6. Commits del turn: `git revert --no-edit` de `commitsCreated` que sigan en la historia. Conflicto → `git revert --abort` + aviso. **Prohibido:** `git reset --hard`, `git reset --keep`, `git push --force`, `git checkout .` masivo, `git clean -fd`.
7. Turn en `ask` con todos los writes denegados (`appliedMutations === false` y HEAD igual): undo es **no-op**, respuesta `ok: true` con `noop: true` y `UNDO_NOOP`. No se marca `undone`. Disco intacto.
8. Bash destructivo: git restaura lo **versionado** (presente en el árbol del checkpoint). Si `hadBash`, el resultado **siempre** incluye `SHELL_SIDE_EFFECT_WARNING`. No se inventa un undo de `rm` sobre gitignored.
9. Retry = `agent.turn.request` nuevo con el mismo `prompt` + `mentions` / snapshot `attachments` del user original. `historyFromChatMessages` sigue tirando `role=tool`. El SDK **no** recibe `tool_use` históricos; no se re-ejecutan tools.
10. 1 turn por daemon. Undo/retry con `turnBusy` fallan `TURN_BUSY_ERROR`. Undo pone `undoBusy` breve para no mezclar con un dispatch.
11. Web, TUI y CLI `watch` ven el mismo contrato: `chat.checkpoint.undone` + `metadata.undone` en el mensaje del turn. Un reload de `chat.get` reconstruye el badge.
12. El primero que pide undo gana (`undoInflight`). El segundo recibe `UNDO_IN_FLIGHT` o `UNDO_ALREADY`.
13. Claude es el provider ejecutable. Cursor vinculado no ejecuta turns aquí; el checkpoint git (si el turn llegó a correr) se desharía igual porque opera sobre disco, no sobre el SDK.
14. Hidden refs `refs/chavez/checkpoints/*` no se pushean (no están en `refs/heads`). No se añade un remote. El index aislado se borra tras `write-tree`.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/undo`, commit/PR, cola, worktrees, restore sin git a partir de blobs de diffs.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `UNDO_REQUIRES_GIT` | `"Undo requires a git repository in the workspace"` |
| `UNDO_NOOP` | `"Nothing to undo: the last turn made no applied changes"` |
| `UNDO_ALREADY` | `"Last turn is already undone"` |
| `UNDO_IN_FLIGHT` | `"Undo already in progress"` |
| `UNDO_NO_CHECKPOINT` | `"Last turn has no git checkpoint"` |
| `UNDO_NOT_LAST` | `"Undo only applies to the latest turn"` |
| `RETRY_NO_PROMPT` | `"No previous prompt to retry"` |
| `SHELL_SIDE_EFFECT_WARNING` | `"Git restored versioned files. Unversioned shell side effects (for example rm of ignored or untracked files) may remain."` |
| `COMMIT_REVERT_WARN` | `"The turn created git commit(s) that could not be reverted cleanly; they remain in history. Versioned files were restored in the worktree where possible."` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `CHECKPOINT_REF_PREFIX` | `"refs/chavez/checkpoints/"` |
| `UNDO_TIMEOUT_MS` | `30_000` |
| `GIT_CMD_TIMEOUT_MS` | `15_000` |
| `NO_GIT_UI` | `"Hace falta git en el workspace para deshacer"` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` si ya existen en `cli/src/llm/tool-names.ts` o el módulo de invariantes; **no** cambiar esos strings.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `chat.checkpoint.created` | daemon → API | Snapshot inicial (`kind` git\|none). API lo fusiona en el user message de ese `streamId`. |
| `chat.checkpoint.finalized` | daemon → API | Allowlist `paths`, `commitsCreated`, `hadBash`, `appliedMutations`. Parchea metadata. Broadcast a clientes. |
| `agent.turn.undo` | cualquier cliente → API | Pedir undo del último turn del `chatId`. |
| `agent.turn.undo.dispatch` | API → daemon | `{ requestId, chatId, streamId, checkpoint, path }` |
| `agent.turn.undo.result` | daemon → API | Completa el pending; API persiste `undone` y responde al cliente. |
| `chat.checkpoint.undone` | API → broadcast | `{ chatId, streamId, restored, commitAction, warning, noop }` |
| `agent.turn.retry` | cualquier cliente → API | Relee el último prompt + attaches y despacha un turn **nuevo**. |

HTTP: ninguno nuevo. `GET /chats/:chatId` y `chat.get` ya devuelven `metadata`; el reload reconstruye botones y badge.

Checkpoint persistido en `chat_messages.metadata` del mensaje **user** del turn (y copia en el assistant al `stream.end` si existe):

```ts
export type CheckpointKind = "git" | "none";

export type Checkpoint = {
  kind: CheckpointKind;
  streamId: string;
  reason?: "not_git" | "git_missing" | "git_error";
  headSha: string | null;
  commitSha: string | null; // hidden ref object
  treeSha: string | null;
  branch: string | null;
  paths: string[];          // posix relativo; allowlist de restore
  commitsCreated: string[]; // shas exclusivos headSha..HEAD al finalize
  hadBash: boolean;
  appliedMutations: boolean;
  createdAt: string;        // ISO-8601
  finalizedAt?: string;
};

// metadata (fragmento) en el user del turn
{
  streamId: string;
  checkpoint: Checkpoint;
  mentions?: string[];
  attachments?: unknown[];
  retryOfStreamId?: string;
  undone?: boolean;
  undoneAt?: string;
  undo?: {
    restored: string[];
    deleted: string[];
    commitAction: "none" | "revert" | "warn";
    reverted?: string[];
    warning?: string;
  };
}
```

Tipos de resultado de undo (data del RPC):

```ts
export type UndoCommitAction = "none" | "revert" | "warn";

export type UndoResult = {
  chatId: string;
  streamId: string;
  noop: boolean;
  message: string;
  restored: string[];
  deleted: string[];
  commitAction: UndoCommitAction;
  reverted: string[];
  warning: string | null; // SHELL_SIDE_EFFECT_WARNING y/o COMMIT_REVERT_WARN
};
```

---

## Task 1: Módulos puros — constantes, último turn, decisión de undo, payload de retry

**Files:**

- Create: `cli/src/llm/undo-constants.ts`
- Create: `cli/src/llm/turn-select.ts`
- Create: `cli/src/llm/undo-decide.ts`
- Create: `cli/src/llm/retry-payload.ts`
- Test: `cli/src/llm/turn-select.test.ts`
- Test: `cli/src/llm/undo-decide.test.ts`
- Test: `cli/src/llm/retry-payload.test.ts`
- Modify: `cli/package.json`

Sin I/O de red ni `git`. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Tasks 2 y 6 duplican constantes + selector.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/undo-constants.ts`:

```ts
export const UNDO_REQUIRES_GIT =
  "Undo requires a git repository in the workspace";
export const UNDO_NOOP =
  "Nothing to undo: the last turn made no applied changes";
export const UNDO_ALREADY = "Last turn is already undone";
export const UNDO_IN_FLIGHT = "Undo already in progress";
export const UNDO_NO_CHECKPOINT = "Last turn has no git checkpoint";
export const UNDO_NOT_LAST = "Undo only applies to the latest turn";
export const RETRY_NO_PROMPT = "No previous prompt to retry";
export const SHELL_SIDE_EFFECT_WARNING =
  "Git restored versioned files. Unversioned shell side effects (for example rm of ignored or untracked files) may remain.";
export const COMMIT_REVERT_WARN =
  "The turn created git commit(s) that could not be reverted cleanly; they remain in history. Versioned files were restored in the worktree where possible.";
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
export const CHECKPOINT_REF_PREFIX = "refs/chavez/checkpoints/";
export const UNDO_TIMEOUT_MS = 30_000;
export const GIT_CMD_TIMEOUT_MS = 15_000;
export const NO_GIT_UI = "Hace falta git en el workspace para deshacer";

export type CheckpointKind = "git" | "none";
export type UndoCommitAction = "none" | "revert" | "warn";
export type CheckpointReason = "not_git" | "git_missing" | "git_error";

export type Checkpoint = {
  kind: CheckpointKind;
  streamId: string;
  reason?: CheckpointReason;
  headSha: string | null;
  commitSha: string | null;
  treeSha: string | null;
  branch: string | null;
  paths: string[];
  commitsCreated: string[];
  hadBash: boolean;
  appliedMutations: boolean;
  createdAt: string;
  finalizedAt?: string;
};

export type UndoResult = {
  chatId: string;
  streamId: string;
  noop: boolean;
  message: string;
  restored: string[];
  deleted: string[];
  commitAction: UndoCommitAction;
  reverted: string[];
  warning: string | null;
};

export function checkpointRef(streamId: string): string {
  return `${CHECKPOINT_REF_PREFIX}${streamId}`;
}

export function joinWarnings(...parts: Array<string | null | undefined>): string | null {
  const xs = parts.map((p) => (p || "").trim()).filter(Boolean);
  return xs.length ? xs.join(" ") : null;
}
```

Si `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` ya existen en otro módulo CLI, **reexportarlos** desde ahí (mismo string) en lugar de duplicar literales distintos.

- [ ] Crear `cli/src/llm/turn-select.ts`:

```ts
import type { Checkpoint } from "./undo-constants";

export type ChatRow = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
};

export type LastTurn = {
  streamId: string;
  user: ChatRow;
  assistant: ChatRow | null;
  checkpoint: Checkpoint | null;
  undone: boolean;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}

export function parseCheckpoint(raw: unknown): Checkpoint | null {
  const o = rec(raw);
  if (!o) return null;
  if (o.kind !== "git" && o.kind !== "none") return null;
  if (typeof o.streamId !== "string" || !o.streamId) return null;
  return {
    kind: o.kind,
    streamId: o.streamId,
    reason:
      o.reason === "not_git" || o.reason === "git_missing" || o.reason === "git_error"
        ? o.reason
        : undefined,
    headSha: typeof o.headSha === "string" ? o.headSha : null,
    commitSha: typeof o.commitSha === "string" ? o.commitSha : null,
    treeSha: typeof o.treeSha === "string" ? o.treeSha : null,
    branch: typeof o.branch === "string" ? o.branch : null,
    paths: asStringArray(o.paths),
    commitsCreated: asStringArray(o.commitsCreated),
    hadBash: Boolean(o.hadBash),
    appliedMutations: Boolean(o.appliedMutations),
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date(0).toISOString(),
    finalizedAt: typeof o.finalizedAt === "string" ? o.finalizedAt : undefined,
  };
}

export function metaOf(row: ChatRow): Record<string, unknown> {
  return rec(row.metadata) ?? {};
}

export function streamIdOf(row: ChatRow): string | null {
  const m = metaOf(row);
  if (typeof m.streamId === "string" && m.streamId) return m.streamId;
  const cp = parseCheckpoint(m.checkpoint);
  return cp?.streamId ?? null;
}

export function isUndone(row: ChatRow): boolean {
  return metaOf(row).undone === true;
}

/**
 * Last agent turn = newest user/assistant row that carries streamId/checkpoint.
 * Tool rows are ignored for grouping. Manual chat.append without streamId is not a turn.
 */
export function selectLastTurn(messages: ChatRow[]): LastTurn | null {
  let streamId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]!;
    if (row.role === "tool") continue;
    const sid = streamIdOf(row);
    if (sid) {
      streamId = sid;
      break;
    }
  }
  if (!streamId) return null;

  const inTurn = messages.filter((m) => streamIdOf(m) === streamId);
  const user =
    [...inTurn].reverse().find((m) => m.role === "user") ??
    [...messages].reverse().find((m) => m.role === "user" && streamIdOf(m) === streamId);
  if (!user) return null;
  const assistant =
    [...inTurn].reverse().find((m) => m.role === "assistant") ?? null;
  const checkpoint =
    parseCheckpoint(metaOf(user).checkpoint) ??
    parseCheckpoint(metaOf(assistant ?? user).checkpoint);
  const undone = isUndone(user) || (assistant ? isUndone(assistant) : false);
  return { streamId, user, assistant, checkpoint, undone };
}

export function canUndoLastTurn(messages: ChatRow[]): {
  enabled: boolean;
  reason: string | null;
  last: LastTurn | null;
} {
  const last = selectLastTurn(messages);
  if (!last) return { enabled: false, reason: null, last: null };
  if (last.undone) return { enabled: false, reason: "UNDO_ALREADY", last };
  if (!last.checkpoint) return { enabled: false, reason: "UNDO_NO_CHECKPOINT", last };
  if (last.checkpoint.kind !== "git" || !last.checkpoint.commitSha) {
    return { enabled: false, reason: "UNDO_REQUIRES_GIT", last };
  }
  if (!last.checkpoint.appliedMutations) {
    return { enabled: false, reason: "UNDO_NOOP", last };
  }
  return { enabled: true, reason: null, last };
}
```

- [ ] Crear `cli/src/llm/undo-decide.ts`:

```ts
import {
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_IN_FLIGHT,
  UNDO_NO_CHECKPOINT,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
  type Checkpoint,
  type UndoCommitAction,
} from "./undo-constants";
import type { LastTurn } from "./turn-select";

export type FileAction = { op: "restore" | "delete"; path: string };

export type UndoGate =
  | { ok: false; error: string }
  | { ok: true; mode: "noop"; message: string; last: LastTurn }
  | { ok: true; mode: "dispatch"; last: LastTurn };

export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isSafeRelPath(p: string): boolean {
  const rel = toPosixRel(p);
  if (!rel || rel === "." || rel === "..") return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  if (rel.split("/").some((s) => s === "..")) return false;
  return true;
}

export function gateUndo(input: {
  last: LastTurn | null;
  turnBusy: boolean;
  inflight: boolean;
}): UndoGate {
  if (input.turnBusy) return { ok: false, error: TURN_BUSY_ERROR };
  if (input.inflight) return { ok: false, error: UNDO_IN_FLIGHT };
  if (!input.last) return { ok: false, error: UNDO_NO_CHECKPOINT };
  if (input.last.undone) return { ok: false, error: UNDO_ALREADY };
  const cp = input.last.checkpoint;
  if (!cp) return { ok: false, error: UNDO_NO_CHECKPOINT };
  if (cp.kind !== "git" || !cp.commitSha) {
    return { ok: false, error: UNDO_REQUIRES_GIT };
  }
  if (!cp.appliedMutations) {
    return { ok: true, mode: "noop", message: UNDO_NOOP, last: input.last };
  }
  return { ok: true, mode: "dispatch", last: input.last };
}

/** Allowlist only. Unknown status → restore (safer than skip). */
export function planFileActions(
  paths: string[],
  inCheckpointTree: Set<string>,
): FileAction[] {
  const out: FileAction[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = toPosixRel(raw);
    if (!isSafeRelPath(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({
      op: inCheckpointTree.has(path) ? "restore" : "delete",
      path,
    });
  }
  return out;
}

export function decideCommitAction(input: {
  headBefore: string | null;
  commitsCreated: string[];
  stillInHistory: string[];
}): { action: UndoCommitAction; shas: string[] } {
  if (!input.headBefore) {
    return input.commitsCreated.length
      ? { action: "warn", shas: [] }
      : { action: "none", shas: [] };
  }
  const shas = input.commitsCreated.filter((s) =>
    input.stillInHistory.includes(s),
  );
  if (!shas.length) return { action: "none", shas: [] };
  return { action: "revert", shas: [...shas].reverse() };
}

export function emptyCheckpoint(
  streamId: string,
  reason: NonNullable<Checkpoint["reason"]>,
): Checkpoint {
  return {
    kind: "none",
    streamId,
    reason,
    headSha: null,
    commitSha: null,
    treeSha: null,
    branch: null,
    paths: [],
    commitsCreated: [],
    hadBash: false,
    appliedMutations: false,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] Crear `cli/src/llm/retry-payload.ts`:

```ts
import { RETRY_NO_PROMPT } from "./undo-constants";
import { metaOf, selectLastTurn, type ChatRow } from "./turn-select";

export type RetryPayload = {
  prompt: string;
  mentions: string[];
  attachments: unknown[];
  retryOfStreamId: string | null;
};

export function retryPayloadFromMessages(
  messages: ChatRow[],
): { ok: true; payload: RetryPayload } | { ok: false; error: string } {
  const last = selectLastTurn(messages);
  const user = last?.user ?? [...messages].reverse().find((m) => m.role === "user");
  const prompt = (user?.content || "").trim();
  if (!user || !prompt) return { ok: false, error: RETRY_NO_PROMPT };
  const meta = metaOf(user);
  const mentions = Array.isArray(meta.mentions)
    ? (meta.mentions.filter((x) => typeof x === "string") as string[])
    : [];
  const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  return {
    ok: true,
    payload: {
      prompt,
      mentions,
      attachments,
      retryOfStreamId: last?.streamId ?? null,
    },
  };
}

/** Guard: retry never ships historical tool_use / toolCallId lists to the runner. */
export function retryContainsTools(payload: RetryPayload): boolean {
  const blob = JSON.stringify(payload);
  return /"toolCallId"\s*:/.test(blob) || /"tool_use"/.test(blob);
}
```

- [ ] Crear `cli/src/llm/turn-select.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canUndoLastTurn, selectLastTurn, type ChatRow } from "./turn-select";

function row(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
): ChatRow {
  return { id: crypto.randomUUID(), role, content, metadata: metadata ?? null };
}

const gitCp = (streamId: string, extra: Record<string, unknown> = {}) => ({
  kind: "git" as const,
  streamId,
  headSha: "aaa",
  commitSha: "ccc",
  treeSha: "ttt",
  branch: "main",
  paths: ["a.ts"],
  commitsCreated: [],
  hadBash: false,
  appliedMutations: true,
  createdAt: "2026-09-16T00:00:00.000Z",
  ...extra,
});

describe("selectLastTurn", () => {
  test("picks the newest turn, leaves the previous", () => {
    const messages = [
      row("user", "one", { streamId: "s1", checkpoint: gitCp("s1") }),
      row("assistant", "ok1", { streamId: "s1" }),
      row("user", "two", { streamId: "s2", checkpoint: gitCp("s2", { paths: ["b.ts"] }) }),
      row("assistant", "ok2", { streamId: "s2" }),
    ];
    const last = selectLastTurn(messages);
    expect(last?.streamId).toBe("s2");
    expect(last?.user.content).toBe("two");
    expect(selectLastTurn(messages.slice(0, 2))?.streamId).toBe("s1");
  });

  test("ignores tool rows when grouping", () => {
    const messages = [
      row("user", "edit", { streamId: "s1", checkpoint: gitCp("s1") }),
      row("tool", "write", { streamId: "s1", toolCallId: "t1" }),
      row("assistant", "done", { streamId: "s1" }),
    ];
    expect(selectLastTurn(messages)?.streamId).toBe("s1");
  });

  test("manual append without streamId is not a turn", () => {
    const messages = [
      row("user", "turn", { streamId: "s1", checkpoint: gitCp("s1") }),
      row("assistant", "ok", { streamId: "s1" }),
      row("user", "nota manual"),
    ];
    expect(selectLastTurn(messages)?.streamId).toBe("s1");
  });
});

describe("canUndoLastTurn", () => {
  test("disabled without git", () => {
    const messages = [
      row("user", "x", {
        streamId: "s1",
        checkpoint: {
          kind: "none",
          streamId: "s1",
          reason: "not_git",
          headSha: null,
          commitSha: null,
          treeSha: null,
          branch: null,
          paths: [],
          commitsCreated: [],
          hadBash: false,
          appliedMutations: false,
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      }),
    ];
    const r = canUndoLastTurn(messages);
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("UNDO_REQUIRES_GIT");
  });

  test("disabled when already undone", () => {
    const messages = [
      row("user", "x", {
        streamId: "s1",
        checkpoint: gitCp("s1"),
        undone: true,
      }),
    ];
    expect(canUndoLastTurn(messages).reason).toBe("UNDO_ALREADY");
  });
});
```

- [ ] Crear `cli/src/llm/undo-decide.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  decideCommitAction,
  gateUndo,
  isSafeRelPath,
  planFileActions,
} from "./undo-decide";
import {
  TURN_BUSY_ERROR,
  UNDO_ALREADY,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "./undo-constants";
import type { LastTurn } from "./turn-select";

function turn(partial: Partial<LastTurn> & { kind?: "git" | "none"; applied?: boolean; undone?: boolean }): LastTurn {
  const kind = partial.kind ?? "git";
  const streamId = "s1";
  const user = {
    id: "u1",
    role: "user",
    content: "edit",
    metadata: { streamId },
  };
  return {
    streamId,
    user,
    assistant: null,
    undone: partial.undone ?? false,
    checkpoint: {
      kind,
      streamId,
      reason: kind === "none" ? "not_git" : undefined,
      headSha: kind === "git" ? "aaa" : null,
      commitSha: kind === "git" ? "ccc" : null,
      treeSha: kind === "git" ? "ttt" : null,
      branch: kind === "git" ? "main" : null,
      paths: ["a.ts"],
      commitsCreated: [],
      hadBash: false,
      appliedMutations: partial.applied ?? true,
      createdAt: "2026-09-16T00:00:00.000Z",
    },
    ...partial,
  };
}

describe("gateUndo", () => {
  test("busy", () => {
    const g = gateUndo({ last: turn({}), turnBusy: true, inflight: false });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(TURN_BUSY_ERROR);
  });

  test("requires git — no dispatch", () => {
    const g = gateUndo({ last: turn({ kind: "none" }), turnBusy: false, inflight: false });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(UNDO_REQUIRES_GIT);
  });

  test("rejected ask is noop", () => {
    const g = gateUndo({
      last: turn({ applied: false }),
      turnBusy: false,
      inflight: false,
    });
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.mode).toBe("noop");
      expect(g.message).toBe(UNDO_NOOP);
    }
  });

  test("already undone", () => {
    const g = gateUndo({
      last: turn({ undone: true }),
      turnBusy: false,
      inflight: false,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toBe(UNDO_ALREADY);
  });

  test("dispatch when git + mutations", () => {
    const g = gateUndo({ last: turn({}), turnBusy: false, inflight: false });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.mode).toBe("dispatch");
  });
});

describe("planFileActions", () => {
  test("restore if in tree, delete if created after checkpoint", () => {
    const actions = planFileActions(
      ["src/a.ts", "src/new.ts", "../etc/passwd", "src/a.ts"],
      new Set(["src/a.ts"]),
    );
    expect(actions).toEqual([
      { op: "restore", path: "src/a.ts" },
      { op: "delete", path: "src/new.ts" },
    ]);
  });

  test("rejects traversal", () => {
    expect(isSafeRelPath("../x")).toBe(false);
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("src/a.ts")).toBe(true);
  });
});

describe("decideCommitAction", () => {
  test("revert newest first when still in history", () => {
    const d = decideCommitAction({
      headBefore: "aaa",
      commitsCreated: ["c1", "c2"],
      stillInHistory: ["c1", "c2"],
    });
    expect(d.action).toBe("revert");
    expect(d.shas).toEqual(["c2", "c1"]);
  });

  test("warn when turn created first commit (unborn HEAD)", () => {
    const d = decideCommitAction({
      headBefore: null,
      commitsCreated: ["c1"],
      stillInHistory: ["c1"],
    });
    expect(d.action).toBe("warn");
    expect(d.shas).toEqual([]);
  });

  test("none when commits already gone", () => {
    const d = decideCommitAction({
      headBefore: "aaa",
      commitsCreated: ["c1"],
      stillInHistory: [],
    });
    expect(d.action).toBe("none");
  });
});
```

- [ ] Crear `cli/src/llm/retry-payload.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  retryContainsTools,
  retryPayloadFromMessages,
} from "./retry-payload";
import type { ChatRow } from "./turn-select";

function row(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
): ChatRow {
  return { id: crypto.randomUUID(), role, content, metadata: metadata ?? null };
}

describe("retryPayloadFromMessages", () => {
  test("copies prompt, mentions and attachments — not tools", () => {
    const messages = [
      row("user", "fix @src/a.ts", {
        streamId: "s1",
        mentions: ["src/a.ts"],
        attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "SNAP" }],
        checkpoint: {
          kind: "git",
          streamId: "s1",
          headSha: "a",
          commitSha: "c",
          treeSha: "t",
          branch: "main",
          paths: ["src/a.ts"],
          commitsCreated: [],
          hadBash: false,
          appliedMutations: true,
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      }),
      row("tool", "wrote a.ts", {
        streamId: "s1",
        toolCallId: "t1",
        toolName: "Write",
      }),
      row("assistant", "done", { streamId: "s1" }),
    ];
    const r = retryPayloadFromMessages(messages);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.prompt).toBe("fix @src/a.ts");
    expect(r.payload.mentions).toEqual(["src/a.ts"]);
    expect(r.payload.attachments).toEqual([
      { path: "src/a.ts", kind: "text", hydratedText: "SNAP" },
    ]);
    expect(r.payload.retryOfStreamId).toBe("s1");
    expect(retryContainsTools(r.payload)).toBe(false);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/turn-select.test.ts src/llm/undo-decide.test.ts src/llm/retry-payload.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/undo-constants.ts cli/src/llm/turn-select.ts \
  cli/src/llm/undo-decide.ts cli/src/llm/retry-payload.ts \
  cli/src/llm/turn-select.test.ts cli/src/llm/undo-decide.test.ts \
  cli/src/llm/retry-payload.test.ts cli/package.json
git commit -m "feat(undo): last-turn selector, gate, retry payload"
```

---

## Task 2: Git en el daemon — detect, checkpoint aislado, restore allowlist, revert

**Files:**

- Create: `cli/src/llm/git-exec.ts`
- Create: `cli/src/llm/git-detect.ts`
- Create: `cli/src/llm/git-checkpoint.ts`
- Create: `cli/src/llm/git-restore.ts`
- Test: `cli/src/llm/git-exec.test.ts`
- Test: `cli/src/llm/git-detect.test.ts`
- Test: `cli/src/llm/git-checkpoint.test.ts`
- Test: `cli/src/llm/git-restore.test.ts`

I/O local de git sobre dirs temporales. **Cero** red. **Cero** `reset --hard`.

- [ ] Crear `cli/src/llm/git-exec.ts`:

```ts
import { GIT_CMD_TIMEOUT_MS } from "./undo-constants";

export type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export async function runGit(
  cwd: string,
  args: string[],
  envExtra?: Record<string, string | undefined>,
  timeoutMs = GIT_CMD_TIMEOUT_MS,
): Promise<GitResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...envExtra,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(killer);
    return {
      ok: code === 0,
      stdout: stdout.replace(/\s+$/, ""),
      stderr: stderr.replace(/\s+$/, ""),
      code,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: "", stderr: message, code: 127 };
  }
}

export function shaLine(s: string): string | null {
  const t = s.trim();
  return /^[0-9a-f]{40,64}$/i.test(t) ? t : null;
}
```

- [ ] Crear `cli/src/llm/git-detect.ts`:

```ts
import { runGit, shaLine } from "./git-exec";

export type GitIdentity = {
  isRepo: boolean;
  gitAvailable: boolean;
  headSha: string | null;
  branch: string | null;
  gitDir: string | null;
};

export async function detectGit(cwd: string): Promise<GitIdentity> {
  const version = await runGit(cwd, ["--version"]);
  if (!version.ok) {
    return {
      isRepo: false,
      gitAvailable: false,
      headSha: null,
      branch: null,
      gitDir: null,
    };
  }
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      isRepo: false,
      gitAvailable: true,
      headSha: null,
      branch: null,
      gitDir: null,
    };
  }
  const gitDirRaw = await runGit(cwd, ["rev-parse", "--git-dir"]);
  const gitDir = gitDirRaw.ok ? gitDirRaw.stdout.trim() : null;
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  const headSha = head.ok ? shaLine(head.stdout) : null;
  const br = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = br.ok && br.stdout.trim() && br.stdout.trim() !== "HEAD"
    ? br.stdout.trim()
    : null;
  return { isRepo: true, gitAvailable: true, headSha, branch, gitDir };
}
```

- [ ] Crear `cli/src/llm/git-checkpoint.ts`:

```ts
import { unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { checkpointRef, emptyCheckpoint, type Checkpoint } from "./undo-constants";
import { detectGit } from "./git-detect";
import { runGit, shaLine } from "./git-exec";

function absGitDir(cwd: string, gitDir: string): string {
  return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
}

export async function createTurnCheckpoint(
  cwd: string,
  streamId: string,
): Promise<Checkpoint> {
  const createdAt = new Date().toISOString();
  const ident = await detectGit(cwd);
  if (!ident.gitAvailable) return emptyCheckpoint(streamId, "git_missing");
  if (!ident.isRepo || !ident.gitDir) return emptyCheckpoint(streamId, "not_git");

  const indexPath = join(absGitDir(cwd, ident.gitDir), `chavez-index-${streamId}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (ident.headSha) {
      await runGit(cwd, ["read-tree", ident.headSha], env);
    } else {
      await runGit(cwd, ["read-tree", "--empty"], env);
    }
    const add = await runGit(cwd, ["add", "-A"], env);
    if (!add.ok) return emptyCheckpoint(streamId, "git_error");
    const tree = await runGit(cwd, ["write-tree"], env);
    const treeSha = tree.ok ? shaLine(tree.stdout) : null;
    if (!treeSha) return emptyCheckpoint(streamId, "git_error");
    const parentArgs = ident.headSha ? (["-p", ident.headSha] as string[]) : [];
    const commit = await runGit(
      cwd,
      ["commit-tree", treeSha, ...parentArgs, "-m", `chavez checkpoint ${streamId}`],
      env,
    );
    const commitSha = commit.ok ? shaLine(commit.stdout) : null;
    if (!commitSha) return emptyCheckpoint(streamId, "git_error");
    const ref = await runGit(cwd, ["update-ref", checkpointRef(streamId), commitSha]);
    if (!ref.ok) return emptyCheckpoint(streamId, "git_error");
    return {
      kind: "git",
      streamId,
      headSha: ident.headSha,
      commitSha,
      treeSha,
      branch: ident.branch,
      paths: [],
      commitsCreated: [],
      hadBash: false,
      appliedMutations: false,
      createdAt,
    };
  } catch {
    return emptyCheckpoint(streamId, "git_error");
  } finally {
    try {
      unlinkSync(indexPath);
    } catch {
      // leftover index must not block the turn
    }
  }
}

export async function treeHasPath(
  cwd: string,
  commitSha: string,
  relPath: string,
): Promise<boolean> {
  const r = await runGit(cwd, ["ls-tree", "--name-only", commitSha, "--", relPath]);
  return r.ok && r.stdout.trim() === relPath;
}

export async function listCommitsAfter(
  cwd: string,
  headBefore: string | null,
): Promise<string[]> {
  if (!headBefore) {
    const all = await runGit(cwd, ["rev-list", "--reverse", "HEAD"]);
    if (!all.ok || !all.stdout.trim()) return [];
    return all.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean);
  }
  const r = await runGit(cwd, ["rev-list", "--reverse", `${headBefore}..HEAD`]);
  if (!r.ok || !r.stdout.trim()) return [];
  return r.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean);
}

export async function diffPathsVsCheckpoint(
  cwd: string,
  commitSha: string,
): Promise<string[]> {
  const r = await runGit(cwd, ["diff", "--name-only", commitSha]);
  const named = r.ok && r.stdout.trim()
    ? r.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const untracked = await runGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const extra = untracked.ok && untracked.stdout.trim()
    ? untracked.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...named, ...extra]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export async function isAncestor(
  cwd: string,
  sha: string,
  head = "HEAD",
): Promise<boolean> {
  const r = await runGit(cwd, ["merge-base", "--is-ancestor", sha, head]);
  return r.ok;
}

export async function finalizeCheckpoint(
  cwd: string,
  checkpoint: Checkpoint,
  extra: { paths?: string[]; hadBash: boolean },
): Promise<Checkpoint> {
  if (checkpoint.kind !== "git" || !checkpoint.commitSha) {
    return {
      ...checkpoint,
      hadBash: extra.hadBash,
      appliedMutations: false,
      finalizedAt: new Date().toISOString(),
    };
  }
  const fromGit = await diffPathsVsCheckpoint(cwd, checkpoint.commitSha);
  const pathsSet = new Set<string>([...(extra.paths ?? []), ...fromGit]);
  const paths = [...pathsSet].filter(Boolean);
  const commitsCreated = await listCommitsAfter(cwd, checkpoint.headSha);
  const appliedMutations = paths.length > 0 || commitsCreated.length > 0;
  return {
    ...checkpoint,
    paths,
    commitsCreated,
    hadBash: extra.hadBash,
    appliedMutations,
    finalizedAt: new Date().toISOString(),
  };
}
```

- [ ] Crear `cli/src/llm/git-restore.ts`:

```ts
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  COMMIT_REVERT_WARN,
  SHELL_SIDE_EFFECT_WARNING,
  UNDO_REQUIRES_GIT,
  joinWarnings,
  type Checkpoint,
  type UndoCommitAction,
  type UndoResult,
} from "./undo-constants";
import { detectGit } from "./git-detect";
import { isAncestor, treeHasPath } from "./git-checkpoint";
import { runGit } from "./git-exec";
import {
  decideCommitAction,
  isSafeRelPath,
  planFileActions,
  toPosixRel,
} from "./undo-decide";
import { resolveInsideCwd } from "./workspace-path";

export type RestoreOutcome = UndoResult & { diskTouched: boolean };

async function revertCommits(
  cwd: string,
  shas: string[],
): Promise<{ action: UndoCommitAction; reverted: string[] }> {
  if (!shas.length) return { action: "none", reverted: [] };
  const reverted: string[] = [];
  for (const sha of shas) {
    const r = await runGit(cwd, ["revert", "--no-edit", sha]);
    if (!r.ok) {
      await runGit(cwd, ["revert", "--abort"]);
      return { action: "warn", reverted };
    }
    reverted.push(sha);
  }
  return { action: reverted.length ? "revert" : "none", reverted };
}

export async function restoreTurn(input: {
  cwd: string;
  chatId: string;
  checkpoint: Checkpoint;
}): Promise<RestoreOutcome> {
  const { cwd, chatId, checkpoint } = input;
  const ident = await detectGit(cwd);
  if (!ident.isRepo || checkpoint.kind !== "git" || !checkpoint.commitSha) {
    return {
      chatId,
      streamId: checkpoint.streamId,
      noop: true,
      message: UNDO_REQUIRES_GIT,
      restored: [],
      deleted: [],
      commitAction: "none",
      reverted: [],
      warning: null,
      diskTouched: false,
    };
  }

  const still: string[] = [];
  for (const sha of checkpoint.commitsCreated) {
    if (await isAncestor(cwd, sha)) still.push(sha);
  }
  const commitPlan = decideCommitAction({
    headBefore: checkpoint.headSha,
    commitsCreated: checkpoint.commitsCreated,
    stillInHistory: still,
  });
  let commitAction: UndoCommitAction = commitPlan.action;
  let reverted: string[] = [];
  if (commitPlan.action === "revert") {
    const rev = await revertCommits(cwd, commitPlan.shas);
    commitAction = rev.action === "warn" ? "warn" : rev.action;
    reverted = rev.reverted;
    if (rev.action === "warn") commitAction = "warn";
  }

  const inTree = new Set<string>();
  for (const p of checkpoint.paths) {
    const rel = toPosixRel(p);
    if (!isSafeRelPath(rel)) continue;
    if (await treeHasPath(cwd, checkpoint.commitSha, rel)) inTree.add(rel);
  }
  const actions = planFileActions(checkpoint.paths, inTree);
  const restored: string[] = [];
  const deleted: string[] = [];

  for (const a of actions) {
    let abs: string;
    try {
      abs = resolveInsideCwd(cwd, a.path);
    } catch {
      continue;
    }
    if (a.op === "delete") {
      try {
        unlinkSync(abs);
        await runGit(cwd, ["rm", "--cached", "--ignore-unmatch", "--", a.path]);
        deleted.push(a.path);
      } catch {
        // already gone
      }
      continue;
    }
    const r = await runGit(cwd, [
      "restore",
      "--source",
      checkpoint.commitSha,
      "--worktree",
      "--staged",
      "--",
      a.path,
    ]);
    if (!r.ok) {
      const co = await runGit(cwd, [
        "checkout",
        checkpoint.commitSha,
        "--",
        a.path,
      ]);
      if (!co.ok) continue;
    }
    restored.push(a.path);
  }

  const warnings = joinWarnings(
    checkpoint.hadBash ? SHELL_SIDE_EFFECT_WARNING : null,
    commitAction === "warn" ? COMMIT_REVERT_WARN : null,
  );
  return {
    chatId,
    streamId: checkpoint.streamId,
    noop: false,
    message:
      commitAction === "warn"
        ? COMMIT_REVERT_WARN
        : `Restored ${restored.length} file(s), removed ${deleted.length} file(s)`,
    restored,
    deleted,
    commitAction,
    reverted,
    warning: warnings,
    diskTouched: restored.length > 0 || deleted.length > 0 || reverted.length > 0,
  };
}

export function joinCwd(cwd: string, rel: string): string {
  return join(cwd, rel);
}
```

Si `cli/src/llm/workspace-path.ts` **no** existe (attach-files / agent-tools no mergeados), copiar `resolveInsideCwd` / `PathEscapeError` de [`attach-files` Task 1](../attach-files/implementation.md) en `cli/src/llm/workspace-path.ts` (no inline en git-restore).

- [ ] Tests de git con repo temporal. Crear `cli/src/llm/git-detect.test.ts`, `cli/src/llm/git-checkpoint.test.ts`, `cli/src/llm/git-restore.test.ts`, `cli/src/llm/git-exec.test.ts`. Helper compartido inline en cada file (no hace falta un helper global):

```ts
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git-exec";

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-"));
  const git = (args: string[]) => runGit(cwd, args);
  await git(["init"]);
  await git(["config", "user.email", "undo@chavez.test"]);
  await git(["config", "user.name", "Undo Bot"]);
  writeFileSync(join(cwd, "keep.ts"), "keep\n");
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "init"]);
  return cwd;
}
```

Casos **obligatorios**:

1. `detectGit` en dir sin `.git` → `isRepo: false`.
2. `createTurnCheckpoint` no cambia `git status` ni `HEAD` ni `git stash list` (index del usuario intacto).
3. Tras editar `a.ts` y crear `b.ts`, `finalizeCheckpoint` incluye ambos paths y `appliedMutations: true`.
4. `restoreTurn` deja `a.ts` en `"one\n"` y borra `b.ts`. `keep.ts` si el usuario lo editó **después** del finalize y **no** está en `paths` **se queda**.
5. Sin git: `restoreTurn` devuelve `UNDO_REQUIRES_GIT` y `diskTouched: false` (crear un archivo sentinela y comprobar que sigue).
6. Turn que hace `git commit` de `a.ts`: undo hace revert **o** restore de `a.ts` al contenido pre-turn; `HEAD` no se reescribe con `reset --hard` (el test lee `git log --oneline` y acepta un commit `Revert` extra; falla si el sha inicial de `HEAD` desaparece **sin** un revert nuevo — comprobar que `git rev-parse HEAD` ≠ `headBefore` solo por revert, nunca por reset al parent sin commit nuevo cuando había commitsCreated).
7. Bash `rm` de archivo **tracked**: restore lo recupera. Bash `rm` de un gitignored (`echo secret > .secret && echo .secret > .gitignore` commitido, luego rm): el ignored **no** está en el árbol del checkpoint → warning `SHELL_SIDE_EFFECT_WARNING` y el test documenta que `.secret` puede no volver.
8. `git grep -n "reset --hard" cli/src/llm/git-restore.ts` vacío.

Esqueleto de (4)+(5) en `cli/src/llm/git-restore.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnCheckpoint, finalizeCheckpoint } from "./git-checkpoint";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { restoreTurn } from "./git-restore";
import { UNDO_REQUIRES_GIT } from "./undo-constants";

describe("restoreTurn", () => {
  test("restores allowlisted files only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-"));
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
    await runGit(cwd, ["config", "user.name", "Undo Bot"]);
    writeFileSync(join(cwd, "keep.ts"), "keep\n");
    writeFileSync(join(cwd, "a.ts"), "one\n");
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", "init"]);

    const cp0 = await createTurnCheckpoint(cwd, "s1");
    expect(cp0.kind).toBe("git");
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "b.ts"), "new\n");
    writeFileSync(join(cwd, "keep.ts"), "user-edit\n");
    const fin = await finalizeCheckpoint(cwd, cp0, {
      paths: ["a.ts", "b.ts"],
      hadBash: false,
    });
    const out = await restoreTurn({ cwd, chatId: "c1", checkpoint: fin });
    expect(out.diskTouched).toBe(true);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("one\n");
    expect(existsSync(join(cwd, "b.ts"))).toBe(false);
    expect(readFileSync(join(cwd, "keep.ts"), "utf8")).toBe("user-edit\n");
  });

  test("no git — disk untouched", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-"));
    writeFileSync(join(cwd, "a.ts"), "hello\n");
    const ident = await detectGit(cwd);
    expect(ident.isRepo).toBe(false);
    const out = await restoreTurn({
      cwd,
      chatId: "c1",
      checkpoint: {
        kind: "none",
        streamId: "s1",
        reason: "not_git",
        headSha: null,
        commitSha: null,
        treeSha: null,
        branch: null,
        paths: ["a.ts"],
        commitsCreated: [],
        hadBash: false,
        appliedMutations: true,
        createdAt: new Date().toISOString(),
      },
    });
    expect(out.message).toBe(UNDO_REQUIRES_GIT);
    expect(out.diskTouched).toBe(false);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("hello\n");
  });
});
```

Añadir el caso bash+commit en el mismo archivo (init repo, checkpoint, `writeFileSync` + `git add` + `git commit`, restore, assert contenido pre-turn y que `git log` contiene `Revert` **o** el warning de commits; **assert.fail** si aparece `reset --hard` en el código).

- [ ] Correr:

```bash
cd cli && bun test src/llm/git-exec.test.ts src/llm/git-detect.test.ts \
  src/llm/git-checkpoint.test.ts src/llm/git-restore.test.ts
rg -n "reset --hard|push --force" cli/src/llm/git-restore.ts cli/src/llm/git-checkpoint.ts
```

Esperado: tests pasan; `rg` vacío.

- [ ] Commit:

```bash
git add cli/src/llm/git-exec.ts cli/src/llm/git-detect.ts \
  cli/src/llm/git-checkpoint.ts cli/src/llm/git-restore.ts \
  cli/src/llm/git-exec.test.ts cli/src/llm/git-detect.test.ts \
  cli/src/llm/git-checkpoint.test.ts cli/src/llm/git-restore.test.ts \
  cli/src/llm/workspace-path.ts
git commit -m "feat(undo): isolated git checkpoint and allowlist restore"
```

---

## Task 3: API — persistencia del checkpoint, CAS de undo, retry dispatch

**Files:**

- Create: `api/src/llm/undo-constants.ts`
- Create: `api/src/llm/turn-select.ts`
- Test: `api/src/llm/turn-select.test.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Create: `api/src/ws/pending.ts` (solo si attach-files **no** lo creó)
- Test: `api/src/ws/pending.test.ts` (solo si se crea aquí)
- Modify: `api/package.json`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`

La API no corre git. Sí: elige el último turn, corta no-git / noop / already / busy, reenvía al daemon, parchea `metadata.undone`.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta (dejar `start`/`dev`/`db:*`).

- [ ] Copiar `api/src/llm/undo-constants.ts` **idéntico** a `cli/src/llm/undo-constants.ts` (Web/API no importan CLI). Copiar `parseCheckpoint`, `selectLastTurn`, `canUndoLastTurn`, `ChatRow`, `LastTurn` a `api/src/llm/turn-select.ts` (mismo código que CLI Task 1, imports desde `./undo-constants`). Copiar `gateUndo` (solo la función + tipos `UndoGate`) al final de `turn-select.ts` o un `api/src/llm/undo-decide.ts` mínimo — **mismos strings**.

- [ ] Test `api/src/llm/turn-select.test.ts`: los tres casos de `selectLastTurn` de Task 1 (dos turns, tool rows, append manual) + `gateUndo` noop / requires git. Pegar los asserts; no hace falta el resto de `planFileActions`.

- [ ] En `api/src/ws/protocol.ts`, ampliar `ClientMessage` (dejar campos existentes; añadir):

```ts
  requestId?: string;
  mentions?: string[];
  attachments?: unknown[];
  retryOfStreamId?: string;
  checkpoint?: Record<string, unknown>;
```

Mismo añadido en `cli/src/ws/client.ts` `WsRequest` y `web/src/lib/ws-client.ts` `WsRequest`.

- [ ] Si `api/src/ws/pending.ts` no existe, crearlo **idéntico** al de attach-files Task 3 (`createPendingMap`). Reutilizar el módulo si ya está. Declarar en `handlers.ts`:

```ts
const undoPending = createPendingMap(30_000);
```

El timeout de undo, si el mapa actual clava el error `NO_DAEMON_ERROR` a los 5s, **no** reusar `fsPending`. Un segundo mapa con 30s. Si `createPendingMap` siempre usa el string no-daemon, para undo eso es aceptable en timeout (el cliente ve que el daemon no contestó como “no daemon”); no inventar un string nuevo.

- [ ] En `api/src/ws/handlers.ts`, helper de parche (junto a `loadChatForUser`):

```ts
async function patchMessagesByStream(
  chatId: string,
  streamId: string,
  patch: Record<string, unknown>,
) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId));
  for (const row of rows) {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const sid =
      (typeof meta.streamId === "string" && meta.streamId) ||
      (meta.checkpoint &&
      typeof meta.checkpoint === "object" &&
      meta.checkpoint &&
      "streamId" in meta.checkpoint
        ? String((meta.checkpoint as { streamId?: string }).streamId || "")
        : "");
    if (sid !== streamId) continue;
    if (row.role !== "user" && row.role !== "assistant") continue;
    const metadata = { ...meta, ...patch };
    if (patch.checkpoint && meta.checkpoint && typeof meta.checkpoint === "object") {
      metadata.checkpoint = {
        ...(meta.checkpoint as Record<string, unknown>),
        ...(patch.checkpoint as Record<string, unknown>),
      };
    }
    await db
      .update(chatMessages)
      .set({ metadata })
      .where(eq(chatMessages.id, row.id));
  }
}

const undoInflight = new Set<string>();
```

- [ ] Cases nuevos **antes** de `default` (después de `agent.turn.request`):

`chat.checkpoint.created` y `chat.checkpoint.finalized` (los envía el daemon como RPC):

1. Exigen `msg.chatId` y `msg.streamId`.
2. `loadChatForUser`; 404 `"Chat not found"`.
3. `checkpoint` = `msg.checkpoint || msg.metadata?.checkpoint`.
4. `await patchMessagesByStream(chatId, streamId, { streamId, checkpoint })`.
5. Broadcast `chat.checkpoint.finalized` (o `created`) con `{ chatId, streamId, checkpoint }` a todos los sockets del user.
6. `return ok(type, id, { patched: true })`.

`agent.turn.undo`:

1. `chatId` obligatorio.
2. `workspaceIdForChat`; 404 chat.
3. `hub.findDaemon`; si no, `fail` `NO_DAEMON_ERROR`.
4. Cargar messages `orderBy createdAt asc`. `last = selectLastTurn(messages)`.
5. `gate = gateUndo({ last, turnBusy: false, inflight: undoInflight.has(chatId) })`.
   - Si el hub ya expone `daemon.turnBusy` (plan 2), pasar `turnBusy: Boolean((daemon as { turnBusy?: boolean }).turnBusy)`.
6. `gate.ok === false` → `fail(type, id, gate.error)` **sin** `sendTo`.
7. `gate.mode === "noop"` → `ok` con data `{ noop: true, message: UNDO_NOOP, chatId, streamId: last.streamId, restored: [], deleted: [], commitAction: "none", reverted: [], warning: null }`. Broadcast `chat.checkpoint.undone` con `noop: true`. **No** marcar `undone`. **No** dispatch.
8. `undoInflight.add(chatId)`.
9. `hub.sendTo(daemon, pushEvent("agent.turn.undo.dispatch", { requestId: id, chatId, streamId: last.streamId, checkpoint: last.checkpoint, path: workspace?.path || daemon.path }))`.
10. Si `!sent`: `undoInflight.delete`; `fail` `"Daemon connection unavailable"`.
11. `return await undoPending.wait(id, type)` envuelto en `try/finally { undoInflight.delete(chatId) }` — el delete del inflight debe ocurrir cuando `wait` resuelve (en el `complete` de `undo.result`, ver abajo), no antes. Implementación: **no** borrar en el handler de undo; borrar en `agent.turn.undo.result` y en el timeout no-op del pending. Añadir `undoInflight.delete` al `complete` path.

`agent.turn.undo.result` (daemon):

1. Requiere `msg.requestId`.
2. Payload = `msg.metadata` o `msg` data fields: `noop`, `message`, `restored`, `deleted`, `commitAction`, `reverted`, `warning`, `streamId`, `chatId`.
3. Si `msg.status === "error"` o un campo `ok === false` en metadata: `undoPending.complete(requestId, fail("agent.turn.undo", requestId, String(metadata.error || "undo failed")))`.
4. Si éxito y `!payload.noop`: `patchMessagesByStream(chatId, streamId, { undone: true, undoneAt: new Date().toISOString(), undo: { restored, deleted, commitAction, reverted, warning } })`.
5. Broadcast `chat.checkpoint.undone` + `message.appended` no es necesario si el cliente invalida con el undone event; igual broadcast `chat.checkpoint.undone`.
6. `undoInflight.delete(chatId)`.
7. `undoPending.complete(requestId, ok("agent.turn.undo", requestId, payload))`.
8. Responder al daemon `ok(type, id, { forwarded: true })`.

`agent.turn.retry`:

1. `chatId` obligatorio. `workspaceIdForChat`. Daemon bound o `NO_DAEMON_ERROR`.
2. Messages → `retryPayloadFromMessages` (copiar la función a `api/src/llm/retry-payload.ts`, mismo código).
3. Fail `RETRY_NO_PROMPT` si no hay prompt.
4. Reusar el **mismo** despacho que `agent.turn.request`: `hub.sendTo(..., pushEvent("agent.turn.dispatch", { chatId, prompt, requestId: id, workspaceId, path, sessionId, requesterConnectionId, mentions, attachments, retryOfStreamId }))`.
5. `return ok(type, id, { accepted: true, daemonConnectionId, retry: true, prompt })`.
6. **No** reenviar tool rows. **No** llamar al runner en la API.

Ampliar el `agent.turn.request` existente: si `msg.mentions` / `msg.metadata.mentions` / `msg.attachments` ya se reenvían (attach-files), no duplicar; si no, añadir `mentions` y `attachments` y `retryOfStreamId` al payload de dispatch (campos extra ignorados por daemons viejos).

- [ ] Correr:

```bash
cd api && bun test src/llm/turn-select.test.ts src/ws/pending.test.ts
```

Esperado: todos pasan. Si `pending.test.ts` ya existía, no romper sus casos `fs.complete`.

- [ ] Commit:

```bash
git add api/src/llm/undo-constants.ts api/src/llm/turn-select.ts \
  api/src/llm/turn-select.test.ts api/src/llm/retry-payload.ts \
  api/src/llm/undo-decide.ts api/src/ws/protocol.ts api/src/ws/handlers.ts \
  api/src/ws/pending.ts api/src/ws/pending.test.ts api/package.json \
  cli/src/ws/client.ts web/src/lib/ws-client.ts
git commit -m "feat(undo): API last-turn CAS, checkpoint persist, retry dispatch"
```

---

## Task 4: `publishAgentTurn` + daemon/TUI ejecutan checkpoint y undo

**Files:**

- Create: `cli/src/llm/run-undo.ts`
- Test: `cli/src/llm/run-undo.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx` (handler onPush; teclas van en Task 5)
- Modify: `cli/src/llm/claude-runner.ts` (solo si hace falta `hadBash`: contar `tool_start` Bash)

El snapshot se toma **antes** de `query()`. Undo.dispatch llama `restoreTurn` y responde `agent.turn.undo.result`.

- [ ] Crear `cli/src/llm/run-undo.ts`:

```ts
import type { ChavezWsClient } from "../ws/client";
import { restoreTurn } from "./git-restore";
import { parseCheckpoint } from "./turn-select";
import { UNDO_NO_CHECKPOINT, UNDO_REQUIRES_GIT, type Checkpoint } from "./undo-constants";

export async function handleUndoDispatch(input: {
  client: ChavezWsClient;
  cwd: string;
  data: {
    requestId?: string;
    chatId?: string;
    streamId?: string;
    checkpoint?: unknown;
    path?: string;
  };
}): Promise<void> {
  const requestId = String(input.data.requestId || "");
  const chatId = String(input.data.chatId || "");
  const cwd = input.data.path || input.cwd;
  const checkpoint =
    parseCheckpoint(input.data.checkpoint) ||
    ({ streamId: String(input.data.streamId || "") } as Checkpoint);
  if (!requestId || !chatId) return;
  if (!checkpoint || checkpoint.kind !== "git" || !checkpoint.commitSha) {
    await input.client.request({
      type: "agent.turn.undo.result",
      requestId,
      chatId,
      streamId: checkpoint?.streamId,
      status: "error",
      metadata: { error: UNDO_REQUIRES_GIT, chatId },
    });
    return;
  }
  const out = await restoreTurn({ cwd, chatId, checkpoint });
  await input.client.request({
    type: "agent.turn.undo.result",
    requestId,
    chatId,
    streamId: out.streamId,
    status: out.noop && out.message === UNDO_REQUIRES_GIT ? "error" : "done",
    metadata: { ...out, error: out.noop && out.message === UNDO_REQUIRES_GIT ? UNDO_REQUIRES_GIT : undefined },
  });
}
```

Cuando `parseCheckpoint` falle, enviar `UNDO_NO_CHECKPOINT` con `status: "error"` (mismo request, `metadata.error`).

- [ ] Test `cli/src/llm/run-undo.test.ts`: fake `client.request` que captura el tipo. Repo tmp como Task 2. Dispatch con checkpoint git real → result `status: "done"` y archivo restaurado. Dispatch `kind: "none"` → `status: "error"` y sentinela intacto.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Tras generar `streamId` y **antes** de cualquier tool:
     `let checkpoint = await createTurnCheckpoint(cwd, streamId);`
  2. El `chat.append` user (si no `skipUserAppend`) incluye:

```ts
metadata: {
  streamId,
  checkpoint,
  ...(input.mentions ? { mentions: input.mentions } : {}),
  ...(input.attachments ? { attachments: input.attachments } : {}),
  ...(input.retryOfStreamId ? { retryOfStreamId: input.retryOfStreamId } : {}),
},
```

  3. Ampliar `publishAgentTurn` input:

```ts
mentions?: string[];
attachments?: unknown[];
retryOfStreamId?: string;
```

  4. Tras el append (o si `skipUserAppend`, igual):

```ts
await client.request({
  type: "chat.checkpoint.created",
  chatId,
  streamId,
  checkpoint,
});
```

  5. `let hadBash = false;` En `onEvent` `tool_start` / `tool_result`, si `ev.toolName === "Bash" || ev.toolName === "bash"` → `hadBash = true`.
  6. En `finally` (éxito, error o throw), **siempre**:

```ts
const extraPaths: string[] = [];
// Si TurnDiffCollector.finalize() existe (plan 6), usarlo:
// extraPaths.push(...applied.map(d => d.path));
checkpoint = await finalizeCheckpoint(cwd, checkpoint, {
  paths: extraPaths,
  hadBash,
});
await client.request({
  type: "chat.checkpoint.finalized",
  chatId,
  streamId,
  checkpoint,
});
```

     Si `createTurnCheckpoint` / `finalizeCheckpoint` throw: capturar, dejar `emptyCheckpoint(streamId, "git_error")`, **no** abortar el turn.

  7. En `chat.stream.end`, añadir al request (si el handler ya acepta `metadata`):

```ts
metadata: { streamId, checkpoint },
```

     Hoy `chat.stream.end` ya mete `msg.metadata` en el assistant (`handlers.ts`). Pasar `metadata: { streamId, checkpoint }`.

- [ ] En `cli/src/ws/daemon.ts`:

  1. Importar `handleUndoDispatch`.
  2. `let undoBusy = false;`
  3. En `onPush`, **antes** del early-return de `agent.turn.dispatch`:

```ts
if (msg.type === "agent.turn.undo.dispatch") {
  if (turnBusy || undoBusy) {
    const data = (msg.data || {}) as { requestId?: string; chatId?: string };
    if (data.requestId) {
      await client.request({
        type: "agent.turn.undo.result",
        requestId: data.requestId,
        chatId: data.chatId,
        status: "error",
        metadata: { error: "Turn already running on this daemon", chatId: data.chatId },
      });
    }
    return;
  }
  undoBusy = true;
  try {
    await handleUndoDispatch({
      client,
      cwd: path,
      data: (msg.data || {}) as Parameters<typeof handleUndoDispatch>[0]["data"],
    });
  } finally {
    undoBusy = false;
  }
  return;
}
```

  4. En `agent.turn.dispatch`, leer `mentions`, `attachments`, `retryOfStreamId` del payload y pasarlos a `publishAgentTurn`.
  5. Si `turnBusy`, no mezclar undo (ya cubierto).

- [ ] En `tui/src/App.tsx` el `onPush` (el `useEffect` que ya maneja `agent.turn.dispatch`): añadir el **mismo** branch `agent.turn.undo.dispatch` llamando `handleUndoDispatch({ client, cwd, data })`. Usar `turnBusyRef` / un `undoBusyRef`. No pongas las teclas `u`/`r` todavía (Task 5).

- [ ] Correr:

```bash
cd cli && bun test src/llm/run-undo.test.ts src/llm/git-restore.test.ts \
  src/llm/git-checkpoint.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/run-undo.ts cli/src/llm/run-undo.test.ts \
  cli/src/llm/publish-turn.ts cli/src/ws/daemon.ts tui/src/App.tsx \
  cli/src/llm/claude-runner.ts
git commit -m "feat(undo): snapshot every turn; daemon restores last turn"
```

---

## Task 5: CLI headless `chat undo` / `chat retry` y `watch`

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Create: `cli/src/llm/watch-format.ts` (solo si agent-tools **no** lo creó)
- Test: `cli/src/llm/watch-format-undo.test.ts`
- Modify: `cli/src/llm/watch-format.ts` (si ya existe)

- [ ] En `cli/src/index.ts` usage, cambiar la línea de chat a:

```
  chavez headless chat create|list|append|get|ask|watch|undo|retry
```

- [ ] En `cli/src/commands/headless.ts`, dentro de `group === "chat"`:

`undo`:

```ts
if (action === "undo") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: chavez headless chat undo <chatId>");
  const res = await client.request(
    { type: "agent.turn.undo", chatId },
    30_000,
  );
  if (!res.ok) throw new Error(res.error);
  const data = (res.data || {}) as {
    noop?: boolean;
    message?: string;
    restored?: string[];
    warning?: string | null;
  };
  if (data.noop) {
    console.log(data.message || "Nothing to undo: the last turn made no applied changes");
  } else {
    console.log(data.message || "undone");
    if (data.restored?.length) console.log(`restored: ${data.restored.join(", ")}`);
    if (data.warning) console.log(data.warning);
  }
  console.log(JSON.stringify(res.data, null, 2));
  return;
}
```

`retry`:

```ts
if (action === "retry") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: chavez headless chat retry <chatId>");
  const res = await client.request(
    { type: "agent.turn.retry", chatId },
    30_000,
  );
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  console.log(
    "Retry aceptado. Usa `chat watch` o el hub web para ver el stream.",
  );
  return;
}
```

Actualizar el `throw` de uso del grupo chat para incluir `undo|retry`.

- [ ] Watch: si `cli/src/llm/watch-format.ts` existe, añadir al final de `formatWatchLine` (antes del `return null`):

```ts
  if (msg.type === "chat.checkpoint.undone") {
    const noop = Boolean(data.noop);
    if (noop) return `undo · noop  ${String(data.message || "")}`;
    const restored = Array.isArray(data.restored) ? data.restored.length : 0;
    const warning = data.warning ? `\n${String(data.warning)}` : "";
    return `undo · restored ${restored} path(s) · ${String(data.commitAction || "none")}${warning}`;
  }
  if (msg.type === "chat.checkpoint.finalized") {
    const cp = rec(data.checkpoint);
    if (!cp) return "checkpoint finalized";
    if (cp.kind !== "git") return "checkpoint · no git (undo disabled)";
    return `checkpoint · git · ${(Array.isArray(cp.paths) ? cp.paths.length : 0)} path(s)`;
  }
```

Si **no** existe `watch-format.ts`, no crear el módulo completo de tools: en `headless.ts` `chat watch`, además del JSON crudo, si `msg.type === "chat.checkpoint.undone"` imprimir una línea `undo · …` con el mismo formato (inline 10 líneas). Test entonces sobre una función extraída `formatUndoWatchLine` en `cli/src/llm/undo-watch.ts`.

- [ ] Test `cli/src/llm/watch-format-undo.test.ts` (importa `formatWatchLine` o `formatUndoWatchLine`):

```ts
import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";
import { SHELL_SIDE_EFFECT_WARNING, UNDO_NOOP } from "./undo-constants";

describe("watch undo lines", () => {
  test("noop", () => {
    const line = formatWatchLine({
      type: "chat.checkpoint.undone",
      data: { noop: true, message: UNDO_NOOP },
    });
    expect(line || "").toContain("noop");
    expect(line || "").toContain("no applied changes");
  });
  test("bash warning", () => {
    const line = formatWatchLine({
      type: "chat.checkpoint.undone",
      data: {
        noop: false,
        restored: ["a.ts"],
        commitAction: "none",
        warning: SHELL_SIDE_EFFECT_WARNING,
      },
    });
    expect(line || "").toContain("restored 1");
    expect(line || "").toContain("Unversioned shell");
  });
});
```

Si el import de `formatWatchLine` no existe, cambiarlo a `formatUndoWatchLine`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format-undo.test.ts
```

Esperado: pasa.

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format-undo.test.ts \
  cli/src/llm/undo-watch.ts
git commit -m "feat(undo): headless chat undo/retry and watch lines"
```

---

## Task 6: TUI — teclas `u` / `r`, badge undone, sync en vivo

**Files:**

- Modify: `tui/src/App.tsx`

TUI ya maneja `undo.dispatch` (Task 4). Aquí: disparar el RPC, pintar metadata, no matar la TUI.

- [ ] Ampliar el tipo:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna `messages` del `chat.get`; al tipar `Message` con metadata, el JSON existente rellena el campo.

- [ ] Importar `canUndoLastTurn` desde `../../cli/src/llm/turn-select` y las constantes `UNDO_REQUIRES_GIT`, `NO_GIT_UI`, `TURN_BUSY_ERROR`, `UNDO_NOOP` desde `../../cli/src/llm/undo-constants`.

- [ ] `const lastUndo = canUndoLastTurn(messages);`

- [ ] En `useInput`, modo **command**, bloqueado si `busy` igual que `m` (después de `if (busy) return` que ya existe para mutaciones):

```ts
if (ch === "u" && client && activeChatId) {
  if (turnBusyRef.current) {
    setLog(TURN_BUSY_ERROR);
    return;
  }
  if (!lastUndo.enabled) {
    if (lastUndo.reason === "UNDO_REQUIRES_GIT") setLog(NO_GIT_UI);
    else if (lastUndo.reason === "UNDO_NOOP") setLog(UNDO_NOOP);
    else if (lastUndo.reason === "UNDO_ALREADY") setLog("Last turn is already undone");
    else setLog(NO_GIT_UI);
    return;
  }
  const res = await client.request(
    { type: "agent.turn.undo", chatId: activeChatId },
    30_000,
  );
  if (!res.ok) setLog(res.error || "undo failed");
  else {
    const data = (res.data || {}) as { message?: string; warning?: string | null; noop?: boolean };
    setLog(
      [data.message, data.warning].filter(Boolean).join(" — ") || "undone",
    );
    await loadChat(activeChatId);
  }
  return;
}
if (ch === "r" && client && activeChatId) {
  if (turnBusyRef.current) {
    setLog(TURN_BUSY_ERROR);
    return;
  }
  const res = await client.request(
    { type: "agent.turn.retry", chatId: activeChatId },
    30_000,
  );
  if (!res.ok) setLog(res.error || "retry failed");
  else setLog("Retry disparado (turn nuevo, mismas attaches)");
  return;
}
```

`lastUndo` se lee del render; dentro de `useInput` puede quedar stale. Calcular `canUndoLastTurn(messages)` **dentro** del handler usando el state `messages` del closure (el `useInput` callback ya se recrea). Si el linter exige deps, envolver `useInput` no es posible; usar `messagesRef.current = messages` (mismo patrón que `activeChatIdRef`).

- [ ] En el `onPush` existente, tratar `chat.checkpoint.undone` y `chat.checkpoint.finalized` como `message.appended`: si el `chatId` es el activo, `loadChat`.

- [ ] Pintar mensajes: si `m.metadata?.undone` o `(m.metadata as { undone?: boolean })?.undone`:

```tsx
<Text color={m.role === "assistant" ? "green" : "magenta"}>
  {m.role}
  {m.metadata && (m.metadata as { undone?: boolean }).undone ? " [undone]" : ""}
  :{" "}
</Text>
```

- [ ] Footer de atajos: añadir `[u] undo  [r] retry`. Si `!lastUndo.enabled` y `lastUndo.reason === "UNDO_REQUIRES_GIT"`, una línea dim `undo: hace falta git`.

- [ ] **No** cambiar Escape para que cancele el turn (plan 16). Escape sigue saliendo.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(undo): TUI u/r keys and undone badge"
```

---

## Task 7: Web — botones Deshacer / Reintentar, badge, fan-out

**Files:**

- Create: `web/src/lib/undo-constants.ts`
- Create: `web/src/lib/turn-select.ts`
- Test: `web/src/lib/turn-select.test.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web no importa CLI. Duplicar constantes + `selectLastTurn` / `canUndoLastTurn` (Task 1). Tests con `bun test`.

- [ ] Añadir `"test": "bun test"` en `web/package.json` scripts si falta (dejar `dev`/`build`/`preview`/`start`).

- [ ] Copiar `web/src/lib/undo-constants.ts` igual que CLI (mismo archivo). Copiar `web/src/lib/turn-select.ts` igual que `cli/src/llm/turn-select.ts` (imports desde `./undo-constants`). Copiar los tests de selector a `web/src/lib/turn-select.test.ts` (imports relativos).

- [ ] En `web/src/lib/ws-hooks.ts` añadir:

```ts
export function useWsTurnUndo() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.undo", chatId: input.chatId }, 30_000),
  });
}

export function useWsTurnRetry() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.retry", chatId: input.chatId }, 30_000),
  });
}
```

Si `ws.request` no acepta timeout como 2º arg (`web/src/lib/ws-client.ts` sí lo tiene, igual que CLI), pasarlo. Si la firma web solo tiene un argumento, ampliar `request` con el mismo `timeoutMs = 15000` default y permitir 30000.

- [ ] En `ChatDetailInner`:

  1. Importar `useWsTurnUndo`, `useWsTurnRetry`, `canUndoLastTurn`, `NO_GIT_UI`, `UNDO_NOOP`, `UNDO_REQUIRES_GIT`.
  2. `const undoMut = useWsTurnUndo(); const retryMut = useWsTurnRetry();`
  3. `const undoState = canUndoLastTurn(messages);`
  4. En el `onPush` existente, si `ev.type === "chat.checkpoint.undone" || ev.type === "chat.checkpoint.finalized"`: `void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });`
  5. Junto al compositor “Enviar al agente”, un toolbar:

```tsx
<div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
  <button
    type="button"
    className="secondary"
    disabled={
      !undoState.enabled ||
      undoMut.isPending ||
      streaming ||
      ws.status !== "open"
    }
    title={
      undoState.enabled
        ? "Deshacer el último turn (git)"
        : undoState.reason === "UNDO_REQUIRES_GIT"
          ? NO_GIT_UI
          : undoState.reason === "UNDO_NOOP"
            ? UNDO_NOOP
            : "Undo no disponible"
    }
    onClick={async () => {
      setMsg(null);
      try {
        const res = await undoMut.mutateAsync({ chatId });
        if (!res.ok) {
          setMsg({ kind: "error", text: res.error || "undo failed" });
          return;
        }
        const data = (res.data || {}) as {
          message?: string;
          warning?: string | null;
          noop?: boolean;
        };
        setMsg({
          kind: "ok",
          text: [data.message, data.warning].filter(Boolean).join(" — ") || "undone",
        });
        void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      } catch (err) {
        setMsg({ kind: "error", text: formatQueryError(err) });
      }
    }}
  >
    {undoMut.isPending ? "Deshaciendo…" : "Deshacer último turn"}
  </button>
  <button
    type="button"
    className="secondary"
    disabled={retryMut.isPending || streaming || ws.status !== "open" || !messages.some((m) => m.role === "user")}
    title="Nuevo turn con el mismo prompt y attaches (no re-ejecuta tools)"
    onClick={async () => {
      setMsg(null);
      try {
        const res = await retryMut.mutateAsync({ chatId });
        if (!res.ok) {
          setMsg({ kind: "error", text: res.error || "retry failed" });
          return;
        }
        setMsg({
          kind: "ok",
          text: "Retry aceptado — turn nuevo con el mismo texto y attaches.",
        });
      } catch (err) {
        setMsg({ kind: "error", text: formatQueryError(err) });
      }
    }}
  >
    {retryMut.isPending ? "Reintentando…" : "Reintentar último prompt"}
  </button>
</div>
{!undoState.enabled && undoState.reason === "UNDO_REQUIRES_GIT" && (
  <p className="muted">{NO_GIT_UI}</p>
)}
```

  6. En el bubble no-tool, si `m.metadata?.undone`:

```tsx
<span className="badge err">undone</span>
```

junto al badge de role.

- [ ] En `web/src/styles/global.css`, si `.badge.err` ya existe (agent-tools), no tocar. Si no hay `.badge`, no inventar un design system: usar `className="badge"` existente + `style={{ color: "var(--danger)" }}` en el span `undone`.

- [ ] Correr:

```bash
cd web && bun test src/lib/turn-select.test.ts
```

Esperado: pasa.

- [ ] Commit:

```bash
git add web/src/lib/undo-constants.ts web/src/lib/turn-select.ts \
  web/src/lib/turn-select.test.ts web/src/lib/ws-hooks.ts \
  web/src/lib/ws-client.ts web/src/components/ChatDetailPanel.tsx \
  web/src/styles/global.css web/package.json
git commit -m "feat(undo): Web undo/retry buttons and undone badge"
```

---

## Task 8: Smokes de integración — git restore, no-git, noop, retry, Web↔TUI

**Files:**

- Create: `cli/scripts/undo-smoke.ts`
- Create: `cli/src/llm/retry-history.test.ts`

Sin LLM. El daemon de test publica checkpoints y ejecuta `restoreTurn` real sobre un tmp repo; un segundo cliente observa `chat.checkpoint.undone`.

- [ ] Crear `cli/src/llm/retry-history.test.ts` — guarda Gherkin “no re-ejecuta tools históricas”:

```ts
import { describe, expect, test } from "bun:test";
import { historyFromChatMessages } from "./history";
import { retryPayloadFromMessages } from "./retry-payload";

describe("retry does not replay tools", () => {
  test("history drops tool rows; payload has no toolCallId", () => {
    const messages = [
      {
        role: "user",
        content: "edit a.ts",
        metadata: { streamId: "s1", checkpoint: { kind: "git", streamId: "s1" } },
      },
      {
        role: "tool",
        content: "wrote",
        metadata: { streamId: "s1", toolCallId: "t1", toolName: "Write" },
      },
      { role: "assistant", content: "done", metadata: { streamId: "s1" } },
    ];
    const hist = historyFromChatMessages(messages, "edit a.ts");
    expect(hist.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(hist)).not.toMatch(/toolCallId/);
    const retry = retryPayloadFromMessages(messages as never);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(JSON.stringify(retry.payload)).not.toMatch(/toolCallId/);
    }
  });
});
```

`parseCheckpoint` exigirá campos extra; en este test el checkpoint incompleto hace `selectLastTurn` null y retry cae al último user — sigue siendo el prompt `edit a.ts` **sin** tools. Si `selectLastTurn` exige checkpoint parseable, poné el `gitCp` completo de Task 1.

- [ ] Crear `cli/scripts/undo-smoke.ts`:

```ts
/**
 * Smoke: undo restores allowlisted files; no-git does not touch disk;
 * rejected-ask noop; second client sees chat.checkpoint.undone.
 * Requires API + token (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 */
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { createTurnCheckpoint, finalizeCheckpoint } from "../src/llm/git-checkpoint";
import { restoreTurn } from "../src/llm/git-restore";
import { runGit } from "../src/llm/git-exec";
import {
  SHELL_SIDE_EFFECT_WARNING,
  UNDO_NOOP,
  UNDO_REQUIRES_GIT,
} from "../src/llm/undo-constants";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-smoke-"));
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
  await runGit(cwd, ["config", "user.name", "Undo Bot"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  writeFileSync(join(cwd, "c.ts"), "c\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

// --- local git (no API) ---
{
  const cwd = await initRepo();
  const cp = await createTurnCheckpoint(cwd, "s-local");
  if (cp.kind !== "git") fail("expected git checkpoint");
  writeFileSync(join(cwd, "a.ts"), "two\n");
  writeFileSync(join(cwd, "b.ts"), "new\n");
  const fin = await finalizeCheckpoint(cwd, cp, { paths: ["a.ts", "b.ts"], hadBash: true });
  const out = await restoreTurn({ cwd, chatId: "c1", checkpoint: fin });
  if (readFileSync(join(cwd, "a.ts"), "utf8") !== "one\n") fail("a.ts not restored");
  if (existsSync(join(cwd, "b.ts"))) fail("b.ts should be deleted");
  if (readFileSync(join(cwd, "c.ts"), "utf8") !== "c\n") fail("c.ts should stay");
  if (!out.warning || !out.warning.includes("Unversioned shell")) {
    fail(`expected shell warning, got ${out.warning}`);
  }
  console.log("ok local-restore-allowlist");
}

{
  const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-smoke-"));
  writeFileSync(join(cwd, "a.ts"), "hello\n");
  const out = await restoreTurn({
    cwd,
    chatId: "c1",
    checkpoint: {
      kind: "none",
      streamId: "s",
      reason: "not_git",
      headSha: null,
      commitSha: null,
      treeSha: null,
      branch: null,
      paths: ["a.ts"],
      commitsCreated: [],
      hadBash: false,
      appliedMutations: true,
      createdAt: new Date().toISOString(),
    },
  });
  if (out.message !== UNDO_REQUIRES_GIT) fail(out.message);
  if (out.diskTouched) fail("disk was touched without git");
  if (readFileSync(join(cwd, "a.ts"), "utf8") !== "hello\n") fail("nongit sentinel");
  console.log("ok no-git-disk-untouched");
}

// --- live WS: two clients, undo fan-out ---
const path = await initRepo();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
if (!db.ok || !wb.ok) fail(`bind fail ${db.error} ${wb.error}`);

const session = await web.request({ type: "session.create", title: "undo-smoke" });
if (!session.ok) fail(String(session.error));
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "undo-chat",
});
if (!chat.ok) fail(String(chat.error));
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seenUndone = new Promise<Record<string, unknown>>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no chat.checkpoint.undone")), 20_000);
  web.onPush((msg) => {
    if (msg.type !== "chat.checkpoint.undone") return;
    const data = (msg.data || {}) as { chatId?: string };
    if (data.chatId && data.chatId !== chatId) return;
    clearTimeout(t);
    resolve((msg.data || {}) as Record<string, unknown>);
  });
});

const streamId = crypto.randomUUID();
let cp = await createTurnCheckpoint(path, streamId);
writeFileSync(join(path, "a.ts"), "mutated\n");
writeFileSync(join(path, "b.ts"), "created-by-turn\n");
cp = await finalizeCheckpoint(path, cp, { paths: ["a.ts", "b.ts"], hadBash: false });

const append = await daemon.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "edit two files",
  metadata: { streamId, checkpoint: cp },
});
if (!append.ok) fail(String(append.error));
await daemon.request({
  type: "chat.checkpoint.finalized",
  chatId,
  streamId,
  checkpoint: cp,
});

const undo = await web.request({ type: "agent.turn.undo", chatId }, 30_000);
if (!undo.ok) fail(`undo rpc ${undo.error}`);
const undoneEv = await seenUndone;
if (readFileSync(join(path, "a.ts"), "utf8") !== "one\n") fail("live a.ts");
if (existsSync(join(path, "b.ts"))) fail("live b.ts");
console.log("ok web-undo-tui-sees-undone", undoneEv.streamId || streamId);

// noop: mark appliedMutations false on a second turn
const s2 = crypto.randomUUID();
let cp2 = await createTurnCheckpoint(path, s2);
cp2 = await finalizeCheckpoint(path, cp2, { paths: [], hadBash: false });
await daemon.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "solo lecturas",
  metadata: { streamId: s2, checkpoint: { ...cp2, appliedMutations: false } },
});
await daemon.request({
  type: "chat.checkpoint.finalized",
  chatId,
  streamId: s2,
  checkpoint: { ...cp2, appliedMutations: false, paths: [] },
});
const sentinel = readFileSync(join(path, "a.ts"), "utf8");
const noop = await web.request({ type: "agent.turn.undo", chatId }, 30_000);
if (!noop.ok) fail(`noop undo ${noop.error}`);
const nd = (noop.data || {}) as { noop?: boolean; message?: string };
if (!nd.noop) fail("expected noop for rejected/read-only turn");
if (!String(nd.message || "").includes("no applied changes")) fail(String(nd.message));
if (readFileSync(join(path, "a.ts"), "utf8") !== sentinel) fail("noop touched disk");
console.log("ok ask-rejected-noop");

// retry does not require tools
const retry = await web.request({ type: "agent.turn.retry", chatId }, 30_000);
if (!retry.ok) fail(`retry ${retry.error}`);
const rd = (retry.data || {}) as { accepted?: boolean; prompt?: string };
if (!rd.accepted) fail("retry not accepted");
if (!rd.prompt) fail("retry missing prompt");
console.log("ok retry-new-turn");

daemon.close();
web.close();
console.log("SMOKE PASS");
```

El bind-as-daemon choca con un daemon real en ese cwd. Correr el smoke en el **tmp repo** (`path` de `initRepo`), no en el checkout de Chavez. `workspace.bind` usará ese path absoluto: no hace falta `workspace open` previo. Si `findDaemon` devolviera otro daemon del mismo user en **otro** path, no aplica (match es workspaceId derivado del path).

Si `agent.turn.undo.dispatch` no llega porque el smoke daemon no tiene el handler (código no mergeado), el `web.request` timeout 30s falla el smoke — no silenciar.

- [ ] Correr unitarios + smoke:

```bash
cd cli && bun test src/llm/turn-select.test.ts src/llm/undo-decide.test.ts \
  src/llm/retry-payload.test.ts src/llm/git-detect.test.ts \
  src/llm/git-checkpoint.test.ts src/llm/git-restore.test.ts \
  src/llm/run-undo.test.ts src/llm/retry-history.test.ts \
  src/llm/watch-format-undo.test.ts
cd api && bun test src/llm/turn-select.test.ts
cd web && bun test src/lib/turn-select.test.ts
```

Esperado: todos pasan.

```bash
cd cli && bun run scripts/undo-smoke.ts
```

Esperado: `SMOKE PASS` y las líneas `ok local-restore-allowlist`, `ok no-git-disk-untouched`, `ok web-undo-tui-sees-undone`, `ok ask-rejected-noop`, `ok retry-new-turn`.

- [ ] Commit:

```bash
git add cli/scripts/undo-smoke.ts cli/src/llm/retry-history.test.ts
git commit -m "test(undo): git restore, no-git, noop, retry, live fan-out"
```

---

## Orden de ejecución

1. Task 1 (módulos puros) — no depende de git ni API.
2. Task 2 (git checkpoint/restore) — no depende de API; sí de `workspace-path`.
3. Task 3 (API CAS) — no depende del runner.
4. Task 4 (publish-turn + daemon) — depende de 1–3.
5. Task 5 (CLI) — depende de Task 3.
6. Task 6 (TUI) — depende de Tasks 1 y 4.
7. Task 7 (Web) — depende de Task 3.
8. Task 8 (smoke) — después de 2+3+4; idealmente al final.

Tasks 5, 6 y 7 son paralelizables entre sí una vez 1–4 están mergeadas.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Undo restaura archivos tocados; timeline `undone`; commits revert o aviso | Task 2 `restoreTurn` + `decideCommitAction`; Task 4 snapshot/finalize; Task 3 parche `metadata.undone`; Task 6/7 badge; Task 8 smoke allowlist |
| Sin git, undo no está; disco intacto | Task 1 `gateUndo` `UNDO_REQUIRES_GIT`; Task 2 restore `diskTouched: false`; Task 3 fail sin dispatch; Task 6/7 botón disabled + `NO_GIT_UI`; Task 8 `ok no-git-disk-untouched` |
| Solo el último turn | Task 1 `selectLastTurn` dos turns; Task 3 despacha el más reciente; el anterior no está en `paths` |
| Undo en ask de un turn rechazado es no-op y lo dice | Task 1 `appliedMutations: false` → `UNDO_NOOP`; Task 3 `ok` + `noop: true` sin dispatch; Task 8 `ok ask-rejected-noop` |
| Retry: turn nuevo, mismo texto y attaches, no re-ejecuta tools | Task 1 `retryPayloadFromMessages`; Task 3 `agent.turn.retry` → `agent.turn.dispatch`; `history.ts` tira `role=tool`; Task 8 `retry-history.test.ts` + `ok retry-new-turn` |
| Bash destructivo: versionados vuelven; aviso de shell | Task 2 `hadBash` + ignored file; Task 4 `hadBash` desde tool Bash; `SHELL_SIDE_EFFECT_WARNING` en result; Task 5 watch; Task 8 warning assert |
| Web y TUI disparan undo; el otro ve el resultado | Task 3 broadcast `chat.checkpoint.undone`; Task 6 tecla `u` + onPush; Task 7 botón + invalidate; Task 8 dos clientes |

## Fuera de este plan (no implementar)

- Slash `/undo` / `/retry` → [slash-commands](../slash-commands/plan.md). Esta fase deja el RPC que slash invocará.
- Git commit / push / PR como tools de producto → [git-workspace](../git-workspace/plan.md).
- Diffs panel / body bajo demanda → [diffs-review](../diffs-review/plan.md). Aquí git es sensor + restore; si el collector existe se **unen** sus paths al allowlist.
- Cancelar el turn en vuelo → [thinking-steer-cancel](../thinking-steer-cancel/plan.md). Cancel **no** es undo.
- Cola de turns / worktrees → planes 29 y 28.
- Cursor ejecutable → [cursor-provider](../cursor-provider/plan.md). Mismo checkpoint git cuando exista.
- Notificaciones in-app genéricas → [notifications](../notifications/plan.md). El badge/log de este plan es UI del turn, no un centro de notificaciones.
