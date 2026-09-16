# Diffs review Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, git commit/push/PR (plan 7), undo (plan 12), timeout/lote de aprobaciones (plan 13), cola de turns (plan 29), sandbox de red (plan 26), ni redacción de `.env` (plan 8). Spec: [`plan.md`](./plan.md). Depende del contrato de tools ([`agent-tools`](../agent-tools/implementation.md)) y de modos ([`execution-modes`](../execution-modes/implementation.md)): si `canUseTool` / `chat.tool.update` / `awaiting_approval` aún no existen, esta fase los añade lo mínimo para snapshotear **antes** de mutar. Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** Cada turn que mute archivos publica un **set de cambios** (path + `created|modified|deleted` + diff unificado + stat `+/-`). Web, TUI y CLI `watch` muestran el **mismo set**. En `ask` el diff es el material de aprobación (propuesto; el disco no cambia hasta approve). En `auto` el diff es post-facto. En `plan` no hay diffs de escritura ni un panel vacío. Un reload de Web reconstruye los diffs **asociados a ese `streamId`**, sin mezclarlos con el turn siguiente. Diffs enormes se truncan con marca explícita y el cuerpo completo se pide bajo demanda.

**Architecture:** El filesystem real vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). El diff se **calcula ahí** (snapshot en `canUseTool` **antes** de que el SDK toque el disco; neto al cerrar el turn). La API **no** lee el cwd: persiste filas `turn_file_diffs`, hace fan-out WS y sirve el preview en `chat.get` / GET `/chats/:id`. El body completo **no** viaja en el listado.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API hub.findDaemon
        |
        v
  publishAgentTurn + TurnDiffCollector(streamId, cwd)
        |
        |  canUseTool (ANTES de mutar):
        |    sandbox + gate(mode)
        |    ask  → proposeDiff → chat.tool.update awaiting_approval.diff
        |                         chat.diff.upsert status=proposed
        |                         waitForApproval
        |            deny  → drop proposed (no applied)
        |            allow → snapshot(path | git porcelain)
        |    auto → snapshot + allow
        |    plan → deny PLAN_MUTATION_DENIED (sin snapshot, sin diff)
        |
        |  tool_result Write/Edit → noteMutated(path)
        |  tool_result Bash       → noteBash (git porcelain vs snapshot)
        |  stream.end / finally   → finalize() neto original→final
        |                            chat.diff.upsert cada path applied
        |                            si 0 mutaciones: NO emitir set vacío
        v
  API persist turn_file_diffs (preview sí, body aparte)
  broadcast chat.diff.upsert (sin body)
        v
  Web DiffsPanel | TUI lista | CLI watch stats
  GET /chats/:id  incluye diffs[] (preview)
  GET /chats/:id/diffs/:diffId  body bajo demanda
```

Estado actual que este plan extiende (no reescribir):

- `chat_messages.metadata` jsonb ya existe. **No** hay tabla de diffs. `chat.get` (WS + HTTP) devuelve `{ chat, messages }` sin sidecar.
- `cli/src/llm/claude-runner.ts` usa `permissionMode: "bypassPermissions"` hoy. Los planes 2–3 lo pasan a `default` + `canUseTool`. El snapshot **tiene** que vivir en `canUseTool` (el `tool_start` puede llegar después de que el SDK ya escribió).
- `cli/src/llm/publish-turn.ts` emite `chat.tool.start` / `chat.tool.result`. No hay `chat.diff.*`.
- Web `ChatDetailPanel.tsx` pinta `ToolCard` (plan 2/3: `awaiting_approval` + Aprobar/Rechazar). No hay panel de diffs.
- TUI `App.tsx`: `Message = { id, role, content }` sin metadata; recarga `chat.get` entero; últimos 8 mensajes truncados.
- CLI `chat watch` vuelca JSON crudo hoy; el plan 2 lo compacta con `formatWatchLine`. Esta fase añade líneas `diff · …` y **no** vuelca el unificado salvo `--verbose`.
- Cursor `runnable: false`. No simular diffs de Cursor.
- Git commit/PR es el [plan 7](../git-workspace/plan.md). Aquí git es **sensor** de side-effects de Bash (`status --porcelain` + `diff`), no una tool de producto.
- Undo es el [plan 12](../checkpoints-undo/plan.md). Esta fase deja `streamId` + paths persistidos para que undo los consuma; no implementa revert.

**Tech Stack:** Bun, Hono + Drizzle (`turn_file_diffs`), WebSocket hub, Claude Agent SDK `query` (`canUseTool` **antes** de mutar), Ink TUI, Astro/React web. Diff unificado en proceso (sin paquete `diff`). Git CLI solo como sensor de Bash.

**Global Constraints:**

1. El filesystem se lee y el diff se calcula **solo** en el daemon (cwd del workspace). API y browser no abren archivos. Web pide preview persistido o body vía HTTP; nunca un dump del árbol.
2. Sin daemon bound, `agent.turn.request` falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. No queda un `turn_file_diffs` huérfano.
3. Un turn = un `streamId`. Los diffs se agrupan por `(chatId, streamId)`. Un reload no mezcla el set del turn N con el N+1.
4. El set es **neto** del turn: varios Write/Edit al mismo path → **una** entrada vs el snapshot original. Tres archivos tocados → tres paths.
5. Kinds **únicamente** `created` | `modified` | `deleted`. Status **únicamente** `proposed` | `applied` | `rejected`.
6. `plan` no genera diffs de escritura: las mutaciones se deniegan, no hay snapshot, no hay panel (tampoco “0 archivos”).
7. `ask`: el archivo **no** cambia hasta approve. `awaiting_approval` incluye el diff propuesto. Approve → disco cambia y el row pasa a `applied`. Deny → disco intacto y **no queda** row `applied` (el `proposed` se marca `rejected` y el listado lo omite).
8. `auto`: diffs post-facto (`applied`) al terminar cada mutación y se reconcilian al `finalize`.
9. Lecturas (read/grep/glob) no producen diffs. Un turn solo de lecturas **no** pinta sección de diffs.
10. Preview truncado **antes** de persistir el listado, de broadcast y de pintar. El body completo se pide bajo demanda. Un deleted enorme **no** almacena el blob.
11. CLI `watch` imprime path + kind + `+N −M`. El unificado **no** se vuelca salvo `--verbose` / `-v`.
12. Aprobaciones una a una (plan 3). Esta fase **añade el diff** al pedido; no inventa lote ni “siempre permitir”.
13. Claude es el provider ejecutable. Cursor vinculado no ejecuta turns aquí; cuando el plan 4 lo haga, reutiliza el mismo `chat.diff.upsert`.
14. Web, TUI y watch ven el mismo contrato: `chat.diff.upsert` sin `body`.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, commit/PR, undo, redacción `.env` (plan 8 la cubre después).

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `DIFF_KINDS` | `"created"` \| `"modified"` \| `"deleted"` |
| `DIFF_STATUSES` | `"proposed"` \| `"applied"` \| `"rejected"` |
| `DIFF_PREVIEW_MAX_LINES` | `200` |
| `DIFF_PREVIEW_MAX_CHARS` | `8000` |
| `DIFF_SNAPSHOT_MAX_BYTES` | `1048576` (1 MiB) |
| `DIFF_DELETED_PREVIEW_LINES` | `40` |
| `DIFF_DP_CELL_CAP` | `2_000_000` |
| `DIFF_TRUNCATED_MARKER` | `` `[truncated: showing ${shown} of ${total} lines]` `` |
| `DIFF_BODY_OMITTED` | `` `[omitted: file was ${bytes} bytes; full blob not stored]` `` |
| `DIFF_BINARY_MARKER` | `"[binary file]"` |
| `NO_GIT_FOR_BASH` | `"Bash mutations are not in the turn diff set (workspace is not a git repo)"` |

Nombres de events WS:

| Tipo | Dirección | Payload |
|---|---|---|
| `chat.diff.upsert` | daemon → API → broadcast | `{ chatId, streamId, diff }` **sin** `body` |
| `chat.diff.get` | cliente → API | `{ chatId, diffId }` → `{ diff }` **con** `body` o `omitted` |

HTTP:

| Método | Ruta | Devuelve |
|---|---|---|
| `GET` | `/chats/:chatId` | `{ chat, messages, diffs }` — `diffs` es preview (`status` ∈ proposed\|applied) |
| `GET` | `/chats/:chatId/diffs/:diffId` | `{ diff }` con `body` o `omitted: true` |

Row persistido (neto por path):

```ts
type TurnFileDiff = {
  id: string;
  chatId: string;
  streamId: string;
  toolCallId: string | null;
  path: string; // posix relativo al cwd
  kind: "created" | "modified" | "deleted";
  status: "proposed" | "applied" | "rejected";
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
  binary: boolean;
  byteSize: number | null;
  // body: text | null — solo columna DB / GET by id, nunca listado ni broadcast
};
```

Clases de tool (igual que planes 2–3):

- **read:** `Read`, `Grep`, `Glob`, `LS` → nunca diff.
- **write path:** `Write`, `Edit`, `NotebookEdit` → snapshot del `file_path` / `notebook_path`.
- **bash:** `Bash` → snapshot `git status --porcelain` antes; al result, paths tocados vs snapshot. Sin `.git`, Bash no aporta paths (Write/Edit sí).

---

## Task 1: Módulos puros — unified diff, truncate, kinds, propuesta Write/Edit

**Files:**

- Create: `cli/src/llm/diff-constants.ts`
- Create: `cli/src/llm/unified-diff.ts`
- Create: `cli/src/llm/proposed-edit.ts`
- Test: `cli/src/llm/unified-diff.test.ts`
- Test: `cli/src/llm/proposed-edit.test.ts`
- Modify: `cli/package.json`

Sin I/O de red. TUI importa desde `cli/src/llm/…`. Web **no** importa CLI: Task 7 duplica truncate + kinds.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/diff-constants.ts`:

```ts
export const DIFF_KINDS = ["created", "modified", "deleted"] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];

export const DIFF_STATUSES = ["proposed", "applied", "rejected"] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

export const DIFF_PREVIEW_MAX_LINES = 200;
export const DIFF_PREVIEW_MAX_CHARS = 8000;
export const DIFF_SNAPSHOT_MAX_BYTES = 1_048_576;
export const DIFF_DELETED_PREVIEW_LINES = 40;
export const DIFF_DP_CELL_CAP = 2_000_000;

export const DIFF_BINARY_MARKER = "[binary file]";
export const NO_GIT_FOR_BASH =
  "Bash mutations are not in the turn diff set (workspace is not a git repo)";

export function diffTruncatedMarker(shown: number, total: number): string {
  return `[truncated: showing ${shown} of ${total} lines]`;
}

export function diffBodyOmitted(bytes: number): string {
  return `[omitted: file was ${bytes} bytes; full blob not stored]`;
}

export function isDiffKind(v: unknown): v is DiffKind {
  return v === "created" || v === "modified" || v === "deleted";
}

export function isDiffStatus(v: unknown): v is DiffStatus {
  return v === "proposed" || v === "applied" || v === "rejected";
}

export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
```

- [ ] Crear `cli/src/llm/unified-diff.ts`:

```ts
import {
  DIFF_BINARY_MARKER,
  DIFF_DELETED_PREVIEW_LINES,
  DIFF_DP_CELL_CAP,
  DIFF_PREVIEW_MAX_CHARS,
  DIFF_PREVIEW_MAX_LINES,
  DIFF_SNAPSHOT_MAX_BYTES,
  type DiffKind,
  diffBodyOmitted,
  diffTruncatedMarker,
  toPosixRel,
} from "./diff-constants";

export type Snapshot = {
  existed: boolean;
  text: string | null;
  binary: boolean;
  tooBig: boolean;
  byteSize: number;
};

export type ComputedDiff = {
  path: string;
  kind: DiffKind;
  additions: number;
  deletions: number;
  preview: string;
  body: string | null;
  truncated: boolean;
  binary: boolean;
  byteSize: number;
  omitted: boolean;
};

function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function isBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Prefix/suffix LCS with DP only when a.length * b.length <= DIFF_DP_CELL_CAP. */
export function diffLines(a: string[], b: string[]): Array<{ type: "eq" | "del" | "add"; line: string }> {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let as = a.length;
  let bs = b.length;
  while (as > pre && bs > pre && a[as - 1] === b[bs - 1]) {
    as -= 1;
    bs -= 1;
  }
  const aa = a.slice(pre, as);
  const bb = b.slice(pre, bs);
  const out: Array<{ type: "eq" | "del" | "add"; line: string }> = [];
  for (let i = 0; i < pre; i++) out.push({ type: "eq", line: a[i]! });

  if (aa.length * bb.length > DIFF_DP_CELL_CAP) {
    for (const line of aa) out.push({ type: "del", line });
    for (const line of bb) out.push({ type: "add", line });
  } else if (aa.length === 0) {
    for (const line of bb) out.push({ type: "add", line });
  } else if (bb.length === 0) {
    for (const line of aa) out.push({ type: "del", line });
  } else {
    const n = aa.length;
    const m = bb.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] =
          aa[i] === bb[j]
            ? (dp[i + 1]![j + 1]! + 1)
            : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (aa[i] === bb[j]) {
        out.push({ type: "eq", line: aa[i]! });
        i += 1;
        j += 1;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        out.push({ type: "del", line: aa[i]! });
        i += 1;
      } else {
        out.push({ type: "add", line: bb[j]! });
        j += 1;
      }
    }
    while (i < n) {
      out.push({ type: "del", line: aa[i]! });
      i += 1;
    }
    while (j < m) {
      out.push({ type: "add", line: bb[j]! });
      j += 1;
    }
  }

  for (let i = as; i < a.length; i++) out.push({ type: "eq", line: a[i]! });
  return out;
}

function hunkify(
  ops: Array<{ type: "eq" | "del" | "add"; line: string }>,
  path: string,
): { text: string; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "add") additions += 1;
    if (op.type === "del") deletions += 1;
  }
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  // Single hunk covering the file (agent edits are typically small).
  const oldCount = ops.filter((o) => o.type !== "add").length;
  const newCount = ops.filter((o) => o.type !== "del").length;
  lines.push(`@@ -1,${oldCount} +1,${newCount} @@`);
  for (const op of ops) {
    if (op.type === "eq") lines.push(` ${op.line}`);
    else if (op.type === "del") lines.push(`-${op.line}`);
    else lines.push(`+${op.line}`);
  }
  return { text: lines.join("\n") + "\n", additions, deletions };
}

export function truncateUnified(
  text: string,
  maxLines = DIFF_PREVIEW_MAX_LINES,
  maxChars = DIFF_PREVIEW_MAX_CHARS,
): { preview: string; truncated: boolean; shownLines: number; totalLines: number } {
  const raw = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const totalLines = raw.length;
  let slice = raw;
  let truncated = false;
  if (slice.length > maxLines) {
    slice = slice.slice(0, maxLines);
    truncated = true;
  }
  let preview = slice.join("\n");
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    preview = `${preview}\n${diffTruncatedMarker(slice.length, totalLines)}`;
  }
  return { preview, truncated, shownLines: slice.length, totalLines };
}

export function kindFromSnapshots(before: Snapshot, afterExisted: boolean, afterEmpty: boolean): DiffKind {
  if (!before.existed && afterExisted) return "created";
  if (before.existed && !afterExisted) return "deleted";
  if (before.existed && afterExisted && afterEmpty && (before.text || "") !== "") {
    // write that emptied the file still counts as modified, not deleted
    return "modified";
  }
  return "modified";
}

export function computeUnifiedDiff(input: {
  path: string;
  before: Snapshot;
  after: Snapshot;
}): ComputedDiff {
  const path = toPosixRel(input.path);
  const kind = kindFromSnapshots(
    input.before,
    input.after.existed,
    !input.after.binary && (input.after.text || "") === "",
  );

  if (input.before.binary || input.after.binary) {
    const byteSize = Math.max(input.before.byteSize, input.after.byteSize);
    const header = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      DIFF_BINARY_MARKER,
    ].join("\n");
    return {
      path,
      kind,
      additions: 0,
      deletions: 0,
      preview: header,
      body: header,
      truncated: false,
      binary: true,
      byteSize,
      omitted: false,
    };
  }

  if (kind === "deleted" && (input.before.tooBig || input.before.byteSize > DIFF_SNAPSHOT_MAX_BYTES)) {
    const oldLines = splitLines(input.before.text || "");
    const shown = oldLines.slice(0, DIFF_DELETED_PREVIEW_LINES);
    const header = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ /dev/null`,
      `@@ -1,${oldLines.length} +0,0 @@`,
      ...shown.map((l) => `-${l}`),
      diffBodyOmitted(input.before.byteSize),
    ].join("\n");
    return {
      path,
      kind: "deleted",
      additions: 0,
      deletions: oldLines.length || 1,
      preview: header,
      body: null,
      truncated: true,
      binary: false,
      byteSize: input.before.byteSize,
      omitted: true,
    };
  }

  const oldText = kind === "created" ? "" : input.before.text || "";
  const newText = kind === "deleted" ? "" : input.after.text || "";
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);
  const hunk = hunkify(ops, path);
  const cap = truncateUnified(hunk.text);
  const tooBig =
    input.before.tooBig ||
    input.after.tooBig ||
    input.before.byteSize > DIFF_SNAPSHOT_MAX_BYTES ||
    input.after.byteSize > DIFF_SNAPSHOT_MAX_BYTES;
  return {
    path,
    kind,
    additions: hunk.additions,
    deletions: hunk.deletions,
    preview: cap.preview,
    body: tooBig ? null : hunk.text,
    truncated: cap.truncated || tooBig,
    binary: false,
    byteSize: Math.max(input.before.byteSize, input.after.byteSize),
    omitted: tooBig,
  };
}

export function emptySnapshot(): Snapshot {
  return { existed: false, text: "", binary: false, tooBig: false, byteSize: 0 };
}

export function textSnapshot(text: string): Snapshot {
  const byteSize = Buffer.byteLength(text, "utf8");
  const tooBig = byteSize > DIFF_SNAPSHOT_MAX_BYTES;
  return {
    existed: true,
    text: tooBig ? text.slice(0, DIFF_SNAPSHOT_MAX_BYTES) : text,
    binary: false,
    tooBig,
    byteSize,
  };
}
```

- [ ] Crear `cli/src/llm/proposed-edit.ts`:

```ts
import { emptySnapshot, textSnapshot, type Snapshot } from "./unified-diff";

export function toolPathFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  for (const k of ["file_path", "notebook_path", "path"] as const) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function writeContentsFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  if (typeof input.content === "string") return input.content;
  if (typeof input.contents === "string") return input.contents;
  return null;
}

/**
 * Proposed after-image for Write / Edit / NotebookEdit.
 * Edit: first occurrence of old_string → new_string (paridad Claude Edit).
 * Write: contents. Created if before.existed === false.
 */
export function proposedAfterSnapshot(
  sdkName: string,
  input: Record<string, unknown> | null,
  before: Snapshot,
): Snapshot | null {
  const name = sdkName;
  if (name === "Write") {
    const content = writeContentsFromInput(input);
    if (content == null) return null;
    return textSnapshot(content);
  }
  if (name === "Edit" || name === "NotebookEdit") {
    const oldS = typeof input?.old_string === "string" ? input.old_string : null;
    const newS = typeof input?.new_string === "string" ? input.new_string : null;
    if (oldS == null || newS == null) return null;
    const src = before.text ?? "";
    const idx = src.indexOf(oldS);
    if (idx < 0) return null;
    const next = src.slice(0, idx) + newS + src.slice(idx + oldS.length);
    return textSnapshot(next);
  }
  return null;
}

export { emptySnapshot };
```

- [ ] Crear `cli/src/llm/unified-diff.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DIFF_PREVIEW_MAX_LINES,
  DIFF_SNAPSHOT_MAX_BYTES,
  diffTruncatedMarker,
} from "./diff-constants";
import {
  computeUnifiedDiff,
  diffLines,
  emptySnapshot,
  textSnapshot,
  truncateUnified,
} from "./unified-diff";

describe("diffLines", () => {
  test("insert", () => {
    const ops = diffLines(["a"], ["a", "b"]);
    expect(ops.filter((o) => o.type === "add").map((o) => o.line)).toEqual(["b"]);
  });
  test("delete", () => {
    const ops = diffLines(["a", "b"], ["a"]);
    expect(ops.filter((o) => o.type === "del").map((o) => o.line)).toEqual(["b"]);
  });
});

describe("computeUnifiedDiff", () => {
  test("created shows new content, kind created", () => {
    const d = computeUnifiedDiff({
      path: "src/new.ts",
      before: emptySnapshot(),
      after: textSnapshot("hello\nworld\n"),
    });
    expect(d.kind).toBe("created");
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(0);
    expect(d.preview).toContain("+hello");
    expect(d.preview).toContain("+world");
    expect(d.preview).toContain("+++ b/src/new.ts");
  });

  test("modified unified", () => {
    const d = computeUnifiedDiff({
      path: "a.ts",
      before: textSnapshot("one\ntwo\n"),
      after: textSnapshot("one\nTHREE\n"),
    });
    expect(d.kind).toBe("modified");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.preview).toContain("-two");
    expect(d.preview).toContain("+THREE");
  });

  test("deleted does not require huge blob", () => {
    const huge = "x".repeat(DIFF_SNAPSHOT_MAX_BYTES + 50);
    const d = computeUnifiedDiff({
      path: "gone.bin.txt",
      before: {
        existed: true,
        text: huge.slice(0, 100),
        binary: false,
        tooBig: true,
        byteSize: huge.length,
      },
      after: emptySnapshot(),
    });
    expect(d.kind).toBe("deleted");
    expect(d.omitted).toBe(true);
    expect(d.body).toBeNull();
    expect(d.preview).toContain("omitted: file was");
  });

  test("binary marker, no hunk dump", () => {
    const d = computeUnifiedDiff({
      path: "img.png",
      before: { existed: true, text: null, binary: true, tooBig: false, byteSize: 12 },
      after: { existed: true, text: null, binary: true, tooBig: false, byteSize: 40 },
    });
    expect(d.binary).toBe(true);
    expect(d.kind).toBe("modified");
    expect(d.preview).toContain("[binary file]");
    expect(d.additions).toBe(0);
  });
});

describe("truncateUnified", () => {
  test("marks overflow with explicit shown/total", () => {
    const lines = Array.from({ length: DIFF_PREVIEW_MAX_LINES + 20 }, (_, i) => `L${i}`);
    const { preview, truncated, totalLines } = truncateUnified(lines.join("\n") + "\n");
    expect(truncated).toBe(true);
    expect(totalLines).toBeGreaterThan(DIFF_PREVIEW_MAX_LINES);
    expect(preview).toContain(diffTruncatedMarker(DIFF_PREVIEW_MAX_LINES, totalLines));
  });
});
```

- [ ] Crear `cli/src/llm/proposed-edit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { proposedAfterSnapshot, toolPathFromInput } from "./proposed-edit";
import { emptySnapshot, textSnapshot } from "./unified-diff";

describe("toolPathFromInput", () => {
  test("file_path wins", () => {
    expect(toolPathFromInput({ file_path: "src/a.ts", path: "no" })).toBe("src/a.ts");
  });
});

describe("proposedAfterSnapshot", () => {
  test("Write creates from empty", () => {
    const after = proposedAfterSnapshot("Write", { content: "x\n" }, emptySnapshot());
    expect(after?.existed).toBe(true);
    expect(after?.text).toBe("x\n");
  });

  test("Edit replaces first occurrence", () => {
    const before = textSnapshot("foo bar foo");
    const after = proposedAfterSnapshot(
      "Edit",
      { old_string: "foo", new_string: "baz" },
      before,
    );
    expect(after?.text).toBe("baz bar foo");
  });

  test("Edit missing old_string → null", () => {
    expect(
      proposedAfterSnapshot("Edit", { old_string: "nope", new_string: "x" }, textSnapshot("abc")),
    ).toBeNull();
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/unified-diff.test.ts src/llm/proposed-edit.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/diff-constants.ts cli/src/llm/unified-diff.ts \
  cli/src/llm/proposed-edit.ts cli/src/llm/unified-diff.test.ts \
  cli/src/llm/proposed-edit.test.ts cli/package.json
git commit -m "feat(diffs): unified diff, truncation, and Write/Edit proposals"
```

---

## Task 2: API — tabla `turn_file_diffs`, upsert WS, GET preview/body, OpenAPI

**Files:**

- Create: `api/src/ws/diff-protocol.ts`
- Test: `api/src/ws/diff-protocol.test.ts`
- Modify: `api/src/db/schema.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API no calcula diffs. Sí garantiza: persistencia por `(chatId, streamId, path)`, listado **sin** `body`, rejected fuera del sidecar, GET on-demand, fan-out idéntico para Web/TUI/watch.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] En `api/src/db/schema.ts`, **después** de `chatMessages`, añadir:

```ts
export const turnFileDiffs = pgTable(
  "turn_file_diffs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    streamId: text("stream_id").notNull(),
    toolCallId: text("tool_call_id"),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    preview: text("preview").notNull().default(""),
    body: text("body"),
    truncated: boolean("truncated").notNull().default(false),
    binary: boolean("binary").notNull().default(false),
    omitted: boolean("omitted").notNull().default(false),
    byteSize: integer("byte_size"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("turn_file_diffs_chat_stream_path_uidx").on(
      table.chatId,
      table.streamId,
      table.path,
    ),
  ],
);
```

Aplicar schema (no hay carpeta `api/drizzle` hoy):

```bash
cd api && bun run db:push
```

- [ ] Crear `api/src/ws/diff-protocol.ts`:

```ts
export const DIFF_KINDS = ["created", "modified", "deleted"] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];
export const DIFF_STATUSES = ["proposed", "applied", "rejected"] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

export const DIFF_PREVIEW_MAX_LINES = 200;
export const DIFF_PREVIEW_MAX_CHARS = 8000;

export function isDiffKind(v: unknown): v is DiffKind {
  return v === "created" || v === "modified" || v === "deleted";
}
export function isDiffStatus(v: unknown): v is DiffStatus {
  return v === "proposed" || v === "applied" || v === "rejected";
}

export type DiffUpsertInput = {
  path?: unknown;
  kind?: unknown;
  status?: unknown;
  toolCallId?: unknown;
  additions?: unknown;
  deletions?: unknown;
  preview?: unknown;
  body?: unknown;
  truncated?: unknown;
  binary?: unknown;
  omitted?: unknown;
  byteSize?: unknown;
};

export type StoredDiff = {
  id: string;
  chatId: string;
  streamId: string;
  toolCallId: string | null;
  path: string;
  kind: DiffKind;
  status: DiffStatus;
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
  binary: boolean;
  omitted: boolean;
  byteSize: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toPreview(row: {
  id: string;
  chatId: string;
  streamId: string;
  toolCallId: string | null;
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
  binary: boolean;
  omitted: boolean;
  byteSize: number | null;
  createdAt: Date;
  updatedAt: Date;
}): StoredDiff {
  return {
    id: row.id,
    chatId: row.chatId,
    streamId: row.streamId,
    toolCallId: row.toolCallId,
    path: row.path,
    kind: row.kind as DiffKind,
    status: row.status as DiffStatus,
    additions: row.additions,
    deletions: row.deletions,
    preview: row.preview,
    truncated: row.truncated,
    binary: row.binary,
    omitted: row.omitted,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function parseDiffUpsert(raw: DiffUpsertInput): {
  path: string;
  kind: DiffKind;
  status: DiffStatus;
  toolCallId: string | null;
  additions: number;
  deletions: number;
  preview: string;
  body: string | null;
  truncated: boolean;
  binary: boolean;
  omitted: boolean;
  byteSize: number | null;
} | { error: string } {
  const path = typeof raw.path === "string" ? raw.path.replace(/\\/g, "/").replace(/^\.\//, "").trim() : "";
  if (!path || path.startsWith("/") || path.includes("..")) {
    return { error: "diff.path must be a relative posix path inside the workspace" };
  }
  if (!isDiffKind(raw.kind)) return { error: "diff.kind must be created, modified, or deleted" };
  if (!isDiffStatus(raw.status)) return { error: "diff.status must be proposed, applied, or rejected" };
  let preview = typeof raw.preview === "string" ? raw.preview : "";
  const truncatedFlag = Boolean(raw.truncated);
  if (preview.length > DIFF_PREVIEW_MAX_CHARS) {
    preview = preview.slice(0, DIFF_PREVIEW_MAX_CHARS) + `\n[truncated: showing preview of ${preview.length} chars]`;
  }
  const body = typeof raw.body === "string" ? raw.body : null;
  return {
    path,
    kind: raw.kind,
    status: raw.status,
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
    additions: Number.isFinite(Number(raw.additions)) ? Math.max(0, Number(raw.additions)) : 0,
    deletions: Number.isFinite(Number(raw.deletions)) ? Math.max(0, Number(raw.deletions)) : 0,
    preview,
    body: raw.omitted ? null : body,
    truncated: truncatedFlag || preview.length >= DIFF_PREVIEW_MAX_CHARS,
    binary: Boolean(raw.binary),
    omitted: Boolean(raw.omitted) || (raw.kind === "deleted" && body == null && Boolean(raw.truncated)),
    byteSize: Number.isFinite(Number(raw.byteSize)) ? Number(raw.byteSize) : null,
  };
}

export function visibleStatus(status: string): boolean {
  return status === "proposed" || status === "applied";
}
```

Los números de truncado **coinciden** con `cli/src/llm/diff-constants.ts`. No importar CLI desde API.

- [ ] Crear `api/src/ws/diff-protocol.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseDiffUpsert, visibleStatus } from "./diff-protocol";

describe("parseDiffUpsert", () => {
  test("accepts relative path", () => {
    const d = parseDiffUpsert({
      path: "src/a.ts",
      kind: "modified",
      status: "applied",
      additions: 2,
      deletions: 1,
      preview: "diff --git",
    });
    expect("error" in d).toBe(false);
    if ("error" in d) return;
    expect(d.path).toBe("src/a.ts");
    expect(d.kind).toBe("modified");
  });

  test("rejects traversal and absolute", () => {
    expect("error" in parseDiffUpsert({ path: "../etc/passwd", kind: "modified", status: "applied" })).toBe(true);
    expect("error" in parseDiffUpsert({ path: "/etc/passwd", kind: "created", status: "applied" })).toBe(true);
  });

  test("rejects bad kind/status", () => {
    expect("error" in parseDiffUpsert({ path: "a.ts", kind: "patched", status: "applied" })).toBe(true);
    expect("error" in parseDiffUpsert({ path: "a.ts", kind: "created", status: "done" })).toBe(true);
  });
});

describe("visibleStatus", () => {
  test("hides rejected from the panel", () => {
    expect(visibleStatus("applied")).toBe(true);
    expect(visibleStatus("proposed")).toBe(true);
    expect(visibleStatus("rejected")).toBe(false);
  });
});
```

- [ ] En `api/src/ws/protocol.ts`, ampliar `ClientMessage` con campos que el upsert usa (el resto sigue en `metadata`):

```ts
export type ClientMessage = {
  type: string;
  id: string;
  path?: string;
  title?: string;
  sessionId?: string;
  chatId?: string;
  role?: string;
  content?: string;
  clientKind?: "client" | "daemon";
  metadata?: Record<string, unknown>;
  streamId?: string;
  toolCallId?: string;
  toolName?: string;
  prompt?: string;
  delta?: string;
  status?: string;
  diffId?: string;
  diff?: Record<string, unknown>;
};
```

- [ ] En `api/src/ws/handlers.ts`:

  1. Importar `turnFileDiffs` desde schema, `and, eq` ya están; añadir lo que falte. Importar `parseDiffUpsert`, `toPreview`, `visibleStatus` desde `./diff-protocol`.

  2. Helper (junto a `loadChatForUser`):

```ts
async function listVisibleDiffs(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(turnFileDiffs)
    .where(
      and(eq(turnFileDiffs.chatId, chatId), eq(turnFileDiffs.userId, userId)),
    )
    .orderBy(asc(turnFileDiffs.createdAt));
  return rows.filter((r) => visibleStatus(r.status)).map(toPreview);
}
```

  3. En `chat.get`, el `ok` pasa a `{ chat, messages, diffs }`:

```ts
const diffs = await listVisibleDiffs(msg.chatId, userId);
return ok(type, id, { chat, messages, diffs });
```

  4. Nuevos cases **antes** del `default`:

```ts
case "chat.diff.upsert": {
  if (!msg.chatId || !msg.streamId) {
    return fail(type, id, "chatId and streamId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const parsed = parseDiffUpsert(
    (msg.diff as Record<string, unknown>) ||
      (msg.metadata?.diff as Record<string, unknown>) ||
      {},
  );
  if ("error" in parsed) return fail(type, id, parsed.error);
  const now = new Date();
  const existing = await db
    .select()
    .from(turnFileDiffs)
    .where(
      and(
        eq(turnFileDiffs.chatId, msg.chatId),
        eq(turnFileDiffs.streamId, msg.streamId),
        eq(turnFileDiffs.path, parsed.path),
      ),
    )
    .limit(1);
  let row;
  if (existing[0]) {
    await db
      .update(turnFileDiffs)
      .set({
        kind: parsed.kind,
        status: parsed.status,
        toolCallId: parsed.toolCallId,
        additions: parsed.additions,
        deletions: parsed.deletions,
        preview: parsed.preview,
        body: parsed.body,
        truncated: parsed.truncated,
        binary: parsed.binary,
        omitted: parsed.omitted,
        byteSize: parsed.byteSize,
        updatedAt: now,
      })
      .where(eq(turnFileDiffs.id, existing[0].id));
    row = { ...existing[0], ...parsed, streamId: msg.streamId, chatId: msg.chatId, updatedAt: now };
  } else {
    row = {
      id: crypto.randomUUID(),
      chatId: msg.chatId,
      userId,
      streamId: msg.streamId,
      toolCallId: parsed.toolCallId,
      path: parsed.path,
      kind: parsed.kind,
      status: parsed.status,
      additions: parsed.additions,
      deletions: parsed.deletions,
      preview: parsed.preview,
      body: parsed.body,
      truncated: parsed.truncated,
      binary: parsed.binary,
      omitted: parsed.omitted,
      byteSize: parsed.byteSize,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(turnFileDiffs).values(row);
  }
  const preview = toPreview(row);
  if (visibleStatus(preview.status)) {
    broadcast(userId, "chat.diff.upsert", {
      chatId: msg.chatId,
      streamId: msg.streamId,
      diff: preview,
    });
  } else {
    // rejected: tell observers to drop this path from the live set
    broadcast(userId, "chat.diff.upsert", {
      chatId: msg.chatId,
      streamId: msg.streamId,
      diff: preview,
      dropped: true,
    });
  }
  return ok(type, id, { diff: preview });
}

case "chat.diff.get": {
  const diffId = msg.diffId;
  if (!msg.chatId || !diffId) {
    return fail(type, id, "chatId and diffId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const rows = await db
    .select()
    .from(turnFileDiffs)
    .where(
      and(
        eq(turnFileDiffs.id, diffId),
        eq(turnFileDiffs.chatId, msg.chatId),
        eq(turnFileDiffs.userId, userId),
      ),
    )
    .limit(1);
  if (!rows[0]) return fail(type, id, "Diff not found");
  const preview = toPreview(rows[0]);
  return ok(type, id, {
    diff: {
      ...preview,
      body: rows[0].omitted ? null : rows[0].body ?? rows[0].preview,
      omitted: rows[0].omitted,
    },
  });
}
```

Un upsert `rejected` **sí** se guarda (auditoría) pero el sidecar de `chat.get` lo filtra. El push lleva `dropped: true` para que los clientes quiten el path del panel.

- [ ] En `api/src/routes/workspaces.ts` `createSessionChatRoutes`:

  1. Importar `turnFileDiffs`, `visibleStatus`, `toPreview`.
  2. Registrar **primero** la ruta más específica:

```ts
app.get("/chats/:chatId/diffs/:diffId", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const chatId = c.req.param("chatId");
  const diffId = c.req.param("diffId");
  const chatRows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
    .limit(1);
  if (!chatRows[0]) return c.json({ error: "Chat not found" }, 404);
  const rows = await db
    .select()
    .from(turnFileDiffs)
    .where(
      and(
        eq(turnFileDiffs.id, diffId),
        eq(turnFileDiffs.chatId, chatId),
        eq(turnFileDiffs.userId, session.user.id),
      ),
    )
    .limit(1);
  if (!rows[0]) return c.json({ error: "Diff not found" }, 404);
  const preview = toPreview(rows[0]);
  return c.json({
    diff: {
      ...preview,
      body: rows[0].omitted ? null : rows[0].body ?? rows[0].preview,
      omitted: rows[0].omitted,
    },
  });
});
```

  3. En `GET /chats/:chatId` existente, cargar diffs visibles y devolverlos:

```ts
const diffRows = await db
  .select()
  .from(turnFileDiffs)
  .where(
    and(
      eq(turnFileDiffs.chatId, chatId),
      eq(turnFileDiffs.userId, session.user.id),
    ),
  )
  .orderBy(asc(turnFileDiffs.createdAt));
const diffs = diffRows.filter((r) => visibleStatus(r.status)).map(toPreview);
return c.json({ chat: chatRows[0], messages, diffs });
```

El overview de workspaces (`recentMessages`) **no** incluye bodies ni el sidecar completo.

- [ ] En `api/openapi/openapi.yaml`:

  1. Schema `TurnFileDiffPreview`:

```yaml
TurnFileDiffPreview:
  type: object
  properties:
    id: { type: string }
    chatId: { type: string }
    streamId: { type: string }
    toolCallId: { type: string, nullable: true }
    path: { type: string }
    kind: { type: string, enum: [created, modified, deleted] }
    status: { type: string, enum: [proposed, applied, rejected] }
    additions: { type: integer }
    deletions: { type: integer }
    preview: { type: string }
    truncated: { type: boolean }
    binary: { type: boolean }
    omitted: { type: boolean }
    byteSize: { type: integer, nullable: true }
```

  2. `GET /chats/{chatId}` 200: añadir `diffs` array de `TurnFileDiffPreview`.
  3. Nuevo path `GET /chats/{chatId}/diffs/{diffId}` (401/404 iguales).
  4. Descripción de `/ws`: añadir `chat.diff.upsert`, `chat.diff.get` a tipos implementados. Push `chat.diff.upsert` **sin** `body`.

- [ ] Correr:

```bash
cd api && bun test src/ws/diff-protocol.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/src/ws/diff-protocol.ts \
  api/src/ws/diff-protocol.test.ts api/src/ws/protocol.ts \
  api/src/ws/handlers.ts api/src/routes/workspaces.ts \
  api/openapi/openapi.yaml api/package.json
git commit -m "feat(diffs): persist turn file diffs and expose preview plus on-demand body"
```

---

## Task 3: Collector en el daemon — snapshot en `canUseTool`, neto al cerrar, Bash vía git

**Files:**

- Create: `cli/src/llm/git-porcelain.ts`
- Test: `cli/src/llm/git-porcelain.test.ts`
- Create: `cli/src/llm/turn-diff-collector.ts`
- Test: `cli/src/llm/turn-diff-collector.test.ts`
- Create: `cli/src/llm/can-use-tool.ts` (si execution-modes **no** lo creó; si existe, Modify)
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/client.ts`
- Test: `cli/src/llm/can-use-tool.diff.test.ts`

El snapshot ocurre **antes** de `behavior: "allow"`. `tool_start` no es un hook seguro: el SDK puede haber escrito ya. Sin `canUseTool` (hoy `bypassPermissions`) los diffs salen mal; esta task lo sustituye o lo extiende.

- [ ] Crear `cli/src/llm/git-porcelain.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toPosixRel } from "./diff-constants";

export type PorcelainEntry = {
  path: string;
  x: string; // index
  y: string; // worktree
};

export function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

export async function gitPorcelain(cwd: string): Promise<PorcelainEntry[] | null> {
  if (!isGitRepo(cwd)) return null;
  const proc = Bun.spawn(["git", "-C", cwd, "status", "--porcelain", "-uall"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const out: PorcelainEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";
    let rest = line.slice(3);
    if (rest.includes(" -> ")) rest = rest.split(" -> ").pop() || rest;
    out.push({ path: toPosixRel(rest), x, y });
  }
  return out;
}

export function porcelainPaths(entries: PorcelainEntry[]): Set<string> {
  return new Set(entries.map((e) => e.path));
}

export function changedPaths(before: PorcelainEntry[], after: PorcelainEntry[]): string[] {
  const b = new Map(before.map((e) => [e.path, `${e.x}${e.y}`]));
  const a = new Map(after.map((e) => [e.path, `${e.x}${e.y}`]));
  const paths = new Set([...b.keys(), ...a.keys()]);
  const changed: string[] = [];
  for (const p of paths) {
    if (b.get(p) !== a.get(p)) changed.push(p);
  }
  return changed.sort();
}
```

Esto **no** es la tool git del plan 7: no hay commit, branch ni PR.

- [ ] Test `cli/src/llm/git-porcelain.test.ts` — temp dir **con** `git init` y **sin** `.git`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, gitPorcelain, isGitRepo } from "./git-porcelain";

function tmp(): string {
  const dir = realpathSync(mkdirSync(join(tmpdir(), `chavez-git-${crypto.randomUUID()}`), { recursive: true }) || "");
  return dir;
}

describe("gitPorcelain", () => {
  test("null when not a repo", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "x\n");
    expect(isGitRepo(cwd)).toBe(false);
    expect(await gitPorcelain(cwd)).toBeNull();
  });

  test("detects untracked then modified", async () => {
    const cwd = tmp();
    const init = Bun.spawn(["git", "-C", cwd, "init"], { stdout: "ignore", stderr: "ignore" });
    await init.exited;
    const cfg1 = Bun.spawn(["git", "-C", cwd, "config", "user.email", "t@t"], { stdout: "ignore", stderr: "ignore" });
    await cfg1.exited;
    const cfg2 = Bun.spawn(["git", "-C", cwd, "config", "user.name", "t"], { stdout: "ignore", stderr: "ignore" });
    await cfg2.exited;
    writeFileSync(join(cwd, "a.ts"), "one\n");
    const before = (await gitPorcelain(cwd)) || [];
    expect(before.some((e) => e.path === "a.ts")).toBe(true);
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "b.ts"), "n\n");
    const after = (await gitPorcelain(cwd)) || [];
    const ch = changedPaths(before, after);
    expect(ch).toContain("b.ts");
  });
});
```

- [ ] Crear `cli/src/llm/turn-diff-collector.ts`:

```ts
import { readFileSync, statSync, existsSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";
import {
  DIFF_SNAPSHOT_MAX_BYTES,
  NO_GIT_FOR_BASH,
  toPosixRel,
  type DiffStatus,
} from "./diff-constants";
import {
  computeUnifiedDiff,
  emptySnapshot,
  isBinaryBuffer,
  type ComputedDiff,
  type Snapshot,
} from "./unified-diff";
import { proposedAfterSnapshot, toolPathFromInput } from "./proposed-edit";
import { changedPaths, gitPorcelain, type PorcelainEntry } from "./git-porcelain";

export type PublishedDiff = ComputedDiff & {
  status: DiffStatus;
  toolCallId: string | null;
};

function relToCwd(cwd: string, p: string): string {
  const abs = isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(cwd, p);
  return toPosixRel(relative(cwd, abs) || p);
}

export function readSnapshot(cwd: string, relOrAbs: string): Snapshot {
  const rel = relToCwd(cwd, relOrAbs);
  const abs = isAbsolute(relOrAbs) || /^[A-Za-z]:/.test(relOrAbs) ? relOrAbs : join(cwd, rel);
  if (!existsSync(abs)) return emptySnapshot();
  let st;
  try {
    st = statSync(abs);
  } catch {
    return emptySnapshot();
  }
  if (st.isDirectory()) {
    return { existed: true, text: null, binary: true, tooBig: false, byteSize: 0 };
  }
  const byteSize = st.size;
  if (byteSize > DIFF_SNAPSHOT_MAX_BYTES) {
    const buf = readFileSync(abs).subarray(0, Math.min(64_000, DIFF_SNAPSHOT_MAX_BYTES));
    const binary = isBinaryBuffer(buf);
    return {
      existed: true,
      text: binary ? null : buf.toString("utf8"),
      binary,
      tooBig: true,
      byteSize,
    };
  }
  const buf = readFileSync(abs);
  const binary = isBinaryBuffer(buf);
  return {
    existed: true,
    text: binary ? null : buf.toString("utf8"),
    binary,
    tooBig: false,
    byteSize,
  };
}

const PATH_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

export class TurnDiffCollector {
  private originals = new Map<string, Snapshot>();
  private toolCallByPath = new Map<string, string>();
  private bashBefore: PorcelainEntry[] | null = null;
  private bashNoted = false;
  private dropped = new Set<string>();

  constructor(
    public readonly streamId: string,
    public readonly cwd: string,
  ) {}

  /** Call immediately before returning allow from canUseTool. */
  async beforeAllow(sdkName: string, input: Record<string, unknown> | null, toolCallId: string): Promise<void> {
    if (READ_TOOLS.has(sdkName)) return;
    if (PATH_TOOLS.has(sdkName)) {
      const p = toolPathFromInput(input);
      if (!p) return;
      const rel = relToCwd(this.cwd, p);
      if (!this.originals.has(rel)) {
        this.originals.set(rel, readSnapshot(this.cwd, p));
      }
      this.toolCallByPath.set(rel, toolCallId);
      this.dropped.delete(rel);
      return;
    }
    if (sdkName === "Bash") {
      if (this.bashBefore == null) {
        this.bashBefore = await gitPorcelain(this.cwd);
      }
    }
  }

  propose(
    sdkName: string,
    input: Record<string, unknown> | null,
    toolCallId: string,
  ): PublishedDiff | null {
    if (!PATH_TOOLS.has(sdkName)) return null;
    const p = toolPathFromInput(input);
    if (!p) return null;
    const rel = relToCwd(this.cwd, p);
    const before = this.originals.get(rel) ?? readSnapshot(this.cwd, p);
    if (!this.originals.has(rel)) this.originals.set(rel, before);
    const after = proposedAfterSnapshot(sdkName, input, before);
    if (!after) return null;
    const computed = computeUnifiedDiff({ path: rel, before, after });
    this.toolCallByPath.set(rel, toolCallId);
    return { ...computed, status: "proposed", toolCallId };
  }

  dropProposed(toolCallId: string): string[] {
    const dropped: string[] = [];
    for (const [path, id] of this.toolCallByPath) {
      if (id === toolCallId) {
        this.dropped.add(path);
        dropped.push(path);
      }
    }
    return dropped;
  }

  async afterTool(sdkName: string, input: Record<string, unknown> | null, status: string): Promise<void> {
    if (status === "error") return;
    if (sdkName === "Bash") this.bashNoted = true;
    if (PATH_TOOLS.has(sdkName)) {
      const p = toolPathFromInput(input);
      if (p) this.dropped.delete(relToCwd(this.cwd, p));
    }
  }

  async finalize(): Promise<PublishedDiff[]> {
    if (this.bashNoted) {
      const after = await gitPorcelain(this.cwd);
      if (this.bashBefore && after) {
        for (const p of changedPaths(this.bashBefore, after)) {
          if (!this.originals.has(p)) {
            // original unknown: treat missing-before as empty if file now exists
            const now = readSnapshot(this.cwd, p);
            const before: Snapshot = now.existed
              ? emptySnapshot()
              : readSnapshot(this.cwd, p);
            // If deleted, porcelain after won't have content; mark existed original.
            this.originals.set(
              p,
              now.existed ? emptySnapshot() : { existed: true, text: "", binary: false, tooBig: false, byteSize: 0 },
            );
            if (!now.existed) {
              this.originals.set(p, {
                existed: true,
                text: "",
                binary: false,
                tooBig: false,
                byteSize: 0,
              });
            }
          }
        }
      }
    }
    const out: PublishedDiff[] = [];
    for (const [path, before] of this.originals) {
      if (this.dropped.has(path)) continue;
      const after = readSnapshot(this.cwd, path);
      const sameText =
        !before.binary &&
        !after.binary &&
        (before.text || "") === (after.text || "") &&
        before.existed === after.existed;
      if (sameText) continue;
      if (!before.existed && !after.existed) continue;
      const computed = computeUnifiedDiff({ path, before, after });
      out.push({
        ...computed,
        status: "applied",
        toolCallId: this.toolCallByPath.get(path) ?? null,
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  bashWithoutGitNotice(): string | null {
    if (this.bashNoted && this.bashBefore == null) return NO_GIT_FOR_BASH;
    return null;
  }
}

export function toUpsertPayload(d: PublishedDiff): Record<string, unknown> {
  return {
    path: d.path,
    kind: d.kind,
    status: d.status,
    toolCallId: d.toolCallId,
    additions: d.additions,
    deletions: d.deletions,
    preview: d.preview,
    body: d.omitted ? null : d.body,
    truncated: d.truncated,
    binary: d.binary,
    omitted: d.omitted,
    byteSize: d.byteSize,
  };
}
```

Para Bash deletes: si `changedPaths` incluye un path que ya no existe, `readSnapshot` devuelve `existed: false`. El original se marca `existed: true` con texto vacío si no lo teníamos (stat `+0 −?`). Preferible: si el path estaba en `bashBefore` y no existe después → `kind=deleted`. El bloque de `finalize` que setea `emptySnapshot` para untracked-created está bien; para delete, setear `existed: true` cuando `!now.existed`. Ajustar el loop Bash así (reemplaza el `if (!this.originals.has(p))` interior):

```ts
for (const p of changedPaths(this.bashBefore, after)) {
  if (this.originals.has(p)) continue;
  const now = readSnapshot(this.cwd, p);
  if (now.existed) {
    this.originals.set(p, emptySnapshot()); // created via bash
  } else {
    this.originals.set(p, {
      existed: true,
      text: "",
      binary: false,
      tooBig: false,
      byteSize: 0,
    });
  }
}
```

Deleted enorme vía Bash sin snapshot previo: `computeUnifiedDiff` verá `before.text === ""` y `after` empty → `sameText` skip. Aceptable: sin blob previo no inventamos el contenido. El Gherkin de deleted enorme cubre Write/Edit snapshot (sí teníamos el archivo). Tests de Task 1 cubren omitted blob.

- [ ] Test `cli/src/llm/turn-diff-collector.test.ts` con temp dir (sin SDK):

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDiffCollector } from "./turn-diff-collector";

function tmp(): string {
  return realpathSync(
    mkdirSync(join(tmpdir(), `chavez-col-${crypto.randomUUID()}`), { recursive: true })!,
  );
}

describe("TurnDiffCollector", () => {
  test("net of two edits is one modified path", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "one\n");
    const c = new TurnDiffCollector("s1", cwd);
    await c.beforeAllow("Edit", { file_path: "a.ts", old_string: "one", new_string: "two" }, "t1");
    writeFileSync(join(cwd, "a.ts"), "two\n");
    await c.afterTool("Edit", { file_path: "a.ts" }, "done");
    await c.beforeAllow("Edit", { file_path: "a.ts", old_string: "two", new_string: "three" }, "t2");
    writeFileSync(join(cwd, "a.ts"), "three\n");
    await c.afterTool("Edit", { file_path: "a.ts" }, "done");
    const set = await c.finalize();
    expect(set).toHaveLength(1);
    expect(set[0]!.path).toBe("a.ts");
    expect(set[0]!.kind).toBe("modified");
    expect(set[0]!.preview).toContain("-one");
    expect(set[0]!.preview).toContain("+three");
  });

  test("created vs modified vs deleted", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "keep.ts"), "k\n");
    writeFileSync(join(cwd, "gone.ts"), "g\n");
    const c = new TurnDiffCollector("s2", cwd);
    await c.beforeAllow("Write", { file_path: "new.ts", content: "n\n" }, "t1");
    writeFileSync(join(cwd, "new.ts"), "n\n");
    await c.beforeAllow("Edit", { file_path: "keep.ts", old_string: "k", new_string: "K" }, "t2");
    writeFileSync(join(cwd, "keep.ts"), "K\n");
    await c.beforeAllow("Bash", { command: "rm gone.ts" }, "t3");
    unlinkSync(join(cwd, "gone.ts"));
    c.dropProposed("nope");
    // bash without git: gone.ts was not snapshotted as a path tool
    await c.afterTool("Bash", { command: "rm gone.ts" }, "done");
    // explicit path delete via Write-equivalent: snapshot gone before unlink already missed.
    // Snapshot delete by pretending it was an Edit path we tracked:
    const c2 = new TurnDiffCollector("s3", cwd);
    writeFileSync(join(cwd, "gone2.ts"), "z\n");
    await c2.beforeAllow("Bash", { command: "rm" }, "tb");
    // force path tracking like a write-delete
    await c2.beforeAllow("Write", { file_path: "gone2.ts", content: "" }, "td");
    unlinkSync(join(cwd, "gone2.ts"));
    const set = await c2.finalize();
    const kinds = Object.fromEntries(set.map((d) => [d.path, d.kind]));
    expect(kinds["gone2.ts"]).toBe("deleted");
  });

  test("read-only finalize is empty", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "x\n");
    const c = new TurnDiffCollector("s4", cwd);
    await c.beforeAllow("Read", { file_path: "a.ts" }, "t");
    const set = await c.finalize();
    expect(set).toHaveLength(0);
  });

  test("dropProposed excludes path from applied set", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const c = new TurnDiffCollector("s5", cwd);
    const proposed = c.propose("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    expect(proposed?.status).toBe("proposed");
    expect(proposed?.kind).toBe("modified");
    c.dropProposed("t1");
    const set = await c.finalize();
    expect(set).toHaveLength(0);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("old\n");
  });
});
```

- [ ] `cli/src/llm/can-use-tool.ts`: si el archivo **no** existe, crearlo con el gate de execution-modes (copiar `gateMutation` / `denyIfEscapes` según existan). Si **existe**, no reescribir el gate; insertar el collector.

Firma objetivo:

```ts
import type { ExecutionMode } from "./execution-mode";
import type { TurnDiffCollector } from "./turn-diff-collector";

export type AskPermission = (req: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  proposed?: ReturnType<TurnDiffCollector["propose"]>;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export function buildCanUseTool(opts: {
  cwd: string;
  executionMode?: ExecutionMode;
  collector: TurnDiffCollector;
  onAskPermission?: AskPermission;
}): (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOpts: { signal: AbortSignal; toolUseID?: string },
) => Promise<{ behavior: "allow" | "deny"; message?: string }>;
```

Cuerpo (orden **fijo**):

1. `denyIfEscapes` si `./tool-sandbox` existe; si no, no inventar un sandbox distinto (el plan 2 lo añade).
2. `gateMutation` si `./execution-gate` existe; si no, tratar como `auto` (allow tras snapshot). `plan` deny **sin** snapshot.
3. Si decision `ask`: `proposed = collector.propose(...)`; `onAskPermission({ proposed })`; deny → `collector.dropProposed(toolCallId)` y `{ behavior: "deny", message: ASK_DENIED }`; approve sigue.
4. `await collector.beforeAllow(toolName, toolInput, toolCallId)`.
5. `return { behavior: "allow" }`.

Si `execution-mode.ts` no existe, inlinar `ASK_DENIED = "User denied this tool"` y `PLAN_MUTATION_DENIED` del plan 3 (mismos strings). No usar `permissionMode: "bypassPermissions"`.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. Ampliar `RunClaudeTurnInput` con `collector?: TurnDiffCollector`, `executionMode?`, `onAskPermission?` (si plan 3 ya lo hizo, no duplicar).
  2. `permissionMode: "default"`, `permissionPrompts: "host"`, `canUseTool: buildCanUseTool({ cwd, executionMode, collector, onAskPermission })`.
  3. Si `collector` falta, construir uno throwaway **no** se hace: `publish-turn` siempre pasa collector. El runner exige `collector` cuando hay tools.
  4. `tools` / `allowedTools`: si `DEFAULT_CLAUDE_TOOLS` existe, usarlo; si no, `["Read","Write","Edit","Grep","Glob","Bash"]`.

- [ ] En `cli/src/ws/client.ts` `WsRequest`, añadir `diffId?: string` y `diff?: Record<string, unknown>` (igual que API protocol).

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Importar `TurnDiffCollector`, `toUpsertPayload`.
  2. Tras crear `streamId`:

```ts
const collector = new TurnDiffCollector(streamId, cwd);
```

  3. Pasar `collector` a `runClaudeTurn`.
  4. `onAskPermission` (si plan 3 ya emite `chat.tool.update`): **añadir** `proposed` al metadata:

```ts
metadata: {
  sdkName: toolName,
  input: sanitizeToolInput?.(toolInput) ?? toolInput,
  summary: summarizeToolInput?.(toolName, toolInput),
  executionMode,
  diff: proposed ? toUpsertPayload(proposed) : undefined,
},
```

     Y si hay `proposed`, `client.request({ type: "chat.diff.upsert", chatId, streamId, diff: toUpsertPayload(proposed) })`.

  5. En `onEvent` `tool_result`: `await collector.afterTool(ev.toolName || "", …, ev.status || "done")`. El `toolName` del result puede venir en canónico; pasar también `sdkName` si el event lo trae. Ampliar `AgentTurnEvent` `tool_result` con `sdkName?: string` e `input?: unknown` si hace falta para Bash/path.

  6. Tras `chat.stream.end` (success) y también en `finally` si el turn abortó a mitad **después** de mutar:

```ts
const applied = await collector.finalize();
for (const d of applied) {
  await client.request({
    type: "chat.diff.upsert",
    chatId,
    streamId,
    diff: toUpsertPayload(d),
  });
}
```

     Si `applied.length === 0`, **no** enviar un upsert vacío ni un `chat.diff.set` con `files: []`.

  7. `onAskPermission` deny/timeout: `collector.dropProposed(toolCallId)` y upsert `{ ...proposed, status: "rejected" }` si había proposed (para que el panel lo quite vía `dropped: true`).

- [ ] Crear `cli/src/llm/can-use-tool.diff.test.ts` — **no** llama al SDK. Testea que `plan` no llama `beforeAllow` (spy: collector.originals size 0) y que `auto` sí snapshotea. Si `gateMutation` no existe, skip el caso plan con `test.skip` **no**: inlinar un stub de gate en el test importando `buildCanUseTool`. Casos mínimos:

  - `Read` + auto → originals vacío tras beforeAllow.
  - `Write` + auto → originals tiene el path.
  - `Write` + plan (si gate existe) → deny, originals vacío.

- [ ] Correr:

```bash
cd cli && bun test src/llm/git-porcelain.test.ts \
  src/llm/turn-diff-collector.test.ts src/llm/can-use-tool.diff.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/git-porcelain.ts cli/src/llm/git-porcelain.test.ts \
  cli/src/llm/turn-diff-collector.ts cli/src/llm/turn-diff-collector.test.ts \
  cli/src/llm/can-use-tool.ts cli/src/llm/can-use-tool.diff.test.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts cli/src/ws/client.ts
git commit -m "feat(diffs): snapshot before mutate and publish net turn diffs"
```

---

## Task 4: Ask — el diff es la aprobación; approve aplica; deny no deja applied

**Files:**

- Modify: `cli/src/llm/publish-turn.ts` (si Task 3 dejó el hook a medias)
- Modify: `cli/src/llm/can-use-tool.ts`
- Test: `cli/src/llm/ask-diff.test.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx` (ToolCard: el diff propuesto; Task 7 pinta el panel de turn — aquí solo el pedido)

Esta task cierra el escenario Gherkin “Diff en ask es la aprobación”. El waiter y `agent.tool.approve`/`deny` son del plan 3: no reimplementar timeout ni “ya resuelto”. Sí: el payload de `awaiting_approval` **incluye** `metadata.diff` (preview unificado + kind + path + `+/-`).

- [ ] Contrato del metadata de `chat.tool.update` cuando `status === "awaiting_approval"`:

```ts
{
  sdkName: "Edit",
  toolName: "edit",
  status: "awaiting_approval",
  input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
  summary: "src/a.ts  −1 +1 lines",
  executionMode: "ask",
  diff: {
    path: "src/a.ts",
    kind: "modified",
    status: "proposed",
    additions: 1,
    deletions: 1,
    preview: "diff --git a/src/a.ts b/src/a.ts\n...",
    truncated: false,
    binary: false,
    omitted: false,
    toolCallId: "…"
  }
}
```

Bash en ask: **no** hay diff de archivo propuesto (el comando aún no corrió). `metadata.diff` ausente; `summary` sigue siendo el comando. Tras approve + result, `finalize`/porcelain publica `applied`. Plan 13 puede mostrar el comando; esta fase no finge un diff de Bash pre-ejecución.

- [ ] Crear `cli/src/llm/ask-diff.test.ts` — collector + propose + drop, sin SDK:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDiffCollector, toUpsertPayload } from "./turn-diff-collector";

describe("ask proposed vs applied", () => {
  test("approve path: proposed then disk change then applied", async () => {
    const cwd = realpathSync(
      mkdirSync(join(tmpdir(), `chavez-ask-${crypto.randomUUID()}`), { recursive: true })!,
    );
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const c = new TurnDiffCollector("s", cwd);
    const proposed = c.propose("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    expect(proposed?.status).toBe("proposed");
    expect(toUpsertPayload(proposed!).preview).toContain("-old");
    expect(toUpsertPayload(proposed!).preview).toContain("+new");
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("old\n");
    await c.beforeAllow("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    writeFileSync(join(cwd, "a.ts"), "new\n");
    await c.afterTool("Write", { file_path: "a.ts" }, "done");
    const applied = await c.finalize();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.status).toBe("applied");
    expect(applied[0]!.kind).toBe("modified");
  });

  test("deny path: disk unchanged and no applied", async () => {
    const cwd = realpathSync(
      mkdirSync(join(tmpdir(), `chavez-deny-${crypto.randomUUID()}`), { recursive: true })!,
    );
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const c = new TurnDiffCollector("s", cwd);
    c.propose("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    const dropped = c.dropProposed("t1");
    expect(dropped).toEqual(["a.ts"]);
    const applied = await c.finalize();
    expect(applied).toHaveLength(0);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("old\n");
  });
});
```

- [ ] En `can-use-tool.ts`, el branch `ask` **debe** llamar `propose` **antes** de `waitForApproval`, y `beforeAllow` **solo** tras `approve`. Orden incorrecto (snapshot + write + then ask) viola el Gherkin.

- [ ] ToolCard (Web) — si Task 7 aún no existe, un cambio mínimo aquí: cuando `meta.diff` y `status === "awaiting_approval"`, renderizar `<pre className="diff-preview">{String((meta.diff as { preview?: string }).preview || "")}</pre>` **encima** de Aprobar/Rechazar. Si los botones aún no existen (plan 2/3 no aplicados), no inventar un segundo canal de approve: el usuario usa TUI/CLI. No añadir “siempre permitir”.

- [ ] Correr:

```bash
cd cli && bun test src/llm/ask-diff.test.ts src/llm/turn-diff-collector.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/ask-diff.test.ts cli/src/llm/can-use-tool.ts \
  cli/src/llm/publish-turn.ts web/src/components/ChatDetailPanel.tsx
git commit -m "feat(diffs): proposed unified diff is the ask approval payload"
```

Si `ChatDetailPanel.tsx` no se tocó (se deja para Task 7), omitirlo del `git add`.

---

## Task 5: CLI `watch` — resumen `+/-`; unificado solo con `--verbose`; `chat diffs` / `chat diff`

**Files:**

- Modify: `cli/src/llm/watch-format.ts` (crear si el plan 2 no lo creó)
- Test: `cli/src/llm/watch-format.diff.test.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`

Gherkin: watch lista paths y un stat; no vuelca el diff entero salvo flag/verbose.

- [ ] En `cli/src/llm/watch-format.ts`, añadir (si el archivo no existe, crearlo con `formatWatchLine` mínimo de agent-tools Task 5 y estos cases):

```ts
export function formatDiffStat(diff: {
  path?: string;
  kind?: string;
  additions?: number;
  deletions?: number;
  status?: string;
}): string {
  const path = diff.path || "?";
  const kind = diff.kind || "modified";
  const add = Number(diff.additions || 0);
  const del = Number(diff.deletions || 0);
  const st = diff.status && diff.status !== "applied" ? ` · ${diff.status}` : "";
  return `diff · ${kind} · ${path}  +${add} −${del}${st}`;
}

export function formatWatchLine(
  msg: { type: string; data?: unknown },
  opts: { verbose?: boolean } = {},
): string | null {
  // …keep existing tool/stream cases from plan 2…
  const data = rec(msg.data) ?? {};
  if (msg.type === "chat.diff.upsert") {
    if (data.dropped) {
      const diff = rec(data.diff) ?? {};
      return `diff · dropped · ${String(diff.path || "")}`;
    }
    const diff = rec(data.diff) ?? {};
    const head = formatDiffStat({
      path: String(diff.path || ""),
      kind: String(diff.kind || "modified"),
      additions: Number(diff.additions || 0),
      deletions: Number(diff.deletions || 0),
      status: String(diff.status || "applied"),
    });
    if (!opts.verbose) return head;
    const preview = String(diff.preview || "");
    return preview ? `${head}\n${preview}` : head;
  }
  return null; // other types: existing implementation
}
```

`formatWatchLine` **nunca** imprime `body`. Verbose usa `preview` (ya truncado).

- [ ] Crear `cli/src/llm/watch-format.diff.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatDiffStat, formatWatchLine } from "./watch-format";

describe("watch diffs", () => {
  const payload = {
    type: "chat.diff.upsert",
    data: {
      chatId: "c1",
      streamId: "s1",
      diff: {
        path: "src/a.ts",
        kind: "modified",
        status: "applied",
        additions: 12,
        deletions: 3,
        preview: "diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n",
      },
    },
  };

  test("default is one stat line, no unified dump", () => {
    const line = formatWatchLine(payload);
    expect(line).toBe("diff · modified · src/a.ts  +12 −3");
    expect(line).not.toContain("diff --git");
  });

  test("verbose includes truncated preview", () => {
    const line = formatWatchLine(payload, { verbose: true });
    expect(line).toContain("diff · modified · src/a.ts  +12 −3");
    expect(line).toContain("diff --git");
    expect(line).toContain("+new");
  });

  test("dropped proposed does not look applied", () => {
    expect(
      formatWatchLine({
        type: "chat.diff.upsert",
        data: { dropped: true, diff: { path: "src/a.ts", status: "rejected" } },
      }),
    ).toBe("diff · dropped · src/a.ts");
  });

  test("formatDiffStat created/deleted", () => {
    expect(formatDiffStat({ path: "n.ts", kind: "created", additions: 40, deletions: 0 })).toBe(
      "diff · created · n.ts  +40 −0",
    );
    expect(formatDiffStat({ path: "g.ts", kind: "deleted", additions: 0, deletions: 8 })).toBe(
      "diff · deleted · g.ts  +0 −8",
    );
  });
});
```

Si `formatWatchLine` ya existía, **extender** la firma con `opts` default `{}` para no romper tests del plan 2.

- [ ] En `cli/src/commands/headless.ts` grupo `chat`:

  1. `watch`:

```ts
if (action === "watch") {
  const chatId = rest.find((a) => !a.startsWith("-"));
  const verbose = rest.includes("--verbose") || rest.includes("-v");
  if (!chatId) throw new Error("Uso: … chat watch <chatId> [--verbose]");
  const watchClient = client;
  watchClient.onPush((msg) => {
    const data = msg.data as { chatId?: string } | undefined;
    if (data?.chatId && data.chatId !== chatId) return;
    const line = formatWatchLine({ type: msg.type, data: msg.data }, { verbose });
    if (line) console.log(line);
  });
  console.error(`watching chat=${chatId} (Ctrl+C para salir)`);
  await new Promise(() => {});
  return;
}
```

  Si el plan 2 aún no sustituyó el `JSON.stringify` del watch, **esta** task lo sustituye para `chat.diff.upsert` como mínimo: nunca dump del unificado en default. Preferible: usar `formatWatchLine` para todos los tipos (plan 2). No reintroducir JSON crudo.

  2. Nuevas actions `diffs` y `diff` (on-demand Gherkin “puedo pedir el diff completo” en CLI):

```ts
if (action === "diffs") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: … chat diffs <chatId>");
  const res = await client.request({ type: "chat.get", chatId });
  if (!res.ok) throw new Error(res.error);
  const diffs =
    (res.data as { diffs?: Array<{ path: string; kind: string; additions: number; deletions: number; streamId: string; id: string; truncated?: boolean }> })
      ?.diffs ?? [];
  if (diffs.length === 0) {
    console.log("sin diffs");
    return;
  }
  for (const d of diffs) {
    console.log(
      `${d.streamId.slice(0, 8)}  ${formatDiffStat(d)}${d.truncated ? "  [truncated]" : ""}`,
    );
  }
  return;
}

if (action === "diff") {
  const chatId = rest[0];
  const want = rest[1];
  if (!chatId || !want) throw new Error("Uso: … chat diff <chatId> <path|diffId>");
  const listed = await client.request({ type: "chat.get", chatId });
  if (!listed.ok) throw new Error(listed.error);
  const diffs =
    (listed.data as { diffs?: Array<{ id: string; path: string; preview: string; truncated?: boolean; omitted?: boolean }> })
      ?.diffs ?? [];
  const row =
    diffs.find((d) => d.id === want) ||
    diffs.filter((d) => d.path === want).at(-1);
  if (!row) throw new Error(`No hay diff para ${want}`);
  const full = await client.request({
    type: "chat.diff.get",
    chatId,
    diffId: row.id,
  });
  if (!full.ok) throw new Error(full.error);
  const diff = (full.data as { diff?: { body?: string | null; preview?: string; omitted?: boolean } })?.diff;
  if (diff?.omitted || diff?.body == null) {
    console.log(diff?.preview || row.preview);
    return;
  }
  console.log(diff.body);
  return;
}
```

  Actualizar el `throw` de uso: `create|list|append|get|ask|watch|diffs|diff`.

- [ ] En `cli/src/index.ts` `usage()`, la línea de chat pasa a:

```
chavez headless chat create|list|append|get|ask|watch|diffs|diff
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.diff.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/watch-format.ts cli/src/llm/watch-format.diff.test.ts \
  cli/src/commands/headless.ts cli/src/index.ts
git commit -m "feat(diffs): watch prints path stats; verbose and chat diff for full body"
```

---

## Task 6: TUI — mismo set, sin panel vacío, kinds visibles

**Files:**

- Modify: `tui/src/App.tsx`

Gherkin: Web, TUI y watch muestran el mismo set. Plan no pinta panel vacío. Turn sin mutación no finge “0 archivos”.

- [ ] Ampliar types:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

type TurnDiff = {
  id: string;
  streamId: string;
  path: string;
  kind: "created" | "modified" | "deleted" | string;
  status: string;
  additions: number;
  deletions: number;
  preview: string;
  truncated?: boolean;
  binary?: boolean;
  omitted?: boolean;
};
```

- [ ] Estado: `const [diffs, setDiffs] = useState<TurnDiff[]>([]);` y `const [expandDiffs, setExpandDiffs] = useState(false);`.

- [ ] `loadChat`:

```ts
const res = await client.request({ type: "chat.get", chatId });
if (res.ok) {
  const data = res.data as { messages?: Message[]; diffs?: TurnDiff[] };
  setMessages(data.messages ?? []);
  setDiffs((data.diffs ?? []).filter((d) => d.status === "proposed" || d.status === "applied"));
}
```

- [ ] En el `onPush` que ya recarga el chat, añadir `msg.type === "chat.diff.upsert"` al predicado que llama `loadChat`. No hace falta merge manual: `chat.get` es la fuente.

- [ ] En el bloque Messages, **después** de los últimos mensajes, si `diffs.length > 0`:

```tsx
<Box flexDirection="column" marginTop={1}>
  <Text bold>
    diffs {diffs.length}  (d expande)
  </Text>
  {diffs.map((d) => (
    <Text key={d.id} wrap="truncate-end">
      {d.kind === "created" ? "+" : d.kind === "deleted" ? "−" : "~"}{" "}
      {d.path}  +{d.additions} −{d.deletions}
      {d.truncated ? " [truncated]" : ""}
      {d.binary ? " [binary]" : ""}
    </Text>
  ))}
  {expandDiffs &&
    diffs.slice(0, 3).map((d) => (
      <Box key={`${d.id}-p`} flexDirection="column">
        <Text dimColor>{d.path}</Text>
        <Text>{d.preview.split("\n").slice(0, 12).join("\n")}</Text>
      </Box>
    ))}
</Box>
```

Si `diffs.length === 0`, **no** renderizar el `Box` (ni “diffs 0”).

- [ ] En `useInput` modo command, tecla `d` (si no está cogida): `setExpandDiffs((v) => !v)`. No pedir body completo en el TUI por defecto ( congela ). Si el usuario necesita el unificado entero: el log muestra `chavez headless chat diff ${chatId} ${path}`. Al expandir un item `truncated`, una línea dim: `full: chavez headless chat diff <id> <path>`.

- [ ] `awaiting_approval`: si el plan 3 añadió `[y]/[n]`, mostrar `metadata.diff.preview` (máx 16 líneas) junto al pedido. Si aún no hay approve en TUI, el preview igual se ve en el panel `diffs` con `status=proposed`.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(diffs): TUI lists turn file diffs without an empty panel"
```

---

## Task 7: Web — DiffsPanel por turn, reload, truncado + “ver completo”, ToolCard propuesto

**Files:**

- Create: `web/src/lib/diff-display.ts`
- Test: `web/src/lib/diff-display.test.ts`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web no calcula diffs. Pinta el sidecar de GET `/chats/:id` y el push `chat.diff.upsert`. Un reload de `/chats/:id` relee diffs **por `streamId`**.

- [ ] Añadir `"test": "bun test"` en `web/package.json` `scripts` si falta.

- [ ] Crear `web/src/lib/diff-display.ts` — **copia** de kinds/status/truncate marker (mismos strings que CLI). No importar `cli/`.

```ts
export type DiffKind = "created" | "modified" | "deleted";
export type DiffStatus = "proposed" | "applied" | "rejected";

export type TurnFileDiff = {
  id: string;
  chatId?: string;
  streamId: string;
  toolCallId?: string | null;
  path: string;
  kind: DiffKind | string;
  status: DiffStatus | string;
  additions: number;
  deletions: number;
  preview: string;
  truncated?: boolean;
  binary?: boolean;
  omitted?: boolean;
  byteSize?: number | null;
  body?: string | null;
};

export function isVisibleDiff(d: { status?: string }): boolean {
  return d.status === "proposed" || d.status === "applied";
}

export function diffsForStream(diffs: TurnFileDiff[], streamId: string | undefined): TurnFileDiff[] {
  if (!streamId) return [];
  return diffs.filter((d) => d.streamId === streamId && isVisibleDiff(d));
}

export function streamIdOf(m: { metadata?: Record<string, unknown> | null }): string | undefined {
  const s = m.metadata?.streamId;
  return typeof s === "string" && s ? s : undefined;
}

export function kindLabel(kind: string): string {
  if (kind === "created") return "created";
  if (kind === "deleted") return "deleted";
  return "modified";
}

export function statLabel(d: TurnFileDiff): string {
  return `+${d.additions} −${d.deletions}`;
}
```

- [ ] Test `web/src/lib/diff-display.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { diffsForStream, isVisibleDiff } from "./diff-display";

describe("diffsForStream", () => {
  const rows = [
    { id: "1", streamId: "s1", path: "a.ts", kind: "modified", status: "applied", additions: 1, deletions: 1, preview: "" },
    { id: "2", streamId: "s2", path: "b.ts", kind: "created", status: "applied", additions: 3, deletions: 0, preview: "" },
    { id: "3", streamId: "s1", path: "c.ts", kind: "deleted", status: "rejected", additions: 0, deletions: 2, preview: "" },
  ];
  test("does not mix turns and hides rejected", () => {
    const s1 = diffsForStream(rows, "s1");
    expect(s1.map((d) => d.path)).toEqual(["a.ts"]);
    expect(isVisibleDiff(rows[2]!)).toBe(false);
  });
  test("missing stream → no fake zero panel data", () => {
    expect(diffsForStream(rows, undefined)).toEqual([]);
  });
});
```

- [ ] En `web/src/lib/hooks.ts`:

  1. Exportar `TurnFileDiff` (re-export desde `diff-display`) o duplicar el type en hooks.
  2. `useChat` tipar la respuesta:

```ts
apiJson<{ chat: Chat; messages: ChatMessage[]; diffs?: TurnFileDiff[] }>(`/chats/${chatId}`)
```

- [ ] En `web/src/lib/ws-client.ts` `WsRequest`, añadir `diffId?: string` y `diff?: Record<string, unknown>`.

- [ ] En `web/src/lib/ws-context.tsx`:

  1. Tipo de `request`: añadir `diffId?: string`.
  2. `onPush` que invalida `queryKeys.chat`: tratar `msg.type === "chat.diff.upsert"` (además de `chat.tool.*`).

- [ ] En `web/src/styles/global.css`:

```css
.diff-panel pre {
  max-height: 16rem;
  overflow: auto;
  font-size: 0.78rem;
  line-height: 1.35;
}
.diff-panel .diff-add { color: var(--ok); }
.diff-panel .diff-del { color: var(--danger); }
.diff-panel .diff-hunk { color: #8ec8ff; }
.diff-panel .diff-meta { color: var(--muted); }
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  1. Importar `diffsForStream`, `kindLabel`, `statLabel`, `streamIdOf`, type `TurnFileDiff`.
  2. `const diffs = (chat.data?.diffs || []).filter((d) => d.status === "proposed" || d.status === "applied");`
  3. Agrupar la timeline: recorrer `messages`; para cada mensaje `assistant` o el **último** `tool` de un `streamId` en un run, si no se ha pintado aún ese stream, pintar `DiffsPanel` **después** del bloque. Usar `apiJson` de `web/src/lib/api.ts` (pega a `env.public.apiUrl`, cookie incluida). **No** `fetch` al origin de Astro.

```tsx
import { apiJson, formatQueryError } from "../lib/api";
// formatQueryError vive en hooks — importar de hooks si api no lo exporta.

function FileDiff({ d, chatId }: { d: TurnFileDiff; chatId: string }) {
  const [full, setFull] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const text = full ?? d.preview;
  async function loadFull() {
    setPending(true);
    setErr(null);
    try {
      const res = await apiJson<{
        diff: { body?: string | null; preview?: string; omitted?: boolean };
      }>(`/chats/${chatId}/diffs/${d.id}`);
      if (res.diff.omitted || res.diff.body == null) {
        setFull(res.diff.preview || d.preview);
      } else {
        setFull(res.diff.body);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="panel diff-panel" style={{ marginBottom: "0.5rem" }}>
      <p style={{ margin: 0 }}>
        <span className="badge">{kindLabel(String(d.kind))}</span>{" "}
        <code>{d.path}</code>{" "}
        <span className="muted">{statLabel(d)}</span>
        {d.status === "proposed" && <span className="badge warn"> proposed</span>}
        {d.truncated && !full && <span className="badge"> truncated</span>}
        {d.binary && <span className="badge"> binary</span>}
      </p>
      <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>
        {text.split("\n").map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
      {d.truncated && !full && !d.binary && (
        <p style={{ margin: "0.5rem 0 0" }}>
          <button type="button" className="secondary" disabled={pending} onClick={() => void loadFull()}>
            {pending ? "Cargando…" : "Ver diff completo"}
          </button>
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function DiffsPanel({
  diffs,
  chatId,
}: {
  diffs: TurnFileDiff[];
  chatId: string;
}) {
  if (diffs.length === 0) return null;
  return (
    <div className="diff-set" style={{ marginBottom: "0.75rem" }}>
      <p className="muted" style={{ margin: "0 0 0.35rem" }}>
        {diffs.length} archivo{diffs.length === 1 ? "" : "s"} tocado{diffs.length === 1 ? "" : "s"}
      </p>
      {diffs.map((d) => (
        <FileDiff key={d.id} d={d} chatId={chatId} />
      ))}
    </div>
  );
}
```

  4. Pintar la timeline **sin** un panel global al pie que mezcle turns. `seenStreams` :

```tsx
const messages = chat.data?.messages || [];
const allDiffs = (chat.data?.diffs || []).filter(
  (d) => d.status === "proposed" || d.status === "applied",
);
const rendered = new Set<string>();
// inside messages.map:
```

Sustituir el `messages.map` por un flatten:

```tsx
{messages.map((m, idx) => {
  const nodes = [];
  nodes.push(
    m.role === "tool" ? (
      <ToolCard key={m.id} m={m} chatId={chatId} />
    ) : (
      <div key={m.id} className="panel" style={{ marginBottom: "0.5rem" }}>
        <span className="badge">{m.role}</span>
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>{m.content}</pre>
      </div>
    ),
  );
  const sid = streamIdOf(m);
  const next = messages[idx + 1];
  const nextSid = next ? streamIdOf(next) : undefined;
  const endOfTurn = sid && sid !== nextSid;
  if (endOfTurn && !rendered.has(sid)) {
    rendered.add(sid);
    const group = diffsForStream(allDiffs, sid);
    if (group.length > 0) {
      nodes.push(<DiffsPanel key={`diff-${sid}`} diffs={group} chatId={chatId} />);
    }
  }
  return nodes;
})}
```

`ToolCard` debe aceptar `chatId` (plan 2 ya lo hace). Si la firma actual es `{ m }`, ampliarla.

Si el último grupo no tiene mensaje con `streamId` (turn abortado), **no** pintar un panel huérfano al pie con diffs de otro stream. Los diffs `proposed` del turn in-flight se ven en el ToolCard y, si `chat.diff.upsert` ya llegó, en el grupo cuando el tool message tenga `metadata.streamId`. Asegurar que `chat.tool.start` persiste `streamId` (plan 2). Si aún no, `publish-turn` Task 3 ya manda `streamId` en el upsert; para agrupar, también estampar `streamId` en tool metadata desde `chat.tool.start` si falta: **Modify** `cli/src/llm/publish-turn.ts` para pasar `streamId` en start/update (si plan 2 no lo hizo).

  5. ToolCard `awaiting_approval`: si `meta.diff` tiene `preview`, mostrar el `<pre className="diff-panel">` **antes** de Aprobar/Rechazar. El disco no cambia hasta el click (plan 3).

  6. `pre { max-height }` ya acota. No pintar `JSON.stringify` del body.

- [ ] `WorkspaceDetailPanel.tsx` `previewLabel`: si el último mensaje es tool, seguir como plan 2. **No** mostrar “0 diffs”. Si se quiere un hint, solo cuando el recent message es assistant y no hay espacio: omitir diffs en el overview (el Gherkin de reload es el chat abierto).

- [ ] Correr:

```bash
cd web && bun test src/lib/diff-display.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/diff-display.ts web/src/lib/diff-display.test.ts \
  web/src/lib/hooks.ts web/src/lib/ws-context.tsx web/src/lib/ws-client.ts \
  web/src/components/ChatDetailPanel.tsx web/src/components/WorkspaceDetailPanel.tsx \
  web/src/styles/global.css web/package.json
git commit -m "feat(diffs): Web turn diff panel, reload by streamId, on-demand full body"
```

---

## Task 8: Smokes Gherkin — persistencia, paridad, plan vacío, ask deny, truncado, watch stat

**Files:**

- Create: `cli/scripts/diffs-review-smoke.ts`
- Modify: `api/package.json` (script opcional; no obligatorio si el smoke vive en CLI)

Sin LLM. El proceso de test actúa como daemon y publica `chat.diff.upsert` / `chat.tool.update` como lo haría `publishAgentTurn`. Cubre los escenarios que no necesitan al modelo. El collector (Task 3) se ejercita contra un temp dir.

- [ ] Crear `cli/scripts/diffs-review-smoke.ts`:

```ts
/**
 * Smoke: turn diffs persist + fan-out; plan empty; ask deny drops applied;
 * truncated preview; watch stat line; reload grouping.
 * Needs: chavez login, API up (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { formatWatchLine } from "../src/llm/watch-format";
import { TurnDiffCollector, toUpsertPayload } from "../src/llm/turn-diff-collector";
import { DIFF_PREVIEW_MAX_LINES } from "../src/llm/diff-constants";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const path = cwdPath();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
assert(db.ok && wb.ok, `bind fail ${db.error} ${wb.error}`);

const session = await web.request({ type: "session.create", title: "diffs-smoke" });
assert(session.ok, session.error || "session");
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({ type: "chat.create", sessionId, title: "diffs-chat" });
assert(chat.ok, chat.error || "chat");
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seen: string[] = [];
web.onPush((msg) => {
  const data = msg.data as { chatId?: string };
  if (data?.chatId && data.chatId !== chatId) return;
  const line = formatWatchLine({ type: msg.type, data: msg.data });
  if (line) seen.push(line.split("\n")[0]!);
});

async function waitFor(pred: () => boolean, label: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (pred()) return;
    await Bun.sleep(50);
  }
  throw new Error(`${label} timeout seen=${seen.join(" | ")}`);
}

// --- auto: three files, same set ---
const cwd = realpathSync(
  mkdirSync(join(tmpdir(), `chavez-smoke-${crypto.randomUUID()}`), { recursive: true })!,
);
writeFileSync(join(cwd, "a.ts"), "a0\n");
writeFileSync(join(cwd, "b.ts"), "b0\n");
writeFileSync(join(cwd, "c.ts"), "c0\n");
const streamAuto = crypto.randomUUID();
const col = new TurnDiffCollector(streamAuto, cwd);
await col.beforeAllow("Edit", { file_path: "a.ts" }, "tA");
writeFileSync(join(cwd, "a.ts"), "a1\n");
await col.beforeAllow("Write", { file_path: "new.ts", content: "n\n" }, "tN");
writeFileSync(join(cwd, "new.ts"), "n\n");
await col.beforeAllow("Write", { file_path: "c.ts", content: "" }, "tC");
writeFileSync(join(cwd, "gone-placeholder.ts"), "x\n");
await col.beforeAllow("Write", { file_path: "gone-placeholder.ts" }, "tD");
const { unlinkSync } = await import("node:fs");
unlinkSync(join(cwd, "gone-placeholder.ts"));
const applied = await col.finalize();
assert(applied.length >= 3, `expected ≥3 net diffs, got ${applied.map((d) => d.path).join(",")}`);
for (const d of applied) {
  const up = await daemon.request({
    type: "chat.diff.upsert",
    chatId,
    streamId: streamAuto,
    diff: toUpsertPayload(d),
  });
  assert(up.ok, up.error || "upsert");
}

await waitFor(
  () => seen.filter((l) => l.startsWith("diff ·")).length >= 3,
  "watch stats",
);
for (const line of seen.filter((l) => l.startsWith("diff ·"))) {
  assert(!line.includes("diff --git"), `watch dumped unified: ${line}`);
  assert(/\+\d+ −\d+/.test(line), `missing stat: ${line}`);
}

const got = await web.request({ type: "chat.get", chatId });
assert(got.ok, got.error || "get");
const diffs1 = (got.data as { diffs: Array<{ path: string; streamId: string; kind: string }> }).diffs;
assert(
  diffs1.filter((d) => d.streamId === streamAuto).length === applied.length,
  "reload must keep auto diffs",
);

// --- next turn must not mix ---
const streamTwo = crypto.randomUUID();
const col2 = new TurnDiffCollector(streamTwo, cwd);
writeFileSync(join(cwd, "only.ts"), "z\n");
await col2.beforeAllow("Write", { file_path: "only.ts", content: "z2\n" }, "t2");
writeFileSync(join(cwd, "only.ts"), "z2\n");
for (const d of await col2.finalize()) {
  const up = await daemon.request({
    type: "chat.diff.upsert",
    chatId,
    streamId: streamTwo,
    diff: toUpsertPayload(d),
  });
  assert(up.ok, up.error || "upsert2");
}
const got2 = await web.request({ type: "chat.get", chatId });
const diffs2 = (got2.data as { diffs: Array<{ path: string; streamId: string }> }).diffs;
assert(
  diffs2.filter((d) => d.streamId === streamAuto).every((d) => d.streamId === streamAuto),
  "stream ids mixed",
);
assert(
  !diffs2.filter((d) => d.streamId === streamTwo).some((d) => d.streamId === streamAuto),
  "turn 2 leaked into turn 1",
);

// --- plan: zero upserts, get has no empty decoy (just no rows for that stream) ---
const streamPlan = crypto.randomUUID();
const colPlan = new TurnDiffCollector(streamPlan, cwd);
await colPlan.beforeAllow("Read", { file_path: "a.ts" }, "tr");
const planSet = await colPlan.finalize();
assert(planSet.length === 0, "plan/read must not produce diffs");
const gotPlan = await web.request({ type: "chat.get", chatId });
const diffsPlan = (gotPlan.data as { diffs: Array<{ streamId: string }> }).diffs;
assert(
  diffsPlan.filter((d) => d.streamId === streamPlan).length === 0,
  "plan stream must be absent, not a zero-file set",
);

// --- ask deny: proposed then rejected, not in visible list ---
const streamAsk = crypto.randomUUID();
const colAsk = new TurnDiffCollector(streamAsk, cwd);
writeFileSync(join(cwd, "ask.ts"), "old\n");
const proposed = colAsk.propose("Write", { file_path: "ask.ts", content: "new\n" }, "ta");
assert(proposed, "proposed");
const upP = await daemon.request({
  type: "chat.diff.upsert",
  chatId,
  streamId: streamAsk,
  diff: toUpsertPayload(proposed!),
});
assert(upP.ok, upP.error || "proposed upsert");
colAsk.dropProposed("ta");
const upR = await daemon.request({
  type: "chat.diff.upsert",
  chatId,
  streamId: streamAsk,
  diff: { ...toUpsertPayload(proposed!), status: "rejected" },
});
assert(upR.ok, upR.error || "rejected upsert");
const gotAsk = await web.request({ type: "chat.get", chatId });
const visibleAsk = (gotAsk.data as { diffs: Array<{ streamId: string; path: string }> }).diffs.filter(
  (d) => d.streamId === streamAsk,
);
assert(visibleAsk.length === 0, "denied ask must not leave applied diffs");

// --- huge truncated ---
const streamHuge = crypto.randomUUID();
const colHuge = new TurnDiffCollector(streamHuge, cwd);
const many = Array.from({ length: DIFF_PREVIEW_MAX_LINES + 80 }, (_, i) => `L${i}`).join("\n") + "\n";
writeFileSync(join(cwd, "huge.ts"), "seed\n");
await colHuge.beforeAllow("Write", { file_path: "huge.ts", content: many }, "th");
writeFileSync(join(cwd, "huge.ts"), many);
const hugeSet = await colHuge.finalize();
assert(hugeSet[0]?.truncated, "expected truncated preview");
assert(hugeSet[0]!.preview.includes("[truncated:"), "marker missing");
const upH = await daemon.request({
  type: "chat.diff.upsert",
  chatId,
  streamId: streamHuge,
  diff: toUpsertPayload(hugeSet[0]!),
});
assert(upH.ok, upH.error || "huge");
const previewPush = formatWatchLine(
  { type: "chat.diff.upsert", data: { diff: toUpsertPayload(hugeSet[0]!) } },
  { verbose: false },
);
assert(previewPush && !previewPush.includes("L50"), "watch default dumped huge preview");
const full = await web.request({
  type: "chat.diff.get",
  chatId,
  diffId: (upH.data as { diff: { id: string } }).diff.id,
});
assert(full.ok, full.error || "diff.get");

console.log("diffs-review-smoke ok");
daemon.close();
web.close();
```

- [ ] Correr (API + login previos):

```bash
cd cli && bun run scripts/diffs-review-smoke.ts
```

Esperado: imprime `diffs-review-smoke ok` y sale 0. Si falla, no “skip”: arreglar persistencia/collector/watch-format.

- [ ] Unitario final (no sustituye el smoke):

```bash
cd cli && bun test src/llm/unified-diff.test.ts src/llm/proposed-edit.test.ts \
  src/llm/turn-diff-collector.test.ts src/llm/ask-diff.test.ts \
  src/llm/watch-format.diff.test.ts src/llm/git-porcelain.test.ts
cd api && bun test src/ws/diff-protocol.test.ts
cd web && bun test src/lib/diff-display.test.ts
```

- [ ] Commit:

```bash
git add cli/scripts/diffs-review-smoke.ts
git commit -m "test(diffs): smoke Gherkin persist, plan empty, ask deny, truncate, watch stats"
```

---

## Verificación de escenarios Gherkin

| Escenario | Tasks | Cómo se demuestra |
|---|---|---|
| Turn auto con varios writes | 1, 3, 5, 6, 7, 8 | Collector neto 3 paths; upsert; Web/TUI/watch mismas stats |
| Diff en ask es la aprobación | 4, 7, 8 | `metadata.diff` proposed; deny → 0 applied; approve → applied + disco |
| Modo plan no genera diffs | 3, 6, 7, 8 | `finalize()` []; UI no pinta panel |
| Recargar Web conserva diffs del turn | 2, 7, 8 | GET `/chats/:id` sidecar por `streamId`; turn 2 no mezcla |
| created vs modified vs deleted | 1, 3, 7 | kinds en preview; deleted enorme `omitted` sin blob |
| Diff enorme se trunca | 1, 5, 7, 8 | marker; `Ver diff completo` / `chat diff`; watch default sin dump |
| Turn sin mutación | 3, 6, 7, 8 | no sección; no “0 archivos” |
| CLI watch imprime resumen | 5, 8 | `diff · kind · path  +N −M`; `--verbose` añade preview |

Criterio de hecho: el archivo de este plan está ejecutado task-by-task, los tests de cada task pasan, y `cli/scripts/diffs-review-smoke.ts` sale 0 contra API + daemon bound.
)
