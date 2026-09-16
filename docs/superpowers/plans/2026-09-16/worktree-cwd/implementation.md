# Worktree Cwd Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, worktrees **paralelos**, cola FIFO (plan 29), `git worktree remove`/`lock`/`prune` de producto, ni un segundo daemon por worktree. Spec: [`plan.md`](./plan.md). Depende del dispatch existente (`agent.turn.request` → `agent.turn.dispatch` → `publishAgentTurn`) y, si ya aterrizaron, de `runGit`/`detectGit` ([`checkpoints-undo`](../checkpoints-undo/implementation.md) / [`git-workspace`](../git-workspace/implementation.md)), hostname en bind ([`attach-files`](../attach-files/implementation.md) / [`daemon-reconnect`](../daemon-reconnect/implementation.md)), sandbox `resolveInsideCwd` ([`attach-files`](../attach-files/implementation.md) / [`agent-tools`](../agent-tools/implementation.md)), diffs por turn ([`diffs-review`](../diffs-review/implementation.md)) y `turnBusy` / cola ([`invariants`](../invariants/implementation.md) / [`turn-queue`](../turn-queue/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **no** sustituye la cola: el worktree es **dónde** corre el **siguiente** turn.

**Goal:** El usuario elige o crea un `git worktree` y el **siguiente** turn del daemon corre ahí: `@`, tools, diffs y git operan sobre ese path. Web muestra `hostname · path` del worktree (no el bind original si ya se cambió). Un solo writer: dos worktrees **no** son dos turns. Sin git, worktree no aplica y se usa el cwd del workspace.

**Architecture:** El filesystem y git viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI `clientKind: "daemon"`). El **workspace** sigue identificado por el path de `workspace.bind` (fila `workspaces.path`, unique `(userId, path)`). El worktree es un **cwd efectivo** del daemon, no un workspace nuevo y no un segundo runner. La API **no** ejecuta `git worktree`: reenvía RPCs al daemon bound y hace fan-out de `workspace.cwd.changed`. `publishAgentTurn` y todo I/O de disco usan `getEffectiveCwd()`; **nunca** `process.chdir` y **nunca** `workspaces.path` de la API como raíz de sandbox tras un switch.

```
Web WorktreeBar | TUI tecla w | CLI headless worktree
        |
        |  list | add | select
        v
  API  hub.findDaemon
        |  no daemon → NO_DAEMON_ERROR
        |  add/select + turnBusy → TURN_BUSY_ERROR
        v
  daemon  detectGit(bindPath)
        |  !repo → WORKTREE_REQUIRES_GIT  (cwd = bindPath)
        |  list  → git worktree list --porcelain
        |  add   → git worktree add [-b] <path> <branch>  luego switch
        |  select→ mismo git-common-dir, setEffectiveCwd
        |
        persist ~/.chavez/workspaces/<hash>.json  { path: bindPath, cwd }
        hub.cwd = effectiveCwd
        broadcast workspace.cwd.changed { hostname, cwd, bindPath, snapshot }
        |
        v
  siguiente agent.turn.dispatch
        publishAgentTurn({ cwd: getEffectiveCwd() })
        @ / Read,Write,Edit,Grep,Glob,Bash / diffs / git  → ese cwd
        sandbox root = effectiveCwd  (el worktree suele ser sibling: fuera del bind)
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/ws/daemon.ts` bindea `argv[2]` (path absoluto), `writeWorkspaceState({ path, pid, openedAt, workspaceId })`. `onPush` solo `agent.turn.dispatch`. `publishAgentTurn({ cwd: data.path || path })` — **si la API manda `workspaces.path`, un switch de worktree se perdería en el siguiente turn.** Esta fase lo corta: el daemon **ignora** `data.path` para ejecución.
- `tui/src/App.tsx`: `cwd = env.public.chavezCwd` (bind). Header `cwd: {cwd}`. Local `sendWithLlm` y dispatch remoto usan ese bind. **No** hay tecla `w`.
- `cli/src/workspace.ts`: state keyed por hash del bind path. **No** hay campo `cwd`.
- `api/src/ws/hub.ts`: `path` = bind. **No** hay `cwd`. `findDaemon` = primer `clientKind === "daemon"`.
- `api/src/ws/handlers.ts` `agent.turn.request` despacha `{ path: workspace?.path || daemon.path }`. `workspace.bind` no acepta `cwd`.
- `GET /connections` (`api/src/routes/workspaces.ts`) = `hub.listForUser` → `connectionId, workspaceId, path, clientKind, connectedAt`. OpenAPI `ConnectionPublic` **omite** `clientKind` y `cwd`.
- Web `ChatDetailPanel.tsx` / `WorkspaceDetailPanel.tsx`: no muestran hostname · worktree. `WorkspacesPanel.tsx` lista `w.path` (bind).
- CLI: `chavez headless workspace open|close|status`. **No** hay `worktree`.
- `cli/src/llm/claude-runner.ts` `query({ cwd })`. Tras planes 2–3, tools y `resolveInsideCwd` usan ese `cwd`.
- Plan 7 (`git-workspace`) opera git del cwd; **no** lista worktrees. Reusar `runGit` / `detectGit`. Si no existen, crearlos aquí con la misma firma.
- Plan 29 (`turn-queue`): el drain usa el cwd **actual** del daemon al promover. Esta fase **no** estampa worktree en el queued. Si la cola no aterrizó, el segundo turn falla `TURN_BUSY_ERROR` (planes 2/5).
- Plan 17: reconnect re-bindea el **mismo** bind path; esta fase restaura `cwd` desde el state file si el worktree sigue existiendo.
- Cursor `runnable: false`. El cwd es del daemon, no del provider.
- **Cero** migración Drizzle. **Cero** tabla `worktrees`. **Cero** `workspaces.path` apuntando al worktree.

**Tech Stack:** Bun, Hono WebSocket hub in-memory, git CLI en el daemon (`git -C <cwd> worktree …`), `node:os.hostname()`, Claude Agent SDK `query({ cwd: effectiveCwd })` (sin cambio de tools), Ink TUI, Astro/React web. Tests: `bun test`. Sin isomorphic-git / simple-git / git.js. Web y API **no** importan CLI: duplicar constants (comentario keep-in-sync). TUI importa `cli/src/llm/worktree.ts` y `cli/src/llm/effective-cwd.ts`.

**Global Constraints:**

1. El filesystem y git se tocan **solo** en el daemon. API y browser no ejecutan `git worktree`, no clonan, no listan el disco del servidor.
2. Sin daemon bound, `workspace.worktree.*` y `agent.turn.request` fallan con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. **1 turn por daemon** (decisión 17). Dos worktrees ≠ dos writers. No hay segundo proceso, no hay `query()` concurrente, no hay `GIT_INDEX_FILE` paralelo de producto. El segundo turn se **encola** (plan 29) o espera/falla `TURN_BUSY_ERROR`.
4. `add` / `select` con `turnBusy` fallan `TURN_BUSY_ERROR`. `list` **sí** puede correr durante un turn (`GIT_OPTIONAL_LOCKS=0`).
5. Sin repo (`rev-parse --is-inside-work-tree` ≠ `true`) o sin binario git: worktree **no aplica**. Error exacto `WORKTREE_REQUIRES_GIT`. Cwd = bind path. UI deshabilitada con `WORKTREE_NO_GIT_UI`. **Cero** `git worktree add` inventado.
6. El sandbox de tools/`@`/árbol usa **effectiveCwd** como raíz. Un worktree sibling (`../repo-feat`) está **fuera** del bind path: si el sandbox siguiera el bind, todo el worktree sería `Path outside workspace`. Tras el switch, `resolveInsideCwd(effectiveCwd, …)`.
7. `workspace.bind` **no** cambia al path del worktree. Sessions/chats siguen en el mismo `workspaceId`. El WorktreeBar **nunca** llama `workspace.bind` con el path del worktree.
8. Web, TUI y CLI `watch` ven el mismo `workspace.cwd.changed` (`hostname · cwd`). El picker `@` (plan 1) y el árbol (plan 18) reutilizan el `cwd` que ya devuelve el daemon.
9. Provider / modelo / esfuerzo / modo **no** se tocan. El worktree no vive en `user_preferences` (es por workspace, en el state file del daemon + `hub.cwd`).
10. Claude es el ejecutable hoy. Cursor vinculado no corre turns aquí; el cwd aplica igual cuando el plan 4 exista.
11. Aprobaciones una a una (plan 13) no cambian. Cambiar de worktree no es una aprobación.
12. Undo (plan 12) y diffs (plan 6) corren sobre el cwd efectivo del turn. Un undo no salta de worktree.
13. Un usuario = su vault. El worktree es local al daemon de ese user. No hay worktree de org.
14. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, cola FIFO (implementarla es plan 29), worktrees paralelos, `git worktree remove`/`move`/`lock` como producto, auto-merge de un bind hecho a mano sobre el path del worktree.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `WORKTREE_REQUIRES_GIT` | `"Worktree requires a git repository in the workspace"` |
| `WORKTREE_NO_GIT_UI` | `"Este workspace no es un repo git — se usa el cwd del workspace"` |
| `WORKTREE_NOT_FOUND` | `"Worktree not found in this repository"` |
| `WORKTREE_AMBIGUOUS` | `"Branch matches more than one worktree — pass the absolute path"` |
| `WORKTREE_FOREIGN` | `"Path is not a worktree of this workspace repository"` |
| `WORKTREE_MISSING` | `"Selected worktree no longer exists; using workspace cwd"` |
| `WORKTREE_ADD_FAILED_PREFIX` | `"git worktree add failed: "` |
| `WORKTREE_BUSY` | `TURN_BUSY_ERROR` (mismo string; no inventar otro) |
| `WORKTREE_MAIN_TOKEN` | `"@main"` |
| `WORKTREE_RPC_TIMEOUT_MS` | `15_000` |
| `WORKTREE_ADD_TIMEOUT_MS` | `60_000` |
| `WORKTREE_LIST_LIMIT` | `50` |
| `WEB_CWD_SEP` | `" · "` |
| `WEB_WORKTREE_BADGE` | `"worktree"` |
| `TUI_WORKTREE_HINT` | `"w worktree · Enter elige · n crea · Esc cierra"` |
| `WATCH_CWD_PREFIX` | `"cwd · "` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` si ya existen en `api/src/ws/errors.ts` o `cli/src/llm/tool-names.ts`; **no** cambiar esos strings.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `workspace.worktree.list` | cliente → API | Pedir snapshot. API espera al daemon. |
| `workspace.worktree.add` | cliente → API | `{ branch, path?, createBranch? }`. Crea y **selecciona**. |
| `workspace.worktree.select` | cliente → API | `{ path }` o `{ branch }` o `{ path: "@main" }`. |
| `workspace.worktree.dispatch` | API → daemon | `{ requestId, action, path, payload }` — `path` es el **bind**. |
| `workspace.worktree.result` | daemon → API | Completa el pending. `metadata` = snapshot + `ok`. |
| `workspace.cwd.changed` | API → broadcast | `{ workspaceId, hostname, cwd, bindPath, snapshot }` — Web/TUI/watch coinciden. |

HTTP: ninguno nuevo. Reload: `workspace.worktree.list` o `GET /connections` (`cwd` + `path`). `workspace.bind` acepta `cwd` opcional del daemon (restore).

Tipos (congelados):

```ts
export type WorktreeEntry = {
  path: string;          // absoluto posix
  headSha: string | null;
  branch: string | null; // null si detached
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
};

export type WorktreeSnapshot = {
  isRepo: boolean;
  gitAvailable: boolean;
  message?: string;
  bindPath: string;
  cwd: string;
  hostname: string;
  current: WorktreeEntry | null;
  worktrees: WorktreeEntry[]; // máx WORKTREE_LIST_LIMIT; main primero
};

export type WorktreeAction = "list" | "add" | "select";

export type WorktreeAddPayload = {
  branch: string;
  path?: string;
  createBranch?: boolean;
  startPoint?: string;
};

export type WorktreeSelectPayload = {
  path?: string;
  branch?: string;
};
```

`formatDaemonCwdLabel(hostname, cwd)` → `` `${hostname || "daemon"}${WEB_CWD_SEP}${cwd}` ``.

---

## Task 1: Módulo puro — porcelain, path por defecto, label

**Files:**

- Create: `cli/src/llm/worktree-constants.ts`
- Create: `cli/src/llm/worktree-model.ts`
- Create: `cli/src/llm/worktree-parse.ts`
- Test: `cli/src/llm/worktree-parse.test.ts`
- Modify: `cli/package.json`

Sin I/O de git. TUI importa desde aquí. API y Web duplican constants en Tasks 4 y 7 (keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/worktree-constants.ts`:

```ts
export const WORKTREE_REQUIRES_GIT =
  "Worktree requires a git repository in the workspace";
export const WORKTREE_NO_GIT_UI =
  "Este workspace no es un repo git — se usa el cwd del workspace";
export const WORKTREE_NOT_FOUND = "Worktree not found in this repository";
export const WORKTREE_AMBIGUOUS =
  "Branch matches more than one worktree — pass the absolute path";
export const WORKTREE_FOREIGN =
  "Path is not a worktree of this workspace repository";
export const WORKTREE_MISSING =
  "Selected worktree no longer exists; using workspace cwd";
export const WORKTREE_ADD_FAILED_PREFIX = "git worktree add failed: ";
export const WORKTREE_MAIN_TOKEN = "@main";
export const WORKTREE_RPC_TIMEOUT_MS = 15_000;
export const WORKTREE_ADD_TIMEOUT_MS = 60_000;
export const WORKTREE_LIST_LIMIT = 50;
export const WEB_CWD_SEP = " · ";
export const WEB_WORKTREE_BADGE = "worktree";
export const TUI_WORKTREE_HINT =
  "w worktree · Enter elige · n crea · Esc cierra";
export const WATCH_CWD_PREFIX = "cwd · ";
```

- [ ] Crear `cli/src/llm/worktree-parse.ts`:

```ts
import { basename, dirname } from "node:path";
import {
  WATCH_CWD_PREFIX,
  WEB_CWD_SEP,
  WEB_WORKTREE_BADGE,
  WORKTREE_AMBIGUOUS,
  WORKTREE_LIST_LIMIT,
  WORKTREE_MAIN_TOKEN,
  WORKTREE_NOT_FOUND,
} from "./worktree-constants";
import type { WorktreeEntry } from "./worktree-model";

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "") || p;
}

export function defaultWorktreePath(mainWorktree: string, branch: string): string {
  const main = toPosix(mainWorktree);
  const parent = dirname(main);
  const base = basename(main);
  const slug =
    branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
  return `${parent}/${base}-${slug}`;
}

export function isMainWorktree(entryPath: string, gitCommonDir: string): boolean {
  const common = toPosix(gitCommonDir);
  const main = common.endsWith("/.git") ? common.slice(0, -5) : dirname(common);
  return toPosix(entryPath) === toPosix(main);
}

export function parseWorktreePorcelain(
  stdout: string,
  gitCommonDir: string | null,
): WorktreeEntry[] {
  const blocks = stdout.replace(/\r\n/g, "\n").split("\n\n");
  const out: WorktreeEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (!lines.length) continue;
    let path = "";
    let headSha: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let locked = false;
    let prunable = false;
    let bare = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = toPosix(line.slice("worktree ".length));
      else if (line.startsWith("HEAD ")) {
        const sha = line.slice("HEAD ".length).trim();
        headSha = /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref || null;
      } else if (line === "detached") detached = true;
      else if (line === "bare" || line.startsWith("bare ")) bare = true;
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
    }
    if (!path || bare) continue;
    out.push({
      path,
      headSha,
      branch: detached ? null : branch,
      detached,
      locked,
      prunable,
      isMain: gitCommonDir ? isMainWorktree(path, gitCommonDir) : out.length === 0,
    });
  }
  out.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.path.localeCompare(b.path));
  return out.slice(0, WORKTREE_LIST_LIMIT);
}

export function resolveSelectTarget(
  worktrees: WorktreeEntry[],
  payload: { path?: string; branch?: string },
): { ok: true; entry: WorktreeEntry } | { ok: false; error: string } {
  if (payload.path === WORKTREE_MAIN_TOKEN) {
    const main = worktrees.find((w) => w.isMain);
    return main
      ? { ok: true, entry: main }
      : { ok: false, error: WORKTREE_NOT_FOUND };
  }
  if (payload.path) {
    const want = toPosix(payload.path);
    const hit = worktrees.find((w) => w.path === want);
    return hit
      ? { ok: true, entry: hit }
      : { ok: false, error: WORKTREE_NOT_FOUND };
  }
  if (payload.branch) {
    const hits = worktrees.filter((w) => w.branch === payload.branch);
    if (hits.length === 1) return { ok: true, entry: hits[0]! };
    if (hits.length > 1) return { ok: false, error: WORKTREE_AMBIGUOUS };
    return { ok: false, error: WORKTREE_NOT_FOUND };
  }
  return { ok: false, error: WORKTREE_NOT_FOUND };
}

export function formatDaemonCwdLabel(hostname: string | null | undefined, cwd: string): string {
  return `${hostname || "daemon"}${WEB_CWD_SEP}${cwd}`;
}

export function formatWatchCwdLine(snapshot: {
  hostname?: string;
  cwd?: string;
  current?: { branch?: string | null; isMain?: boolean } | null;
}): string {
  const host = snapshot.hostname || "daemon";
  const cwd = snapshot.cwd || "";
  const br = snapshot.current?.branch;
  const extra = snapshot.current && !snapshot.current.isMain
    ? ` ${WEB_WORKTREE_BADGE}${br ? ` ${br}` : ""}`
    : br
      ? ` ${br}`
      : "";
  return `${WATCH_CWD_PREFIX}${host}${WEB_CWD_SEP}${cwd}${extra}`;
}
```

- [ ] Crear `cli/src/llm/worktree-model.ts` con los tipos congelados (`WorktreeEntry`, `WorktreeSnapshot`, `WorktreeAction`, `WorktreeAddPayload`, `WorktreeSelectPayload`).

- [ ] Crear `cli/src/llm/worktree-parse.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  defaultWorktreePath,
  formatDaemonCwdLabel,
  formatWatchCwdLine,
  isMainWorktree,
  parseWorktreePorcelain,
  resolveSelectTarget,
  toPosix,
} from "./worktree-parse";
import {
  WATCH_CWD_PREFIX,
  WEB_CWD_SEP,
  WORKTREE_AMBIGUOUS,
  WORKTREE_MAIN_TOKEN,
  WORKTREE_NOT_FOUND,
} from "./worktree-constants";

const porcelain = `
worktree /datos/Work/repo
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/main

worktree /datos/Work/repo-feat
HEAD abcdef0123456789abcdef0123456789abcdef01
branch refs/heads/feat

worktree /datos/Work/repo-hotfix
HEAD fedcba9876543210fedcba9876543210fedcba98
detached
locked

worktree /datos/Work/repo.git
HEAD 0123456789abcdef0123456789abcdef01234567
bare
`.trim();

describe("parseWorktreePorcelain", () => {
  test("skips bare, flags main/locked/detached, caps order", () => {
    const rows = parseWorktreePorcelain(porcelain, "/datos/Work/repo/.git");
    expect(rows.map((r) => r.path)).toEqual([
      "/datos/Work/repo",
      "/datos/Work/repo-feat",
      "/datos/Work/repo-hotfix",
    ]);
    expect(rows[0]?.isMain).toBe(true);
    expect(rows[1]?.branch).toBe("feat");
    expect(rows[2]?.detached).toBe(true);
    expect(rows[2]?.locked).toBe(true);
    expect(rows[2]?.branch).toBeNull();
  });
});

describe("isMainWorktree / defaultWorktreePath", () => {
  test("main is parent of .git", () => {
    expect(isMainWorktree("/datos/Work/repo", "/datos/Work/repo/.git")).toBe(true);
    expect(isMainWorktree("/datos/Work/repo-feat", "/datos/Work/repo/.git")).toBe(false);
  });
  test("sibling path from branch", () => {
    expect(defaultWorktreePath("/datos/Work/repo", "feat/foo")).toBe(
      "/datos/Work/repo-feat-foo",
    );
  });
});

describe("resolveSelectTarget", () => {
  const rows = parseWorktreePorcelain(porcelain, "/datos/Work/repo/.git");
  test("@main and path and unique branch", () => {
    expect(resolveSelectTarget(rows, { path: WORKTREE_MAIN_TOKEN }).ok).toBe(true);
    expect(
      (resolveSelectTarget(rows, { path: "/datos/Work/repo-feat" }) as { entry: { branch: string } })
        .entry.branch,
    ).toBe("feat");
    expect(
      (resolveSelectTarget(rows, { branch: "feat" }) as { entry: { path: string } }).entry.path,
    ).toBe("/datos/Work/repo-feat");
  });
  test("missing and ambiguous", () => {
    const dup = [...rows, { ...rows[1]!, path: "/datos/Work/repo-feat-2" }];
    expect(resolveSelectTarget(rows, { path: "/nope" })).toEqual({
      ok: false,
      error: WORKTREE_NOT_FOUND,
    });
    expect(resolveSelectTarget(dup, { branch: "feat" })).toEqual({
      ok: false,
      error: WORKTREE_AMBIGUOUS,
    });
  });
});

describe("labels", () => {
  test("hostname · path", () => {
    expect(formatDaemonCwdLabel("host-a", "/wt")).toBe(`host-a${WEB_CWD_SEP}/wt`);
    expect(formatWatchCwdLine({
      hostname: "host-a",
      cwd: "/wt",
      current: { branch: "feat", isMain: false },
    })).toBe(`${WATCH_CWD_PREFIX}host-a${WEB_CWD_SEP}/wt worktree feat`);
  });
  test("toPosix strips slash", () => {
    expect(toPosix("/x/y/")).toBe("/x/y");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/worktree-parse.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/worktree-constants.ts cli/src/llm/worktree-model.ts \
  cli/src/llm/worktree-parse.ts cli/src/llm/worktree-parse.test.ts \
  cli/package.json
git commit -m "feat(worktree): porcelain parser, default sibling path, cwd label"
```

---

## Task 2: `list` / `add` / `select` sobre git real + `effective-cwd`

**Files:**

- Create: `cli/src/llm/git-exec.ts` (solo si plan 12/7 **no** lo creó; si existe, **no** reescribir)
- Create: `cli/src/llm/git-detect.ts` (idem)
- Create: `cli/src/llm/effective-cwd.ts`
- Test: `cli/src/llm/effective-cwd.test.ts`
- Create: `cli/src/llm/worktree.ts`
- Test: `cli/src/llm/worktree.test.ts`

I/O local de git sobre dirs temporales. **Cero** red. **Cero** `process.chdir`. **Cero** `reset --hard`.

- [ ] Si `cli/src/llm/git-exec.ts` no existe, crearlo **idéntico** al de checkpoints-undo Task 2:

```ts
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
  timeoutMs = 15_000,
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

Si el archivo ya exporta `runGit` con `timeoutMs` opcional, **úsalo**. Importar `GIT_CMD_TIMEOUT_MS` desde `undo-constants.ts` si existe.

- [ ] Si `cli/src/llm/git-detect.ts` no existe, crearlo como en plan 12 (`detectGit` → `{ isRepo, gitAvailable, headSha, branch, gitDir }`). Añadir **solo si falta** el helper `gitCommonDir`:

```ts
import { resolve } from "node:path";

export async function gitCommonDir(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
  if (!r.ok || !r.stdout.trim()) return null;
  const raw = r.stdout.trim();
  if (raw.startsWith("/")) return raw.replace(/\\/g, "/");
  return resolve(cwd, raw).replace(/\\/g, "/");
}
```

Si `detectGit` ya existe, **añade** `gitCommonDir` en el mismo archivo (o en `worktree.ts` si preferís no tocar detect). Firma estable.

- [ ] Crear `cli/src/llm/effective-cwd.ts`:

```ts
import { existsSync } from "node:fs";
import { toPosix } from "./worktree-parse";
import { WORKTREE_MISSING } from "./worktree-constants";

let bindPath = "";
let cwd = "";

export function initEffectiveCwd(bind: string, restored?: string | null): string {
  bindPath = toPosix(bind);
  const next = restored ? toPosix(restored) : bindPath;
  cwd = next && existsSync(next) ? next : bindPath;
  return cwd;
}

export function getBindPath(): string {
  return bindPath;
}

export function getEffectiveCwd(): string {
  return cwd || bindPath;
}

export function setEffectiveCwd(next: string): string {
  cwd = toPosix(next);
  return cwd;
}

export function restoreOrFallback(restored: string | null | undefined): {
  cwd: string;
  message?: string;
} {
  if (restored && existsSync(restored)) {
    cwd = toPosix(restored);
    return { cwd };
  }
  cwd = bindPath;
  if (restored && restored !== bindPath) {
    return { cwd, message: WORKTREE_MISSING };
  }
  return { cwd };
}
```

**Prohibido** llamar `process.chdir` en este módulo y en el resto de la fase.

- [ ] Test `cli/src/llm/effective-cwd.test.ts`: `initEffectiveCwd("/tmp/a")` → bind y cwd `/tmp/a` (usar `mkdtempSync`). `setEffectiveCwd` cambia cwd, **no** bind. `restoreOrFallback` de un path inexistente vuelve a bind y `message === WORKTREE_MISSING`. `process.cwd()` **no** cambia (guardar `process.cwd()` al inicio del test y comparar).

- [ ] Crear `cli/src/llm/worktree.ts`:

```ts
import { hostname as osHostname } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectGit, gitCommonDir } from "./git-detect";
import { runGit } from "./git-exec";
import {
  getBindPath,
  getEffectiveCwd,
  initEffectiveCwd,
  setEffectiveCwd,
} from "./effective-cwd";
import {
  WORKTREE_ADD_FAILED_PREFIX,
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_FOREIGN,
  WORKTREE_REQUIRES_GIT,
} from "./worktree-constants";
import type {
  WorktreeAddPayload,
  WorktreeSelectPayload,
  WorktreeSnapshot,
} from "./worktree-model";
import {
  defaultWorktreePath,
  parseWorktreePorcelain,
  resolveSelectTarget,
  toPosix,
} from "./worktree-parse";

export { getBindPath, getEffectiveCwd, setEffectiveCwd };

function emptySnapshot(message: string, extra?: Partial<WorktreeSnapshot>): WorktreeSnapshot {
  const bind = getBindPath();
  const cwd = getEffectiveCwd() || bind;
  return {
    isRepo: false,
    gitAvailable: extra?.gitAvailable ?? false,
    message,
    bindPath: bind,
    cwd,
    hostname: osHostname(),
    current: null,
    worktrees: [],
    ...extra,
  };
}

export async function collectWorktreeSnapshot(
  bindPath = getBindPath(),
): Promise<WorktreeSnapshot> {
  const ident = await detectGit(bindPath);
  if (!ident.gitAvailable || !ident.isRepo) {
    return emptySnapshot(WORKTREE_REQUIRES_GIT, {
      gitAvailable: ident.gitAvailable,
      isRepo: false,
      bindPath: toPosix(bindPath),
      cwd: getEffectiveCwd() || toPosix(bindPath),
    });
  }
  const common = await gitCommonDir(bindPath);
  const listed = await runGit(bindPath, ["worktree", "list", "--porcelain"]);
  const worktrees = listed.ok
    ? parseWorktreePorcelain(listed.stdout, common)
    : [];
  const cwd = toPosix(getEffectiveCwd() || bindPath);
  const current = worktrees.find((w) => w.path === cwd) ?? null;
  return {
    isRepo: true,
    gitAvailable: true,
    bindPath: toPosix(bindPath),
    cwd,
    hostname: osHostname(),
    current,
    worktrees,
  };
}

export async function assertSameRepo(candidatePath: string, bindPath: string): Promise<void> {
  const a = await gitCommonDir(bindPath);
  const b = await gitCommonDir(candidatePath);
  if (!a || !b || toPosix(a) !== toPosix(b)) {
    throw new Error(WORKTREE_FOREIGN);
  }
}

export async function selectWorktree(
  payload: WorktreeSelectPayload,
  bindPath = getBindPath(),
): Promise<WorktreeSnapshot> {
  const snap = await collectWorktreeSnapshot(bindPath);
  if (!snap.isRepo) throw new Error(WORKTREE_REQUIRES_GIT);
  const hit = resolveSelectTarget(snap.worktrees, payload);
  if (!hit.ok) throw new Error(hit.error);
  await assertSameRepo(hit.entry.path, bindPath);
  if (!existsSync(hit.entry.path)) throw new Error(WORKTREE_FOREIGN);
  setEffectiveCwd(hit.entry.path);
  return collectWorktreeSnapshot(bindPath);
}

export async function addWorktree(
  payload: WorktreeAddPayload,
  bindPath = getBindPath(),
): Promise<WorktreeSnapshot> {
  const snap = await collectWorktreeSnapshot(bindPath);
  if (!snap.isRepo) throw new Error(WORKTREE_REQUIRES_GIT);
  const branch = payload.branch.trim();
  if (!branch) throw new Error("branch is required");
  const main = snap.worktrees.find((w) => w.isMain) ?? snap.worktrees[0];
  const abs = toPosix(
    payload.path?.trim() || defaultWorktreePath(main?.path || bindPath, branch),
  );
  const parent = dirname(abs);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const args = payload.createBranch
    ? ["worktree", "add", "-b", branch, abs, payload.startPoint || "HEAD"]
    : ["worktree", "add", abs, branch];
  const added = await runGit(bindPath, args, undefined, WORKTREE_ADD_TIMEOUT_MS);
  if (!added.ok) {
    throw new Error(
      `${WORKTREE_ADD_FAILED_PREFIX}${added.stderr || added.stdout || added.code}`,
    );
  }
  return selectWorktree({ path: abs }, bindPath);
}

export async function runWorktreeAction(input: {
  bindPath: string;
  action: "list" | "add" | "select";
  payload?: Record<string, unknown>;
}): Promise<{ ok: boolean; snapshot?: WorktreeSnapshot; error?: string }> {
  try {
    if (!getBindPath()) initEffectiveCwd(input.bindPath);
    let snapshot: WorktreeSnapshot;
    if (input.action === "list") {
      snapshot = await collectWorktreeSnapshot(input.bindPath);
    } else if (input.action === "add") {
      snapshot = await addWorktree(
        {
          branch: String(input.payload?.branch || ""),
          path: optionalString(input.payload?.path),
          createBranch: Boolean(input.payload?.createBranch),
          startPoint: optionalString(input.payload?.startPoint),
        },
        input.bindPath,
      );
    } else {
      snapshot = await selectWorktree(
        {
          path: optionalString(input.payload?.path),
          branch: optionalString(input.payload?.branch),
        },
        input.bindPath,
      );
    }
    return { ok: true, snapshot };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
```

`initEffectiveCwd` **solo** si `getBindPath()` está vacío (el daemon ya lo inicializó). Nunca throw al caller WS.

- [ ] Crear `cli/src/llm/worktree.test.ts` (tmp dirs, `git init` + commit):

  1. **No git.** tmp dir sin `.git`. `collectWorktreeSnapshot` → `isRepo false`, `message === WORKTREE_REQUIRES_GIT`, `cwd === bindPath`. `addWorktree` / `selectWorktree` throw ese string. Disco intacto (no aparece dir sibling).
  2. **List main.** `git init` + `git commit --allow-empty -m init` (config `user.email` / `user.name` locales). list → 1 entry `isMain true`, `cwd` = bind.
  3. **Add + select.** `addWorktree({ branch: "feat", createBranch: true })` crea sibling, `getEffectiveCwd()` = path del worktree, `current.branch === "feat"`, `current.isMain === false`. Escribir `hello.txt` **solo** en el worktree. `existsSync(bindPath + "/hello.txt") === false`. `existsSync(cwd + "/hello.txt") === true`.
  4. **Select @main.** `selectWorktree({ path: "@main" })` vuelve al bind. `getEffectiveCwd() === bindPath`.
  5. **Foreign.** `selectWorktree({ path: otroRepoTmp })` → `WORKTREE_FOREIGN` o `WORKTREE_NOT_FOUND`. `getEffectiveCwd()` no cambia.
  6. **process.cwd estable.** Guardar `process.cwd()` al inicio; tras add/select es el mismo.
  7. **Dos worktrees, un cwd.** Tras crear `feat` y `other`, `getEffectiveCwd()` es **uno**. No hay segundo `effectiveCwd`.

Usar `mkdtempSync(join(tmpdir(), "chavez-wt-"))`. `git` config local:

```
await runGit(dir, ["init"]);
await runGit(dir, ["config", "user.email", "wt@test"]);
await runGit(dir, ["config", "user.name", "wt"]);
await runGit(dir, ["commit", "--allow-empty", "-m", "init"]);
```

Si `git` no está en el runner, `detectGit.gitAvailable === false` y el test 1 basta; tests 2–7 hacen `return` temprano **solo** si `gitAvailable === false` con `test.skip` vía `if (!ok) return;` — no silenciar un fail de assert.

- [ ] Correr:

```bash
cd cli && bun test src/llm/effective-cwd.test.ts src/llm/worktree.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/git-exec.ts cli/src/llm/git-detect.ts \
  cli/src/llm/effective-cwd.ts cli/src/llm/effective-cwd.test.ts \
  cli/src/llm/worktree.ts cli/src/llm/worktree.test.ts
git commit -m "feat(worktree): list/add/select against real git, effective cwd"
```

---

## Task 3: Daemon — persistir cwd, RPC, turns usan effective cwd

**Files:**

- Modify: `cli/src/workspace.ts`
- Test: `cli/src/workspace.test.ts` (crear o extender)
- Create: `cli/src/llm/handle-worktree-rpc.ts`
- Test: `cli/src/llm/handle-worktree-rpc.test.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/llm/publish-turn.ts` (solo si hoy recibe `cwd` del caller — **no** cambiar la firma; el caller pasa `getEffectiveCwd()`)

El daemon es dueño del cwd. El state file se sigue keyeando por el **bind** path.

- [ ] Extender `WorkspaceState` en `cli/src/workspace.ts`:

```ts
export type WorkspaceState = {
  path: string;
  pid: number;
  openedAt: string;
  workspaceId?: string;
  cwd?: string;
};
```

`writeWorkspaceState` / `readWorkspaceState` ya serializan JSON: el campo nuevo entra sin migración. `statePath` sigue usando `workspaceHash(path)` del **bind**.

- [ ] Test: escribir state con `cwd` distinto de `path`; releer; `clearWorkspaceState` borra el archivo. Hash de `path` **no** cambia si solo cambia `cwd`.

- [ ] Crear `cli/src/llm/handle-worktree-rpc.ts`:

```ts
import { TURN_BUSY_ERROR } from "./tool-names"; // si no existe, declarar el string literal idéntico
import { runWorktreeAction } from "./worktree";
import type { WorktreeSnapshot } from "./worktree-model";

export async function handleWorktreeRpc(input: {
  bindPath: string;
  action: string;
  payload?: Record<string, unknown>;
  turnBusy: boolean;
}): Promise<{ ok: boolean; snapshot?: WorktreeSnapshot; error?: string }> {
  if (input.action !== "list" && input.action !== "add" && input.action !== "select") {
    return { ok: false, error: `Unknown worktree action: ${input.action}` };
  }
  if (input.turnBusy && input.action !== "list") {
    return { ok: false, error: TURN_BUSY_ERROR };
  }
  return runWorktreeAction({
    bindPath: input.bindPath,
    action: input.action,
    payload: input.payload,
  });
}
```

Si `cli/src/llm/tool-names.ts` no existe, importar de `cli/src/ws/presence-constants.ts` o definir en `worktree-constants.ts`:

```ts
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
```

**Un solo literal** por paquete.

- [ ] Test `handle-worktree-rpc.test.ts`: `turnBusy: true` + `action: "select"` → `error === TURN_BUSY_ERROR` y **no** llama add (spy: dir sibling no creado). `action: "list"` con busy → `ok: true`. `action: "nope"` → error Unknown.

- [ ] En `cli/src/ws/client.ts`, extender `WsRequest` con `hostname?: string`, `cwd?: string`, `daemonId?: string`, `requestId?: string`, `action?: string`. En `bind()`:

```ts
import { hostname } from "node:os";
import { getEffectiveCwd } from "../llm/effective-cwd";

async bind(
  path = cwdPath(),
  clientKind: "client" | "daemon" = "client",
): Promise<WsResponse> {
  return this.request({
    type: "workspace.bind",
    path,
    clientKind,
    hostname: clientKind === "daemon" ? hostname() : undefined,
    cwd: clientKind === "daemon" ? getEffectiveCwd() || path : undefined,
  });
}
```

Si attach-files/invariants ya mandan `hostname`, **añade** `cwd`; no dupliques `hostname`.

- [ ] En `cli/src/ws/daemon.ts`, justo después de normalizar `path` y **antes** de `client.bind`:

```ts
import { initEffectiveCwd, getEffectiveCwd, getBindPath } from "../llm/effective-cwd";
import { handleWorktreeRpc } from "../llm/handle-worktree-rpc";
import { collectWorktreeSnapshot } from "../llm/worktree";

const previous = readWorkspaceState(path);
initEffectiveCwd(path, previous?.cwd);
```

Tras bind ok, `writeWorkspaceState` incluye `cwd: getEffectiveCwd()`.

En `onPush`, **antes** del early-return de `agent.turn.dispatch`:

```ts
if (msg.type === "workspace.worktree.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    action?: string;
    path?: string;
    payload?: Record<string, unknown>;
  };
  const result = await handleWorktreeRpc({
    bindPath: path,
    action: String(data.action || "list"),
    payload: data.payload,
    turnBusy,
  });
  if (result.ok && result.snapshot) {
    writeWorkspaceState({
      path,
      pid: process.pid,
      openedAt: previous?.openedAt || new Date().toISOString(),
      workspaceId: workspace?.id,
      cwd: result.snapshot.cwd,
    });
  }
  await client.request({
    type: "workspace.worktree.result",
    requestId: data.requestId,
    metadata: result as unknown as Record<string, unknown>,
    status: result.ok ? "done" : "error",
  });
  return;
}
```

`previous` / `workspace` deben estar en closure (el `workspace` del bind ya existe). Si `openedAt` no está a mano, leer `readWorkspaceState(path)` dentro del handler.

- [ ] En el handler de `agent.turn.dispatch` **cambiar**:

```ts
cwd: getEffectiveCwd() || path,
```

**Prohibido** `cwd: data.path || path`. El bind path de la API no pisa el worktree.

- [ ] Correr:

```bash
cd cli && bun test src/llm/handle-worktree-rpc.test.ts src/workspace.test.ts \
  src/llm/worktree.test.ts
```

- [ ] Commit:

```bash
git add cli/src/workspace.ts cli/src/workspace.test.ts \
  cli/src/llm/handle-worktree-rpc.ts cli/src/llm/handle-worktree-rpc.test.ts \
  cli/src/ws/daemon.ts cli/src/ws/client.ts
git commit -m "feat(worktree): daemon persists cwd and runs turns in worktree"
```

---

## Task 4: API — hub.cwd, pending RPC, broadcast `workspace.cwd.changed`

**Files:**

- Create: `api/src/ws/worktree-constants.ts`
- Create: `api/src/ws/pending.ts` (solo si attach-files/git **no** lo crearon; idéntico a attach-files Task 3)
- Test: `api/src/ws/pending.test.ts` (crear o reusar)
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/hub.ts`
- Test: `api/src/ws/hub.test.ts` (crear o extender)
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/errors.ts` (crear o extender)
- Modify: `api/package.json`

Cero `child_process`, cero `git`, cero `readdir` en `api/`.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] Crear `api/src/ws/worktree-constants.ts` con los **mismos strings** que `cli/src/llm/worktree-constants.ts` (`WORKTREE_REQUIRES_GIT`, `WORKTREE_NOT_FOUND`, `WORKTREE_AMBIGUOUS`, `WORKTREE_FOREIGN`, `WORKTREE_MISSING`, `WORKTREE_ADD_FAILED_PREFIX`, `WORKTREE_MAIN_TOKEN`, `WORKTREE_RPC_TIMEOUT_MS`, `WORKTREE_ADD_TIMEOUT_MS`, `WEB_CWD_SEP`). Comentario `// keep-in-sync: cli/src/llm/worktree-constants.ts`. Reexportar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` desde `errors.ts` si existe.

- [ ] Si `api/src/ws/errors.ts` no existe:

```ts
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
```

- [ ] Si `api/src/ws/pending.ts` no existe, copiar `createPendingMap` de attach-files Task 3 (timeout resuelve `fail(..., NO_DAEMON_ERROR)`). Test timeout vs complete idéntico.

- [ ] En `api/src/ws/protocol.ts`, añadir a `ClientMessage` (dejar el resto):

```ts
  hostname?: string;
  cwd?: string;
  daemonId?: string;
  requestId?: string;
  action?: string;
  branch?: string;
```

- [ ] Extender `HubConnection` y `ConnectionPublic` en `api/src/ws/hub.ts` con `cwd: string | null` (y `hostname` si attach-files no lo puso). Default `cwd: null` en `add`. Métodos:

```ts
setCwd(connectionId: string, cwd: string | null) {
  const c = connections.get(connectionId);
  if (c) c.cwd = cwd;
},
```

`listForUser` mapea `cwd`. `setWorkspace` **no** borra `cwd` salvo `workspaceId === null` (unbind → `cwd = null`).

- [ ] Test hub: `add` + `setCwd` + `listForUser` incluye `cwd`. Unbind (`setWorkspace(id, null, null)` + `setCwd(id, null)`) deja `cwd: null`.

- [ ] En `api/src/ws/handlers.ts`:

  1. `const worktreePending = createPendingMap(WORKTREE_ADD_TIMEOUT_MS);` a nivel de módulo (60s cubre add; list/select contestan antes).
  2. En `workspace.bind`, después de `setWorkspace` / `setClientKind`: si `typeof msg.cwd === "string" && msg.cwd.trim()`, `hub.setCwd(connectionId, msg.cwd.trim())`; si no, `hub.setCwd(connectionId, path)` para daemons y `null` para clients. Incluir `cwd` y `hostname` en el `data` de la respuesta.
  3. Helper `forwardWorktree(connectionId, userId, type, id, action, payload)`:

```ts
async function forwardWorktree(
  connectionId: string,
  userId: string,
  type: string,
  id: string,
  action: "list" | "add" | "select",
  payload: Record<string, unknown>,
): Promise<ServerMessage> {
  const conn = hub.get(connectionId);
  const workspaceId = conn?.workspaceId;
  if (!workspaceId) {
    return fail(type, id, "Workspace not bound. Send workspace.bind first.");
  }
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.worktree.dispatch", {
      requestId: id,
      action,
      path: daemon.path,
      payload,
    }),
  );
  if (!sent) return fail(type, id, NO_DAEMON_ERROR);
  const reply = await worktreePending.wait(id, type);
  return reply;
}
```

  4. Cases:

```ts
case "workspace.worktree.list":
  return forwardWorktree(connectionId, userId, type, id, "list", {});

case "workspace.worktree.add": {
  const branch = (msg.branch || (msg.metadata as { branch?: string } | undefined)?.branch || "").trim();
  if (!branch) return fail(type, id, "branch is required");
  return forwardWorktree(connectionId, userId, type, id, "add", {
    branch,
    path: msg.path,
    createBranch: Boolean((msg.metadata as { createBranch?: boolean } | undefined)?.createBranch ?? true),
    startPoint: (msg.metadata as { startPoint?: string } | undefined)?.startPoint,
  });
}

case "workspace.worktree.select":
  return forwardWorktree(connectionId, userId, type, id, "select", {
    path: msg.path,
    branch: msg.branch,
  });

case "workspace.worktree.result": {
  const requestId = msg.requestId || id;
  const meta = (msg.metadata || {}) as {
    ok?: boolean;
    error?: string;
    snapshot?: {
      cwd?: string;
      bindPath?: string;
      hostname?: string;
      isRepo?: boolean;
    };
  };
  const conn = hub.get(connectionId);
  if (meta.ok && meta.snapshot?.cwd && conn) {
    hub.setCwd(connectionId, meta.snapshot.cwd);
    if (conn.workspaceId) {
      broadcast(userId, "workspace.cwd.changed", {
        workspaceId: conn.workspaceId,
        hostname: meta.snapshot.hostname || conn.hostname || null,
        cwd: meta.snapshot.cwd,
        bindPath: meta.snapshot.bindPath || conn.path,
        snapshot: meta.snapshot,
      });
    }
  }
  const reply = meta.ok
    ? ok("workspace.worktree.result", requestId, meta.snapshot)
    : fail(
        "workspace.worktree.result",
        requestId,
        meta.error || "worktree rpc failed",
      );
  if (!worktreePending.complete(requestId, reply)) {
    return fail(type, id, "No pending worktree request");
  }
  return ok(type, id, { forwarded: true });
}
```

El cliente original espera el tipo que pidió (`workspace.worktree.list` etc.). `createPendingMap.wait(id, type)` usa `type` del caller; `complete` resuelve con `reply`. Para que el cliente reciba `ok` del **mismo** type, `complete` debe pasar `ok(typeDelCaller, requestId, snapshot)`. Como el daemon no conoce el type original, guardar `{ resolve, timer, type }` **o** completar siempre con `ok(type, id, data)` donde `type` sea el del pending. Extender `createPendingMap` **solo si** el mapa actual no guarda `type`: el `wait(id, type)` ya lo recibe — al `complete`, ignorar `msg.type` y devolver `{ ...msg, type: pendingType }`. Si eso implica tocar `pending.ts` compartido, **no** cambies el timeout string; añade un campo `type` en `PendingReply` al hacer `wait`, y en `complete` sobreescribe `msg.type` con ese `type`. Tests de pending existentes deben seguir pasando.

Implementación mínima sin cambiar la firma pública: en `forwardWorktree`, tras `wait`, si `reply.ok` devolver `ok(type, id, reply.data)` y si no `fail(type, id, reply.error || NO_DAEMON_ERROR)`.

  5. `agent.turn.request` **sigue** enviando `path: workspace?.path || daemon.path` (identidad). El daemon lo ignora para ejecución (Task 3). Opcional: añadir `cwd: daemon.cwd || daemon.path` en el dispatch **informativo**; el runner usa `getEffectiveCwd()` igual.

- [ ] Test de texto `api/src/ws/handlers-worktree.test.ts` (sin Postgres): el source de `handlers.ts` **no** contiene `git worktree`, `child_process`, `runGit(`, `readdirSync`. Sí contiene `workspace.worktree.dispatch` y `NO_DAEMON_ERROR`.

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

describe("worktree handlers stay off-disk", () => {
  test("no git spawn on API", () => {
    expect(src).not.toContain("git worktree");
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("runGit(");
    expect(src).not.toContain("readdirSync");
  });
  test("forwards to daemon", () => {
    expect(src).toContain("workspace.worktree.dispatch");
    expect(src).toContain("workspace.cwd.changed");
    expect(src).toContain("NO_DAEMON_ERROR");
  });
});
```

- [ ] Correr:

```bash
cd api && bun test src/ws/pending.test.ts src/ws/hub.test.ts \
  src/ws/handlers-worktree.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/worktree-constants.ts api/src/ws/pending.ts \
  api/src/ws/pending.test.ts api/src/ws/protocol.ts api/src/ws/hub.ts \
  api/src/ws/hub.test.ts api/src/ws/handlers.ts api/src/ws/errors.ts \
  api/src/ws/handlers-worktree.test.ts api/package.json
git commit -m "feat(worktree): API forwards worktree RPC and broadcasts cwd"
```

---

## Task 5: CLI `headless worktree` + watch + TUI comparte handler

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (crear si el plan 2 no lo creó)
- Test: `cli/src/llm/watch-format.test.ts` (crear o extender)
- Modify: `tui/src/App.tsx` (handlers daemon; picker es Task 6)

- [ ] En `cli/src/index.ts` `usage()`: añadir línea `chavez headless worktree list|add|select|status`.

- [ ] En `cli/src/commands/headless.ts`, grupo `worktree` (después de `workspace`, antes de `session`):

```
chavez headless worktree list
chavez headless worktree status
chavez headless worktree select <path-or-branch>
chavez headless worktree add <branch> [--path <abs>] [--no-create-branch]
```

`status` y `list` llaman `workspace.worktree.list` (timeout `WORKTREE_RPC_TIMEOUT_MS`). `add` timeout `WORKTREE_ADD_TIMEOUT_MS`. `select`: si el arg empieza por `/` o `.` se manda `{ path }`; si es `@main` se manda `{ path: "@main" }`; si no `{ branch }`. Imprime JSON del snapshot (`cwd`, `bindPath`, `hostname`, `worktrees[].path/branch/isMain`). Si `!ok`, `throw new Error(res.error)`. Uso de `ensureClient()`.

`workspace status` existente: añadir líneas `cwd: ${st.cwd || path}` si el state tiene `cwd`.

- [ ] Extender `cli/src/llm/watch-format.ts`. Si el archivo no existe (plan 2 no aterrizó), crear:

```ts
export function formatWatchLine(msg: {
  type: string;
  data?: unknown;
}): string | null {
  const data = (msg.data || {}) as Record<string, unknown>;
  if (msg.type === "workspace.cwd.changed") {
    return formatWatchCwdLine({
      hostname: typeof data.hostname === "string" ? data.hostname : undefined,
      cwd: typeof data.cwd === "string" ? data.cwd : undefined,
      current: (data.snapshot as { current?: { branch?: string | null; isMain?: boolean } } | undefined)?.current,
    });
  }
  return null;
}
```

Si ya existe, añadir el `if` de `workspace.cwd.changed` y **no** volcar el array entero de worktrees (una línea). Importar `formatWatchCwdLine` desde `worktree-parse.ts`.

En `cli/src/commands/headless.ts` `chat watch`, si `formatWatchLine` existe, imprimir esa línea **además** del JSON crudo **o** en lugar del JSON si el plan 2 ya compactó. No duplicar un dump de 50 worktrees.

- [ ] Test: `formatWatchLine({ type: "workspace.cwd.changed", data: { hostname: "host-a", cwd: "/wt", snapshot: { current: { branch: "feat", isMain: false } } } })` contiene `host-a`, `/wt`, `feat`. No contiene un PAT.

- [ ] En `tui/src/App.tsx` `onPush`, **antes** del handle de `agent.turn.dispatch`, el mismo bloque `workspace.worktree.dispatch` que en `daemon.ts` (importar `handleWorktreeRpc`). Usar `turnBusyRef.current` como `turnBusy`. Tras ok, `setEffectiveCwd(snapshot.cwd)` ya ocurrió dentro de `selectWorktree`; guardar `setCwdLabel(snapshot.cwd)` para el header (Task 6). `publishAgentTurn` local y remoto: `cwd: getEffectiveCwd() || cwd` — **no** `data.path || cwd`.

Tras bind, `initEffectiveCwd(cwd.replace(/\\/g, "/"))` en el `useEffect` de conexión (el `cwd` de env es el bind).

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts src/llm/handle-worktree-rpc.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  tui/src/App.tsx
git commit -m "feat(worktree): headless worktree CLI, watch cwd, TUI daemon RPC"
```

---

## Task 6: TUI — tecla `w`, header `hostname · cwd`, disabled sin git

**Files:**

- Modify: `tui/src/App.tsx`

TUI es daemon: lista/add/select en proceso (`collectWorktreeSnapshot` / `addWorktree` / `selectWorktree`) **y** pinta. También aplica RPC de Web. No importa API para git spawn.

- [ ] State nuevo:

```ts
type WorktreePanel = {
  open: boolean;
  snapshot: WorktreeSnapshot | null;
  error: string | null;
  creating: boolean;
  newBranch: string;
};
```

`const [wtPanel, setWtPanel] = useState<WorktreePanel>({ open: false, snapshot: null, error: null, creating: false, newBranch: "" });`
`const [effectiveCwdLabel, setEffectiveCwdLabel] = useState(cwd);`

- [ ] `refreshWorktrees` llama `collectWorktreeSnapshot(getBindPath() || cwd)` directo. Si `!isRepo`, `error = WORKTREE_NO_GIT_UI` (el string de UI en español).

- [ ] En `onPush` existente: `workspace.cwd.changed` → `setEffectiveCwdLabel(data.cwd)` + `setWtPanel` snapshot si el panel está abierto.

- [ ] Header: reemplazar `<Text>cwd: {cwd}</Text>` por:

```tsx
<Text>
  cwd: {effectiveCwdLabel}
  {wtPanel.snapshot && !wtPanel.snapshot.current?.isMain
    ? ` · ${WEB_WORKTREE_BADGE} ${wtPanel.snapshot.current?.branch || "detached"}`
    : ""}
</Text>
```

Al bound, una vez: `void refreshWorktrees()`.

- [ ] Tecla `w` (command mode, no compose): abre panel, `refreshWorktrees`. Si `!isRepo`, log `WORKTREE_NO_GIT_UI` y **no** permite add/select.
  - Panel abierto: `↑↓` mueve cursor sobre `snapshot.worktrees`, `Enter` → `selectWorktree({ path: entry.path })` luego `writeWorkspaceState` no aplica (TUI no escribe el hash salvo que ya lo haga el bind). Tras select, `setEffectiveCwdLabel(getEffectiveCwd())`, log `formatDaemonCwdLabel(hostname(), getEffectiveCwd())`, cierra panel.
  - `n` entra a `creating`: el compose buffer `newBranch`; Enter → `addWorktree({ branch, createBranch: true })`. Escape cierra panel **sin** `exit()` de la TUI (hoy Escape mata la app en command; **solo** si `wtPanel.open`, Escape cierra el panel y `return` antes del `exit()`).
  - Si `busy` / `turnBusyRef`: Enter/`n` log `TURN_BUSY_ERROR` y no muta.

- [ ] Hint line: añadir ` [w] worktree` a la línea de teclas. Si panel open, sustituir por `TUI_WORKTREE_HINT`.

- [ ] `sendWithLlm` ya usa `getEffectiveCwd()` (Task 5). Verificar dependencias del `useCallback`: quitar el bind `cwd` como cwd de ejecución.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(worktree): TUI picker, header hostname cwd, no-git disabled"
```

---

## Task 7: Web — `hostname · path` del worktree, elegir/crear, sin git deshabilitado

**Files:**

- Create: `web/src/lib/worktree-constants.ts`
- Create: `web/src/components/WorktreeBar.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/WorkspacesPanel.tsx`
- Modify: `web/src/styles/global.css`

Web **no** importa CLI. Cero `<input type="file">`. Cero `fs` del browser.

- [ ] Crear `web/src/lib/worktree-constants.ts` (keep-in-sync comentario) con `WORKTREE_NO_GIT_UI`, `WEB_CWD_SEP`, `WEB_WORKTREE_BADGE`, `WORKTREE_MAIN_TOKEN`, `NO_DAEMON_ERROR` (mismo string).

- [ ] Extender `Connection` en `web/src/lib/hooks.ts`:

```ts
export type Connection = {
  connectionId?: string;
  id?: string;
  workspaceId?: string | null;
  path?: string | null;
  cwd?: string | null;
  hostname?: string | null;
  clientKind?: "client" | "daemon";
  connectedAt?: string;
};
```

- [ ] Extender `WsRequest` en `web/src/lib/ws-client.ts` con `cwd?: string`, `branch?: string`, `requestId?: string`, `action?: string`.

- [ ] En `web/src/lib/ws-hooks.ts`:

```ts
export function useWsWorktreeList() {
  const ws = useWs();
  return useMutation({
    mutationFn: () => ws.request({ type: "workspace.worktree.list" }, 15_000),
  });
}

export function useWsWorktreeSelect() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { path?: string; branch?: string }) =>
      ws.request({
        type: "workspace.worktree.select",
        path: input.path,
        branch: input.branch,
      }),
  });
}

export function useWsWorktreeAdd() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { branch: string; path?: string; createBranch?: boolean }) =>
      ws.request(
        {
          type: "workspace.worktree.add",
          branch: input.branch,
          path: input.path,
          metadata: { createBranch: input.createBranch ?? true },
        },
        60_000,
      ),
  });
}
```

- [ ] Crear `web/src/components/WorktreeBar.tsx`:

Props: `{ workspaceId?: string }`. Lee `useConnections` + `useWs`. Daemon del workspace: `connections.find(c => c.clientKind === "daemon" && (!workspaceId || c.workspaceId === workspaceId))`.

Label: `format = \`${daemon.hostname || "daemon"}${WEB_CWD_SEP}${daemon.cwd || daemon.path || ""}\``.

Comportamiento:

1. Sin daemon: texto muted `"No hay filesystem: arranca el daemon en este workspace (\`chavez headless workspace open\` o \`chavez tui\`)."`. **No** llama list. **No** muestra el path del proceso API.
2. Con daemon: al montar, `worktree.list`. Header siempre `hostname · cwd`.
3. `snapshot.isRepo === false`: `<p className="muted">{WORKTREE_NO_GIT_UI}</p>`. Select/add **disabled**.
4. `isRepo`: `<select>` de `worktrees` (label `branch || "detached"` + path corto). Change → `select({ path })`. Botón "Main" → `select({ path: "@main" })`.
5. Form crear: input branch + optional path + submit "Crear worktree" → `add({ branch, path, createBranch: true })`.
6. Badge `worktree` si `current && !current.isMain`.
7. `useEffect` `ws.onPush`: `workspace.cwd.changed` con el mismo `workspaceId` actualiza label y snapshot local; invalida `queryKeys.connections`.
8. Error `TURN_BUSY_ERROR` / `NO_DAEMON_ERROR` / `WORKTREE_REQUIRES_GIT` se pintan en `.error`. **Nunca** `workspace.bind` con el path del worktree.

- [ ] Montar `<WorktreeBar />` arriba del compositor en `ChatDetailPanel.tsx` y en el panel principal de `WorkspaceDetailPanel.tsx` (pasar `workspaceId` ahí). En `WorkspacesPanel.tsx`, junto a cada `w.path`, si hay daemon de ese id: `hostname · (cwd || path)` en muted.

- [ ] Si `web/src/components/FileTreePanel.tsx` existe (plan 18), el header que hoy muestra hostname · path debe usar `cwd` del snapshot/`connections` (effective), no el bind. **No** subir `FS_COMPLETE_LIMIT`.

- [ ] CSS mínimo en `web/src/styles/global.css`:

```css
.worktree-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.75rem;
}
.worktree-bar code {
  overflow-wrap: anywhere;
}
```

Viewport ~375px: el `hostname · path` wrapea. `.shell` max-width 960px intacto.

- [ ] Commit:

```bash
git add web/src/lib/worktree-constants.ts web/src/components/WorktreeBar.tsx \
  web/src/lib/hooks.ts web/src/lib/ws-client.ts web/src/lib/ws-hooks.ts \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/WorkspacesPanel.tsx web/src/styles/global.css
git commit -m "feat(worktree): Web bar shows hostname cwd, select and create"
```

---

## Task 8: OpenAPI + smokes Gherkin (elegir, un writer, sin git)

**Files:**

- Modify: `api/openapi/openapi.yaml`
- Create: `cli/scripts/worktree-cwd-smoke.ts`
- Modify: `cli/package.json` (script `"test:worktree-smoke": "bun run scripts/worktree-cwd-smoke.ts"`)

Sin LLM vivo. Sin GitHub. Un repo tmp basta.

- [ ] En `api/openapi/openapi.yaml`:

  1. Schema `ConnectionPublic`: añadir `cwd` (string, nullable, path efectivo del daemon), `hostname` (string, nullable), `clientKind` (si aún no está).
  2. `WsClientWorkspaceBind`: `cwd` opcional (daemon restore), `hostname` opcional.
  3. Descripción `/ws` **Tipos implementados**: añadir `workspace.worktree.list|add|select` (correlacionados), `workspace.worktree.dispatch` (API→daemon), `workspace.worktree.result` (daemon→API), push `workspace.cwd.changed`.
  4. Schemas:

```yaml
    WsClientWorktreeList:
      allOf:
        - $ref: "#/components/schemas/ClientMessage"
        - type: object
          required: [type, id]
          properties:
            type:
              type: string
              enum: [workspace.worktree.list]
    WsClientWorktreeAdd:
      allOf:
        - $ref: "#/components/schemas/ClientMessage"
        - type: object
          required: [type, id, branch]
          properties:
            type:
              type: string
              enum: [workspace.worktree.add]
            branch:
              type: string
            path:
              type: string
              description: Absoluto del checkout nuevo; default sibling basename-branch
    WsClientWorktreeSelect:
      allOf:
        - $ref: "#/components/schemas/ClientMessage"
        - type: object
          required: [type, id]
          properties:
            type:
              type: string
              enum: [workspace.worktree.select]
            path:
              type: string
              description: Absoluto del worktree o @main
            branch:
              type: string
```

  5. Ejemplo de `workspace.cwd.changed` data: `{ workspaceId, hostname, cwd, bindPath, snapshot }`. Dejar claro que `bindPath` es `workspaces.path` y `cwd` es el worktree.

- [ ] `cli/scripts/worktree-cwd-smoke.ts` (assert + `process.exit(1)`):

  1. **Elegir worktree.** `git init` + commit. `initEffectiveCwd(main)`. `addWorktree({ branch: "feat", createBranch: true })`. `getEffectiveCwd()` es el sibling. Escribir `src/a.txt` en el cwd efectivo. `existsSync(join(main, "src/a.txt")) === false`. `collectWorktreeSnapshot().current?.branch === "feat"`. `formatDaemonCwdLabel("host-a", getEffectiveCwd())` contiene el path del worktree y ` · `.
  2. **@ / tools / diffs operan ahí.** Importar `resolveInsideCwd` si existe (`cli/src/llm/workspace-path.ts`); resolver `src/a.txt` con `cwd = getEffectiveCwd()` **ok**. Resolver el mismo relativo con `cwd = main` → missing o escape. Si `workspace-path.ts` no existe, `readFileSync(join(getEffectiveCwd(), "src/a.txt"))` ok y `existsSync(join(main, "src/a.txt"))` false. Comentario: `publishAgentTurn` / `TurnDiffCollector` / `fs.complete` reciben este cwd (Tasks 3 y 5).
  3. **Web label.** `formatWatchCwdLine({ hostname: "host-a", cwd: getEffectiveCwd(), current: { branch: "feat", isMain: false } })` match `/host-a · /` y `worktree feat`.
  4. **No hay dos turns a la vez.** Segundo worktree `addWorktree({ branch: "other", createBranch: true })`. `handleWorktreeRpc({ action: "select", turnBusy: true, … })` → `error === TURN_BUSY_ERROR` y `getEffectiveCwd()` **no** cambia a `other`. `handleWorktreeRpc({ action: "list", turnBusy: true })` ok. Comentario: el segundo `agent.turn.request` lo rechaza `TURN_BUSY_ERROR` o lo encola el plan 29; **esta fase no spawnea un segundo `query()`**. Tras `turnBusy: false`, `select` a `other` ok.
  5. **Sin git.** tmp dir limpio. `collectWorktreeSnapshot` → `WORKTREE_REQUIRES_GIT`, `cwd === bindPath`. `addWorktree` throw. Ningún directorio `*-feat` creado junto al tmp.
  6. **process.chdir no.** `process.cwd()` igual al inicio y al final del script.
  7. **State file.** `writeWorkspaceState({ path: main, pid: process.pid, openedAt: new Date().toISOString(), cwd: getEffectiveCwd() })`. `readWorkspaceState(main)?.cwd === getEffectiveCwd()`. El filename hash es el del **main**, no el del worktree.

Al final, `git worktree remove --force` de los siblings si `runGit` está; si falla, el tmp se borra con `rmSync(tmp, { recursive: true, force: true })` en `finally`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/worktree-parse.test.ts src/llm/worktree.test.ts \
  src/llm/effective-cwd.test.ts src/llm/handle-worktree-rpc.test.ts \
  src/llm/watch-format.test.ts
cd cli && bun run scripts/worktree-cwd-smoke.ts
cd api && bun test src/ws/handlers-worktree.test.ts src/ws/hub.test.ts
```

Esperado: exit 0.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml cli/scripts/worktree-cwd-smoke.ts \
  cli/package.json
git commit -m "test(worktree): gherkin smokes for cwd switch, single writer, no-git"
```

---

## Orden de implementación y riesgos

1. Task 1 (puro) se mergea sin daemon. Task 2 necesita `git` en el runner de tests.
2. Task 3 es el corte de corrección: si el daemon sigue haciendo `cwd: data.path || path`, Web puede pintar el worktree y el LLM escribe en main.
3. Task 4 no toca Postgres. Un restart de API pierde `hub.cwd` hasta el siguiente bind/list; el daemon restaura desde el state file y reenvía `cwd` en bind (plan 17 reclaim).
4. Si plan 12/7 no aterrizó, crear `git-exec`/`git-detect` aquí con la misma firma; ellos reutilizan.
5. Si plan 29 no aterrizó, el segundo turn sigue en `TURN_BUSY_ERROR` / ignore local. **No** implementar FIFO aquí.
6. Si plan 1/18 ya muestran `hostname · path`, el path debe pasar a ser `connections.cwd`. El límite del picker `@` sigue en 10.
7. Riesgo: worktree sibling fuera del bind → sandbox. Todos los callers de `resolveInsideCwd` / `query({ cwd })` / `loadIgnore` en el daemon deben usar `getEffectiveCwd()`. Audit al cablear Task 3: `daemon.ts`, `tui/src/App.tsx`, `handle-git-rpc.ts`, `fs-complete.ts`, `fs-tree.ts`, `git-checkpoint.ts`, collector de diffs. Si el archivo no existe aún, el sibling que lo cree toma `cwd` del turn; documentar en comentario `// cwd = getEffectiveCwd()`.
8. Riesgo: `git worktree add` sin `-b` exige que la branch exista. El form Web y CLI default `createBranch: true`.
9. Riesgo: TUI Escape. El panel `w` debe tragarse Escape; si no, se mata el daemon y Web queda sin runner.
10. Riesgo: bind Web al path del worktree crearía **otro** workspace (`unique userId+path`). El WorktreeBar no llama bind. No auto-fusionar binds hechos a mano.

Gherkin cubierto:

| Escenario | Tasks |
|---|---|
| Elegir/crear worktree → daemon cwd = ese path | 2, 3, 5, 6, 7 |
| `@`, tools y diffs operan ahí | 3, 8.2 (sandbox root = effectiveCwd) |
| Web muestra hostname · path del worktree | 4 broadcast, 7 WorktreeBar, 8.3 |
| Dos worktrees ≠ dos turns; segundo encola o espera; un writer | 3 busy, 4 no segundo daemon, 8.4 |
| Sin git: worktree no aplica; cwd del workspace | 2.1, 6/7 disabled, 8.5 |
