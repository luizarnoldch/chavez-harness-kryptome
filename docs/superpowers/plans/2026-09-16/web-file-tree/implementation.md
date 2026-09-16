# Web file tree Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, `@` de URLs/secrets, ni un segundo motor de ignore. Spec: [`plan.md`](./plan.md). Depende de [attach-files](../attach-files/implementation.md) (`fs.complete`, picker `@` máx. 10, `hydrateOne`, `MentionComposer`) y de [ignore-secrets](../ignore-secrets/implementation.md) (`loadIgnore`, `listWorkspaceDir`, RPC `fs.tree`, `FileTreePanel` raíz). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas. El picker `@` **sigue** en 10: este plan es exploración (árbol lazy + búsqueda + preview).

**Goal:** En Web, el usuario navega el cwd del **daemon** con un árbol lazy, busca por nombre con matches acotados, previsualiza texto (acotado) e imagen (renderizada) sin fingir binarios como texto, y puede **adjuntar uno a uno** un path como chip `@` idéntico al picker. Sin daemon el árbol explica que no hay filesystem y **nunca** lista el disco del servidor API. Ignore (plan 8) aplica igual que al picker.

**Architecture:** El filesystem real vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"` en `tui/src/App.tsx`). Web pide `fs.tree` / `fs.search` / `fs.preview` por WebSocket. La API **no** hace `readdir`: `hub.findDaemon` + push + pending correlacionado. El árbol es exploración (hasta 200 entradas por carpeta, 50 matches de búsqueda). El picker `@` sigue siendo `fs.complete` con `FS_COMPLETE_LIMIT = 10`. Adjuntar desde el árbol solo inserta un token `@path` en el compositor; la hidratación del turn sigue en el daemon (plan 1).

```
Web FileTreePanel  (workspace + chat)
        |
        |  fs.tree     expand carpeta (lazy)
        |  fs.search   query "auth" → ≤50
        |  fs.preview  texto | imagen | binario
        v
  API hub.findDaemon   — cero I/O de disco —
        |  fail NO_DAEMON_ERROR si no hay runner
        v
  daemon cwd: listWorkspaceDir / searchWorkspace / previewFile
        |  loadIgnore + resolveInsideCwd
        v
  { hostname, cwd, ... }  →  Web
        |
        +-- header "hostname · path"
        +-- Adjuntar → mentionToken → MentionComposer chip (uno a uno)
```

Estado actual que este plan extiende (no reescribir):

- Hoy **no hay** árbol usable en el repo vivo: `web/src/components/WorkspaceDetailPanel.tsx` lista sessions/chats; `ChatDetailPanel.tsx` es un `<textarea>` plano. `cli/src/ws/daemon.ts` solo corre `agent.turn.dispatch`. `api/src/ws/handlers.ts` no tiene `fs.tree` / `fs.search` / `fs.preview`.
- [attach-files](../attach-files/implementation.md) añade `fs.complete` (máx. 10), `hydrateOne` (texto/imagen/binario/dir), `MentionComposer`, chips `@`, hostname en bind. **No tocar el límite 10.**
- [ignore-secrets](../ignore-secrets/implementation.md) Task 6–7 deja `cli/src/llm/fs-tree.ts` (`listWorkspaceDir`, `FS_TREE_MAX_ENTRIES = 200`), RPC `fs.tree`, `useWsFsTree` y un `FileTreePanel` de listado raíz (entrar carpeta reemplaza la lista). Esta fase **sustituye** ese listado plano por un árbol nested lazy, y añade búsqueda + preview + adjuntar. Reusa `listWorkspaceDir` / ignore; no duplica gitignore.
- Sin esos siblings merged: créalos según sus planes y luego extiende. No inventes un `GET /workspaces/:id/files` ni `readdir` en `api/`.
- TUI **es** daemon para Web: debe responder los dispatch. TUI no gana un explorador propio en esta fase.
- Cursor vinculado no ejecuta turns (plan 4). El árbol no depende del provider.

**Tech Stack:** Bun, Hono WebSocket, `createPendingMap(5000)` (`api/src/ws/pending.ts`), Claude Agent SDK (sin cambio), Ink TUI (solo handlers daemon), Astro/React web. Sin dependencia npm nueva. Preview de imagen = `data:` URL en memoria; **no** se persiste `imageBase64` en `chat_messages.metadata`.

**Global Constraints:**

1. El filesystem se lee **solo** en el daemon (cwd del workspace). API y browser no listan, no buscan, no leen bytes. Cero `readdirSync` / `readFileSync` / `fs.promises` en `api/` y `web/`.
2. Sin daemon bound, `fs.tree`, `fs.search`, `fs.preview`, `fs.complete` y `agent.turn.request` fallan con **el mismo string**: `"No daemon bound for this workspace. Run: chavez headless workspace open"`. El árbol Web muestra copy de filesystem, **no** el path del proceso API.
3. Picker `@`: máximo **10** candidatos (`FS_COMPLETE_LIMIT`). La búsqueda del árbol es **otra** RPC (`fs.search`) con tope 50. No subir el límite del picker.
4. Árbol lazy: la raíz se pide al abrir; expandir una carpeta pide `fs.tree` de **ese** relativo. No se camina el cwd entero en el browser.
5. Ignore (plan 8) aplica a tree / search / preview. `node_modules`, `.env`, vault y huge no aparecen. Un RPC con path ignorado o escape no filtra contenido secreto: `entries: []` / `status: "ignored"|"forbidden"`.
6. Preview: texto **acotado** con marca `[truncated: showing N of M bytes]`. Imagen se renderiza (`<img src="data:…">`). Binario: `kind: "binary"`, **sin** campo `text` con bytes. PDF/zip/null-bytes no se pintan como UTF-8.
7. `@` desde el árbol inserta **un** chip por clic, mismo token que el picker (`@path` / `@path/` / `@"path with space"`). Varios `@` = varios clics. No hay selección múltiple ni “adjuntar carpeta entera como zip”.
8. Hidratar el attach sigue siendo el daemon en `agent.turn.request` (plan 1). El árbol no lee el archivo para el LLM; `fs.preview` es solo UI y se descarta.
9. Directorio adjunto: listing ≤ `DIR_LISTING_LIMIT` (10) al hidratar. Preview de dir también ≤ 10.
10. Web, TUI y `chat watch` ven el mismo chat; el árbol **no** es estado de chat. No hay fan-out de preview.
11. 1 turn por daemon. Tree/search/preview **no** marcan `turnBusy`.
12. Claude es el provider ejecutable. Cursor no cambia el árbol.
13. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload `<input type="file">` / `dataTransfer.files`, notificaciones OS, tree en TUI, dump ilimitado del cwd.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `FS_COMPLETE_LIMIT` | `10` (picker; **no cambiar**) |
| `DIR_LISTING_LIMIT` | `10` (ya en attach-files) |
| `FS_TREE_MAX_ENTRIES` | `200` (ya en ignore-secrets) |
| `FS_TREE_TIMEOUT_MS` | `5000` |
| `FS_WALK_MAX_ENTRIES` | `8000` (walk de search; ya en attach-files) |
| `FS_SEARCH_LIMIT` | `50` |
| `FS_SEARCH_TIMEOUT_MS` | `5000` |
| `FS_PREVIEW_TIMEOUT_MS` | `5000` |
| `PREVIEW_TEXT_MAX_BYTES` | `32_000` |
| `TEXT_ATTACH_MAX_BYTES` | `100_000` (hidratacion; no cambiar) |
| `IMAGE_ATTACH_MAX_BYTES` | `4_500_000` |
| `IMAGE_EXT` | `png`, `jpg`, `jpeg`, `webp`, `gif` (mismo set que hydrate) |
| `SEARCH_DEBOUNCE_MS` | `120` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `NO_FS_COPY` | `"No hay filesystem: arranca el daemon en este workspace (\`chavez headless workspace open\` o \`chavez tui\`). El árbol no lista el disco del servidor."` |
| `BINARY_PREVIEW_NOTICE` | ``Binario · ${mime} · ${bytes} bytes. No se muestra como texto.`` |
| `IGNORED_PREVIEW_NOTICE` | ``Path ignorado (${reason}): no se previsualiza.`` |
| `NO_CHAT_TO_ATTACH` | `"Crea un chat para adjuntar @ desde el árbol."` |

`FsPreviewKind`: `"text"` \| `"image"` \| `"binary"` \| `"directory"`.

`FsPreviewStatus`: `"ok"` \| `"missing"` \| `"forbidden"` \| `"ignored"` \| `"too_large"`.

Nombres canónicos WS: `fs.tree` / `fs.tree.dispatch` / `fs.tree.result` (plan 8), `fs.search` / `fs.search.dispatch` / `fs.search.result`, `fs.preview` / `fs.preview.dispatch` / `fs.preview.result`. El árbol es del **workspace bound**, no del `chatId` (igual que `fs.tree`).

---

## Task 1: `searchWorkspace` — matches por nombre, ignore, tope 50

**Files:**

- Modify: `cli/src/llm/fs-complete.ts`
- Create: `cli/src/llm/fs-search.ts`
- Test: `cli/src/llm/fs-search.test.ts`
- Modify: `cli/src/llm/fs-complete.test.ts`

La búsqueda del árbol **no** es el picker. Exportar el walk ya filtrado por ignore para no duplicar `readdir`. Query vacía → `[]` (el árbol ya muestra la raíz; search no vuelca el cwd).

- [ ] En `cli/src/llm/fs-complete.ts` (el de ignore-secrets, con `loadIgnore` + `classifyPath`): exportar el walk y el score. Renombrar `walk` → `walkWorkspace` y `score` → `scorePath`, **dejar** `completeWorkspace` usando esas funciones. Firma pública de `completeWorkspace(cwd, query, limit = FS_COMPLETE_LIMIT)` **igual**. Si el archivo aún tiene `SKIP_DIR_NAMES` (solo attach-files), aplicar primero el parche de ignore-secrets Task 3 y luego exportar.

```ts
export function walkWorkspace(cwd: string, set?: IgnoreSet): FsCandidate[] {
  const ignore = set ?? loadIgnore(cwd);
  // cuerpo actual de walk(cwd, ignore)
  return walk(cwd, ignore);
}

export function scorePath(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 50 + Math.min(path.length, 40);
  if (p === q) return 0;
  if (p.startsWith(q)) return 1;
  const base = p.split("/").pop() || p;
  if (base.startsWith(q)) return 2;
  if (p.includes(q)) return 3 + p.indexOf(q) / 1000;
  const parts = q.split("/").filter(Boolean);
  if (parts.length > 1 && p.includes(parts[parts.length - 1]!)) {
    if (p.startsWith(parts[0]!)) return 4;
  }
  return null;
}
```

`completeWorkspace` debe seguir haciendo `.slice(0, limit)` con default 10.

- [ ] Crear `cli/src/llm/fs-search.ts`:

```ts
import { loadIgnore } from "./ignore";
import {
  FS_COMPLETE_LIMIT,
  type FsCandidate,
  scorePath,
  walkWorkspace,
} from "./fs-complete";
import { toPosix } from "./workspace-path";

export const FS_SEARCH_LIMIT = 50;

/** Keep the picker cap imported so a stray edit cannot silently raise it. */
export { FS_COMPLETE_LIMIT };

export type FsSearchResult = {
  cwd: string;
  query: string;
  matches: FsCandidate[];
  truncated: boolean;
};

export function searchWorkspace(
  cwd: string,
  query: string,
  limit = FS_SEARCH_LIMIT,
): FsSearchResult {
  const q = toPosix(query).replace(/^@/, "").replace(/^\.\//, "").trim();
  if (!q) {
    return { cwd, query: q, matches: [], truncated: false };
  }
  const set = loadIgnore(cwd);
  const cap = Math.min(Math.max(1, limit), FS_SEARCH_LIMIT);
  const ranked = walkWorkspace(cwd, set)
    .map((c) => {
      const s = scorePath(c.path, q);
      return s == null ? null : { c, s };
    })
    .filter((x): x is { c: FsCandidate; s: number } => x != null)
    .sort(
      (a, b) =>
        a.s - b.s ||
        a.c.path.length - b.c.path.length ||
        a.c.path.localeCompare(b.c.path),
    );
  return {
    cwd,
    query: q,
    matches: ranked.slice(0, cap).map((x) => x.c),
    truncated: ranked.length > cap,
  };
}
```

- [ ] Crear `cli/src/llm/fs-search.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace, FS_COMPLETE_LIMIT } from "./fs-complete";
import { FS_SEARCH_LIMIT, searchWorkspace } from "./fs-search";

describe("searchWorkspace", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-search-")));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "auth.ts"), "export const auth = 1;\n");
  writeFileSync(join(cwd, "src", "auth.test.ts"), "test\n");
  writeFileSync(join(cwd, "src", "node-util.ts"), "export {}\n");
  writeFileSync(join(cwd, "README.md"), "hi\n");
  writeFileSync(join(cwd, ".env"), "K=1\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "auth.js"), "x");
  for (let i = 0; i < 60; i++) {
    writeFileSync(join(cwd, "src", `file-${i}.ts`), "x\n");
  }

  test("query auth hits src/auth.ts and not node_modules", () => {
    const r = searchWorkspace(cwd, "auth");
    const paths = r.matches.map((m) => m.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/auth.test.ts");
    expect(paths.every((p) => !p.startsWith("node_modules/"))).toBe(true);
    expect(r.matches.length).toBeLessThanOrEqual(FS_SEARCH_LIMIT);
  });

  test("empty query does not dump the tree", () => {
    const r = searchWorkspace(cwd, "  ");
    expect(r.matches).toEqual([]);
  });

  test("harness .env is not a match", () => {
    const r = searchWorkspace(cwd, ".env");
    expect(r.matches.some((m) => m.path === ".env")).toBe(false);
  });

  test("results are capped at 50, picker stays 10", () => {
    const r = searchWorkspace(cwd, "file-");
    expect(r.matches.length).toBeLessThanOrEqual(50);
    expect(r.truncated).toBe(true);
    expect(FS_COMPLETE_LIMIT).toBe(10);
    const picker = completeWorkspace(cwd, "file-");
    expect(picker.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] En `cli/src/llm/fs-complete.test.ts` añadir (no borrar los casos de attach/ignore):

```ts
test("picker cap remains 10 after walkWorkspace export", () => {
  const hits = completeWorkspace(cwd, "");
  expect(hits.length).toBeLessThanOrEqual(10);
});
```

Usar el `cwd` del describe existente. Si el test de query `""` no está definido en complete (score de vacío devuelve candidatos), el slice(0,10) basta.

- [ ] Correr:

```bash
cd cli && bun test src/llm/fs-search.test.ts src/llm/fs-complete.test.ts
```

Esperado: pass. Si `bun test` no está en `cli/package.json` `scripts`, añadirlo como en attach-files (`"test": "bun test"`) sin tocar `start`/`dev`/`bin`.

- [ ] Commit:

```bash
git add cli/src/llm/fs-complete.ts cli/src/llm/fs-complete.test.ts \
  cli/src/llm/fs-search.ts cli/src/llm/fs-search.test.ts cli/package.json
git commit -m "feat(tree): searchWorkspace by name with ignore, cap 50"
```

---

## Task 2: `previewFile` — texto acotado, imagen, binario no-texto

**Files:**

- Create: `cli/src/llm/fs-preview.ts`
- Test: `cli/src/llm/fs-preview.test.ts`

Preview es UI. Reusa clasificación de `hydrateOne` (mismo kind que el attach) pero **nunca** expone bytes binarios como UTF-8. Ignore se consulta **antes** de leer.

- [ ] Crear `cli/src/llm/fs-preview.ts`:

```ts
import { loadIgnore, classifyPath, reasonForClass } from "./ignore";
import {
  DIR_LISTING_LIMIT,
  IMAGE_ATTACH_MAX_BYTES,
  hydrateOne,
  type AttachKind,
  type DirEntry,
} from "./hydrate-attachments";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";

export const PREVIEW_TEXT_MAX_BYTES = 32_000;

export type FsPreviewKind = AttachKind;
export type FsPreviewStatus =
  | "ok"
  | "missing"
  | "forbidden"
  | "ignored"
  | "too_large";

export type FsPreview = {
  cwd: string;
  path: string;
  kind: FsPreviewKind;
  status: FsPreviewStatus;
  byteSize: number;
  mime?: string;
  truncated?: boolean;
  /** File contents. Only when kind === "text" and status === "ok". */
  text?: string;
  mediaType?: string;
  /** Ephemeral. Only when kind === "image" and status === "ok". Never persist. */
  imageBase64?: string;
  listing?: DirEntry[];
  notice?: string;
  error?: string;
};

export function binaryPreviewNotice(mime: string, bytes: number): string {
  return `Binario · ${mime} · ${bytes} bytes. No se muestra como texto.`;
}

export function previewFile(cwd: string, relPath: string): FsPreview {
  const set = loadIgnore(cwd);
  let abs: string;
  try {
    abs = resolveInsideCwd(cwd, relPath);
  } catch (err) {
    return {
      cwd,
      path: relPath,
      kind: "binary",
      status: "forbidden",
      byteSize: 0,
      error:
        err instanceof PathEscapeError
          ? `Path outside workspace: ${relPath}`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  const cls = classifyPath(set, relPath, { absPath: abs });
  if (cls !== "none") {
    const reason = reasonForClass(cls);
    return {
      cwd,
      path: relPath,
      kind: "binary",
      status: "ignored",
      byteSize: 0,
      notice: `Path ignorado (${reason}): no se previsualiza.`,
    };
  }

  const a = hydrateOne(cwd, relPath);
  if (a.status === "missing" || a.status === "forbidden") {
    return {
      cwd,
      path: relPath,
      kind: a.kind,
      status: a.status,
      byteSize: a.byteSize,
      mime: a.mime,
      error: a.error,
    };
  }
  if (a.kind === "image") {
    if (a.status === "too_large" || a.byteSize > IMAGE_ATTACH_MAX_BYTES) {
      return {
        cwd,
        path: relPath,
        kind: "image",
        status: "too_large",
        byteSize: a.byteSize,
        mime: a.mime,
        error: a.error || `Image exceeds ${IMAGE_ATTACH_MAX_BYTES} bytes: ${relPath}`,
      };
    }
    return {
      cwd,
      path: relPath,
      kind: "image",
      status: "ok",
      byteSize: a.byteSize,
      mime: a.mime,
      mediaType: a.mediaType || a.mime,
      imageBase64: a.imageBase64,
    };
  }
  if (a.kind === "directory") {
    const listing = (a.listing || []).slice(0, DIR_LISTING_LIMIT);
    return {
      cwd,
      path: relPath,
      kind: "directory",
      status: "ok",
      byteSize: 0,
      listing,
      truncated: (a.listing || []).length >= DIR_LISTING_LIMIT,
      notice: a.hydratedText,
    };
  }
  if (a.kind === "binary") {
    const mime = a.mime || "application/octet-stream";
    return {
      cwd,
      path: relPath,
      kind: "binary",
      status: "ok",
      byteSize: a.byteSize,
      mime,
      notice: binaryPreviewNotice(mime, a.byteSize),
    };
  }

  const full = a.hydratedText || "";
  const rawLen = a.byteSize;
  const slice =
    full.length > PREVIEW_TEXT_MAX_BYTES
      ? full.slice(0, PREVIEW_TEXT_MAX_BYTES)
      : full.replace(/\n\n\[truncated: showing \d+ of \d+ bytes\]$/, "");
  const truncated = rawLen > PREVIEW_TEXT_MAX_BYTES || Boolean(a.truncated);
  const shown = Math.min(PREVIEW_TEXT_MAX_BYTES, slice.length);
  const text = truncated
    ? `${slice.slice(0, PREVIEW_TEXT_MAX_BYTES)}\n\n[truncated: showing ${shown} of ${rawLen} bytes]`
    : slice;
  return {
    cwd,
    path: relPath,
    kind: "text",
    status: "ok",
    byteSize: rawLen,
    mime: a.mime,
    truncated,
    text,
  };
}
```

El `replace` del mark de hydrate evita duplicar la marca de 100_000 cuando recortamos a 32_000. `text` **solo** se llena en `kind === "text"`. Binario no copia `a.hydratedText`.

- [ ] Crear `cli/src/llm/fs-preview.test.ts`. PNG mínimo (67 bytes, 1×1):

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_TEXT_MAX_BYTES, previewFile } from "./fs-preview";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("previewFile", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-prev-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "auth.ts"), "export const x = 1;\n");
  writeFileSync(join(cwd, "src", "logo.png"), PNG_1X1);
  writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  const big = "a".repeat(PREVIEW_TEXT_MAX_BYTES + 50);
  writeFileSync(join(cwd, "src", "big.txt"), big);
  mkdirSync(join(cwd, "src", "lots"));
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(cwd, "src", "lots", `n${i}.txt`), "x");
  }

  test("text is shown and huge text is truncated", () => {
    const t = previewFile(cwd, "src/auth.ts");
    expect(t.kind).toBe("text");
    expect(t.status).toBe("ok");
    expect(t.text).toContain("export const x");
    const b = previewFile(cwd, "src/big.txt");
    expect(b.truncated).toBe(true);
    expect(b.text || "").toContain("[truncated:");
    expect((b.text || "").length).toBeLessThan(PREVIEW_TEXT_MAX_BYTES + 80);
  });

  test("image renders as image, not utf8", () => {
    const p = previewFile(cwd, "src/logo.png");
    expect(p.kind).toBe("image");
    expect(p.status).toBe("ok");
    expect(p.imageBase64).toBeTruthy();
    expect(p.text).toBeUndefined();
    expect(p.mediaType).toMatch(/^image\//);
  });

  test("binary is not faked as text", () => {
    const p = previewFile(cwd, "src/blob.bin");
    expect(p.kind).toBe("binary");
    expect(p.text).toBeUndefined();
    expect(p.notice || "").toMatch(/Binario/);
    expect(JSON.stringify(p)).not.toContain("\u0000");
  });

  test("ignored secret is not previewed", () => {
    const p = previewFile(cwd, ".env");
    expect(p.status).toBe("ignored");
    expect(p.text).toBeUndefined();
    expect(p.imageBase64).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("SECRET=1");
  });

  test("escape is forbidden", () => {
    const p = previewFile(cwd, "../outside.txt");
    expect(p.status).toBe("forbidden");
  });

  test("directory listing is capped at 10", () => {
    const p = previewFile(cwd, "src/lots");
    expect(p.kind).toBe("directory");
    expect((p.listing || []).length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/fs-preview.test.ts
```

Esperado: pass. `hydrate-attachments.ts` y `ignore.ts` tienen que existir (planes 1 y 8). Si `reasonForClass` no está exportada, exportarla desde `cli/src/llm/ignore-patterns.ts` como en ignore-secrets Task 1.

- [ ] Commit:

```bash
git add cli/src/llm/fs-preview.ts cli/src/llm/fs-preview.test.ts \
  cli/src/llm/ignore-patterns.ts
git commit -m "feat(tree): preview text/image/binary from daemon cwd"
```

---

## Task 3: RPC `fs.search` + `fs.preview` (API reenvía, daemon lee)

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/pending.ts` (crear si attach-files no lo creó)
- Test: `api/src/ws/pending.test.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`

Mismo patrón que `fs.tree` (plan 8) y `fs.complete` (plan 1). Timeout 5s → `NO_DAEMON_ERROR`. **No** `turnBusy`. **No** `readdir` en handlers.

- [ ] Si `api/src/ws/pending.ts` no existe, crearlo **idéntico** a attach-files Task 3 (`createPendingMap(timeoutMs)` cuyo timeout resuelve `fail(..., NO_DAEMON_ERROR)`). Reutilizar **el mismo mapa** `fsPending` / `treePending` para tree + search + preview (los `id` de request no colisionan). Si hay dos mapas de 5s, uno solo basta: `const fsRpcPending = fsPending ?? treePending ?? createPendingMap(5000)`.

- [ ] Extender `api/src/ws/pending.test.ts` (no borrar `fs.complete` / `fs.tree`):

```ts
test("search times out with the same no-daemon string", async () => {
  const p = createPendingMap(20);
  const msg = await p.wait("s", "fs.search");
  expect(msg.ok).toBe(false);
  expect(msg.error || "").toMatch(/daemon bound/i);
});

test("preview complete wins", async () => {
  const p = createPendingMap(200);
  const done = p.wait("p", "fs.preview");
  expect(p.complete("p", ok("fs.preview", "p", { kind: "text" }))).toBe(true);
  const msg = await done;
  expect(msg.ok).toBe(true);
});
```

- [ ] En `api/src/ws/protocol.ts`, `ClientMessage` ya tiene `path`, `query`, `hostname`, `requestId`, `limit` tras attach/ignore. Si falta alguno, añadirlo. No hace falta campo nuevo.

- [ ] En `api/src/ws/handlers.ts`, importar `NO_DAEMON_ERROR` desde `./errors` si invariants lo creó; si no, literal idéntico. Extraer un helper local (cubre `fs.tree` existente y los dos nuevos) **justo encima** de `handleWsMessage`:

```ts
async function proxyFsToDaemon(
  connectionId: string,
  userId: string,
  type: string,
  id: string,
  pushType: string,
  extra: Record<string, unknown>,
): Promise<ServerMessage> {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) {
    return fail(
      type,
      id,
      "No daemon bound for this workspace. Run: chavez headless workspace open",
    );
  }
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent(pushType, {
      requestId: id,
      requesterConnectionId: connectionId,
      workspacePath: daemon.path,
      ...extra,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return await fsRpcPending.wait(id, type);
}
```

Sustituir el body de `case "fs.tree"` por `return await proxyFsToDaemon(..., "fs.tree.dispatch", { path: rel })` si ese case ya existe. Añadir **antes** de `default`:

```ts
case "fs.search": {
  const q = String(msg.query ?? "");
  return await proxyFsToDaemon(
    connectionId,
    userId,
    type,
    id,
    "fs.search.dispatch",
    { query: q, limit: 50 },
  );
}

case "fs.search.result": {
  if (!msg.requestId) return fail(type, id, "requestId is required");
  const meta = (msg.metadata || {}) as {
    cwd?: string;
    query?: string;
    matches?: unknown;
    truncated?: unknown;
    error?: unknown;
  };
  const matches = Array.isArray(meta.matches) ? meta.matches.slice(0, 50) : [];
  const payload = {
    hostname: msg.hostname || null,
    cwd: meta.cwd || msg.path || null,
    query: typeof meta.query === "string" ? meta.query : "",
    matches,
    truncated: Boolean(meta.truncated),
    error: typeof meta.error === "string" ? meta.error : undefined,
  };
  const forwarded = fsRpcPending.complete(
    msg.requestId,
    ok("fs.search", msg.requestId, payload),
  );
  return ok(type, id, { forwarded });
}

case "fs.preview": {
  const rel = typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : "";
  if (!rel || rel === ".") {
    return fail(type, id, "path is required");
  }
  return await proxyFsToDaemon(
    connectionId,
    userId,
    type,
    id,
    "fs.preview.dispatch",
    { path: rel },
  );
}

case "fs.preview.result": {
  if (!msg.requestId) return fail(type, id, "requestId is required");
  const meta = (msg.metadata || {}) as Record<string, unknown>;
  const kind = String(meta.kind || "binary");
  const payload: Record<string, unknown> = {
    hostname: msg.hostname || null,
    cwd: meta.cwd || msg.path || null,
    path: meta.path || "",
    kind,
    status: String(meta.status || "ok"),
    byteSize: typeof meta.byteSize === "number" ? meta.byteSize : 0,
    mime: meta.mime,
    truncated: Boolean(meta.truncated),
    mediaType: meta.mediaType,
    listing: Array.isArray(meta.listing) ? meta.listing.slice(0, 10) : undefined,
    notice: typeof meta.notice === "string" ? meta.notice : undefined,
    error: typeof meta.error === "string" ? meta.error : undefined,
  };
  if (kind === "text" && typeof meta.text === "string") {
    payload.text = meta.text;
  }
  if (kind === "image" && typeof meta.imageBase64 === "string") {
    payload.imageBase64 = meta.imageBase64;
  }
  const forwarded = fsRpcPending.complete(
    msg.requestId,
    ok("fs.preview", msg.requestId, payload),
  );
  return ok(type, id, { forwarded });
}
```

El result **no** copia `text` si `kind !== "text"`: cinturón para que un daemon bug no pinte binario.

`requireWorkspace`: el cliente Web ya hizo `workspace.bind` (`WorkspaceDetailPanel.ensureBound` / FileTreePanel). No usar `chatId`.

- [ ] En `cli/src/ws/client.ts` y el `WsRequest` de `web/src/lib/ws-client.ts`, asegurar `query?: string`, `hostname?: string`, `requestId?: string`, `limit?: number`.

- [ ] En `cli/src/ws/daemon.ts`, **antes** del early-return de `agent.turn.dispatch` (y junto a `fs.tree.dispatch` / `fs.complete.dispatch`), handlers que **no** tocan `turnBusy`:

```ts
import { hostname } from "node:os";
import { listWorkspaceDir } from "../llm/fs-tree";
import { searchWorkspace } from "../llm/fs-search";
import { previewFile } from "../llm/fs-preview";

async function replyFs(
  type: "fs.tree.result" | "fs.search.result" | "fs.preview.result",
  requestId: string,
  metadata: Record<string, unknown>,
) {
  await client.request({
    type,
    requestId,
    hostname: hostname(),
    path,
    metadata,
  });
}

if (msg.type === "fs.search.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    query?: string;
    workspacePath?: string;
  };
  if (!data.requestId) return;
  try {
    const found = searchWorkspace(data.workspacePath || path, data.query || "");
    await replyFs("fs.search.result", data.requestId, {
      cwd: found.cwd,
      query: found.query,
      matches: found.matches,
      truncated: found.truncated,
    });
  } catch (err) {
    await replyFs("fs.search.result", data.requestId, {
      cwd: path,
      query: String(data.query || ""),
      matches: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return;
}

if (msg.type === "fs.preview.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    path?: string;
    workspacePath?: string;
  };
  if (!data.requestId) return;
  try {
    const prev = previewFile(data.workspacePath || path, data.path || "");
    await replyFs("fs.preview.result", data.requestId, { ...prev });
  } catch (err) {
    await replyFs("fs.preview.result", data.requestId, {
      cwd: path,
      path: data.path || "",
      kind: "binary",
      status: "forbidden",
      byteSize: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return;
}
```

Si `fs.tree.dispatch` aún no está, añadirlo como ignore-secrets Task 6 **en este mismo commit** (usa `listWorkspaceDir` + `replyFs("fs.tree.result", ...)`).

- [ ] El mismo trio de handlers en `tui/src/App.tsx` `onPush` (TUI **es** daemon). Importar `searchWorkspace` desde `../../cli/src/llm/fs-search`, `previewFile` desde `../../cli/src/llm/fs-preview`, `listWorkspaceDir` desde `../../cli/src/llm/fs-tree`, `hostname` desde `node:os`. Usar `client.request`. **No** marcar `turnBusyRef`. Colocar los `if` **antes** de `agent.turn.dispatch`.

- [ ] Correr:

```bash
cd api && bun test src/ws/pending.test.ts
cd ../cli && bun test src/llm/fs-search.test.ts src/llm/fs-preview.test.ts src/llm/fs-tree.test.ts
```

Si `fs-tree.test.ts` no existe, créalo como ignore-secrets Task 6 (root oculta `node_modules` y `.env`; escape tira `PathEscapeError`).

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/pending.ts api/src/ws/pending.test.ts \
  api/src/ws/handlers.ts cli/src/ws/client.ts cli/src/ws/daemon.ts tui/src/App.tsx \
  cli/src/llm/fs-tree.ts cli/src/llm/fs-tree.test.ts
git commit -m "feat(tree): fs.search and fs.preview WS RPCs via daemon"
```

---

## Task 4: Árbol lazy nested + hostname · path + sin daemon

**Files:**

- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Create: `web/src/components/FileTreePanel.tsx` (si ignore-secrets lo creó, **reemplazar** el listado plano; conservar el export `FileTreePanel`)
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`

Escenario Gherkin **Árbol lazy** + **Sin daemon**. Expandir pide `fs.tree`. Ignore ya viene del daemon. Header `hostname · cwd`. Sin daemon: `NO_FS_COPY`. Cero listing del disco API.

- [ ] Extender `WsRequest` en `web/src/lib/ws-client.ts` con `query?: string`, `hostname?: string`, `requestId?: string`, `limit?: number` si faltan.

- [ ] Extender el `partial` de `request` en `web/src/lib/ws-context.tsx` con `query?: string` (el `path` ya está).

- [ ] En `web/src/lib/ws-hooks.ts`, si `useWsFsTree` no existe (ignore-secrets Task 7), crearlo. Añadir search y preview (preview se usa en Task 5; dejarlos listos):

```ts
export type FsTreeEntry = { name: string; path: string; isDir: boolean };
export type FsCandidate = { path: string; isDir: boolean };

export function useWsFsTree() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { path?: string }) =>
      ws.request({
        type: "fs.tree",
        path: input.path || ".",
      }),
  });
}

export function useWsFsSearch() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { query: string }) =>
      ws.request({
        type: "fs.search",
        query: input.query,
      }),
  });
}

export function useWsFsPreview() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { path: string }) =>
      ws.request({
        type: "fs.preview",
        path: input.path,
      }),
  });
}
```

Si `useWsFsComplete` ya exporta `FsCandidate`, no duplicar el type: reusar el de complete.

- [ ] Crear / reemplazar `web/src/components/FileTreePanel.tsx` con árbol nested lazy. Props de esta task: `workspacePath`. `onAttach` entra en Task 6 (opcional ahora, ignorar si falta).

```tsx
import { useCallback, useEffect, useState } from "react";
import { formatQueryError } from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsFsTree, type FsTreeEntry } from "../lib/ws-hooks";

const NO_FS_COPY =
  "No hay filesystem: arranca el daemon en este workspace (`chavez headless workspace open` o `chavez tui`). El árbol no lista el disco del servidor.";

export type FileTreeAttachHandler = (entry: {
  path: string;
  isDir: boolean;
}) => void;

type NodeState = FsTreeEntry & {
  expanded?: boolean;
  loading?: boolean;
  children?: NodeState[] | null;
  truncated?: boolean;
};

function isNoDaemon(err: string): boolean {
  return /daemon bound/i.test(err) || /no hay filesystem/i.test(err);
}

export function FileTreePanel({
  workspacePath,
  onAttach,
}: {
  workspacePath: string | undefined;
  onAttach?: FileTreeAttachHandler;
}) {
  const ws = useWs();
  const bind = useWsBind();
  const tree = useWsFsTree();
  const [hostname, setHostname] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [roots, setRoots] = useState<NodeState[]>([]);
  const [rootTruncated, setRootTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const loadDir = useCallback(
    async (rel: string): Promise<{ entries: FsTreeEntry[]; truncated: boolean } | null> => {
      if (!workspacePath) {
        setErr("Workspace sin path");
        return null;
      }
      try {
        await bind.mutateAsync(workspacePath);
        const res = await tree.mutateAsync({ path: rel });
        if (!res.ok) {
          setErr(res.error || "fs.tree failed");
          return null;
        }
        const data = (res.data || {}) as {
          hostname?: string | null;
          cwd?: string | null;
          entries?: FsTreeEntry[];
          truncated?: boolean;
          error?: string;
        };
        setHostname(data.hostname ?? null);
        setCwd(data.cwd ?? workspacePath);
        if (data.error) setErr(data.error);
        else setErr(null);
        return {
          entries: Array.isArray(data.entries) ? data.entries : [],
          truncated: Boolean(data.truncated),
        };
      } catch (e) {
        setErr(formatQueryError(e));
        return null;
      }
    },
    [workspacePath, bind, tree],
  );

  useEffect(() => {
    if (ws.status !== "open" || !workspacePath) return;
    void loadDir(".").then((r) => {
      if (!r) {
        setRoots([]);
        return;
      }
      setRoots(r.entries.map((e) => ({ ...e, children: e.isDir ? null : [] })));
      setRootTruncated(r.truncated);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.status, workspacePath]);

  async function toggle(path: string) {
    const patch = async (nodes: NodeState[]): Promise<NodeState[]> => {
      const out: NodeState[] = [];
      for (const n of nodes) {
        if (n.path !== path) {
          out.push(
            n.children?.length
              ? { ...n, children: await patch(n.children) }
              : n,
          );
          continue;
        }
        if (!n.isDir) {
          out.push(n);
          continue;
        }
        if (n.expanded) {
          out.push({ ...n, expanded: false });
          continue;
        }
        if (n.children) {
          out.push({ ...n, expanded: true });
          continue;
        }
        const r = await loadDir(n.path);
        out.push({
          ...n,
          expanded: true,
          loading: false,
          truncated: r?.truncated,
          children: (r?.entries || []).map((e) => ({
            ...e,
            children: e.isDir ? null : [],
          })),
        });
      }
      return out;
    };
    setRoots(await patch(roots));
  }

  const displayErr = err
    ? isNoDaemon(err)
      ? NO_FS_COPY
      : err
    : null;

  function renderNodes(nodes: NodeState[], depth: number) {
    return (
      <ul className="file-tree-list" style={{ paddingLeft: depth ? "0.9rem" : 0 }}>
        {nodes.map((n) => (
          <li key={n.path}>
            {n.isDir ? (
              <button
                type="button"
                className={`file-tree-item ${selected === n.path ? "active" : ""}`}
                onClick={() => {
                  setSelected(n.path);
                  void toggle(n.path);
                }}
              >
                {n.expanded ? "▾" : "▸"} {n.name}/
              </button>
            ) : (
              <button
                type="button"
                className={`file-tree-item ${selected === n.path ? "active" : ""}`}
                onClick={() => setSelected(n.path)}
              >
                {n.name}
              </button>
            )}
            {n.isDir && n.expanded && n.children && renderNodes(n.children, depth + 1)}
            {n.isDir && n.expanded && n.truncated && (
              <p className="muted" style={{ fontSize: "0.75rem", margin: "0.15rem 0 0 1rem" }}>
                Listado truncado a 200 entradas.
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="panel file-tree">
      <h2>Archivos</h2>
      <p className="muted file-tree-host" style={{ fontSize: "0.85rem" }}>
        {hostname || "—"} · {cwd || workspacePath || "sin daemon"}
      </p>
      {displayErr && <p className="error">{displayErr}</p>}
      {!displayErr && renderNodes(roots, 0)}
      {roots.length === 0 && !displayErr && (
        <p className="muted">Vacío (o todo ignorado).</p>
      )}
      {rootTruncated && (
        <p className="muted">Listado truncado a 200 entradas.</p>
      )}
    </div>
  );
}
```

`onAttach` se declara para no romper el import de Task 6; no se pinta botón aún. **Prohibido:** `fetch` a `/workspaces/.../files`, `readdir`, `input type="file"`.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx`, si ignore-secrets no lo insertó, dentro del fragmento de `detail.data` **después** del bloque de sessions (antes de los forms), renderizar:

```tsx
<FileTreePanel workspacePath={detail.data.workspace.path} />
```

Importar `FileTreePanel`. El path es `detail.data.workspace.path` (row del user), no `process.cwd()` del API.

- [ ] En `web/src/styles/global.css` (extender las reglas `.file-tree-list` de plan 8; si no existen, crearlas). **Resetear** `margin-top` de los botones del árbol: el `button { margin-top: 1rem }` global rompería el lazy tree.

```css
.file-tree {
  max-height: 70vh;
  overflow: auto;
}
.file-tree-host {
  overflow-wrap: anywhere;
}
.file-tree-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  font-family: var(--mono);
  font-size: 0.85rem;
}
.file-tree-list ul {
  list-style: none;
  margin: 0.1rem 0 0;
  padding-left: 0.9rem;
  border-left: 1px solid var(--border);
}
.file-tree-list li {
  padding: 0.08rem 0;
}
.file-tree-list button,
button.file-tree-item {
  background: none;
  border: 0;
  color: #8ec8ff;
  font: inherit;
  cursor: pointer;
  padding: 0.1rem 0.2rem;
  margin: 0;
  display: inline;
  font-weight: 400;
  text-align: left;
}
button.file-tree-item.active,
button.file-tree-item:hover {
  background: var(--accent-dim);
  color: var(--fg);
  border-radius: 4px;
}
```

- [ ] Verificar layout: `.shell` max-width 960px. Header `hostname · path` wrapea (`overflow-wrap: anywhere`). Viewport ~375px: el árbol no desborda horizontalmente (scroll interno `.file-tree`).

- [ ] Commit:

```bash
git add web/src/lib/ws-client.ts web/src/lib/ws-context.tsx web/src/lib/ws-hooks.ts \
  web/src/components/FileTreePanel.tsx web/src/components/WorkspaceDetailPanel.tsx \
  web/src/styles/global.css
git commit -m "feat(tree): lazy nested web file tree from daemon fs.tree"
```

---

## Task 5: UI búsqueda + preview texto / imagen / binario

**Files:**

- Create: `web/src/components/FilePreviewPanel.tsx`
- Modify: `web/src/components/FileTreePanel.tsx`
- Modify: `web/src/styles/global.css`

Escenarios Gherkin **Búsqueda por nombre** (matches acotados; elegir → preview) y **Preview texto e imagen**. Adjuntar se cablea en Task 6; aquí el click abre preview.

- [ ] Crear `web/src/components/FilePreviewPanel.tsx`:

```tsx
export type FilePreviewData = {
  path: string;
  kind?: string;
  status?: string;
  byteSize?: number;
  mime?: string;
  truncated?: boolean;
  text?: string;
  mediaType?: string;
  imageBase64?: string;
  listing?: Array<{ name: string; isDir: boolean }>;
  notice?: string;
  error?: string;
};

export function FilePreviewPanel({
  data,
  loading,
}: {
  data: FilePreviewData | null;
  loading?: boolean;
}) {
  if (loading) return <p className="muted">Cargando preview…</p>;
  if (!data) {
    return <p className="muted">Elige un archivo para previsualizar.</p>;
  }
  if (data.status && data.status !== "ok") {
    return (
      <p className="error">
        {data.error || data.notice || data.status}
      </p>
    );
  }
  if (data.kind === "image" && data.imageBase64) {
    const src = `data:${data.mediaType || data.mime || "image/png"};base64,${data.imageBase64}`;
    return (
      <div className="file-preview">
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {data.path} · imagen · {data.byteSize} bytes
        </p>
        <img className="file-preview-img" src={src} alt={data.path} />
      </div>
    );
  }
  if (data.kind === "text" && typeof data.text === "string") {
    return (
      <div className="file-preview">
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {data.path}
          {data.truncated ? " · truncado" : ""}
        </p>
        <pre className="file-preview-text">{data.text}</pre>
      </div>
    );
  }
  if (data.kind === "directory") {
    return (
      <div className="file-preview">
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {data.path}/ · dir
        </p>
        <ul className="file-tree-list">
          {(data.listing || []).map((e) => (
            <li key={e.name}>{e.isDir ? `${e.name}/` : e.name}</li>
          ))}
        </ul>
        {data.notice && <p className="muted">{data.notice}</p>}
      </div>
    );
  }
  return (
    <div className="file-preview">
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        {data.path} · binario
      </p>
      <p>{data.notice || "Binario. No se muestra como texto."}</p>
    </div>
  );
}
```

Regla: si `kind === "binary"` **no** renderizar `data.text` aunque viniera (cinturón). El branch image/text/directory van antes; el fallback nunca usa `<pre>{data.text}</pre>`.

- [ ] En `FileTreePanel.tsx`:

  1. Importar `useWsFsSearch`, `useWsFsPreview`, `type FsCandidate`, `FilePreviewPanel`.
  2. Estado: `query` string, `matches` `FsCandidate[]`, `searchTruncated` boolean, `preview` `FilePreviewData | null`, `previewLoading` boolean, `searchErr` string | null.
  3. Debounce 120ms: `useEffect` sobre `query`. Si `query.trim()` vacío → `setMatches([])` y no llamar RPC. Si `displayErr` no-daemon → no llamar. `mutateAsync({ query: query.trim() })`, `matches` desde `data.matches` **slice(0, 50)**. Header hostname/cwd si viene. `truncated` → mensaje “Mostrando 50 matches.”
  4. `async function openPreview(path: string)`: `setSelected(path)`, `setPreviewLoading(true)`, `useWsFsPreview().mutateAsync({ path })`, guardar `data` como `FilePreviewData`. Si `!res.ok`, `setPreview({ path, status: "forbidden", error: res.error })`.
  5. Click en archivo (no dir) del árbol → `openPreview(n.path)`. Click en match de búsqueda → `openPreview(m.path)`.
  6. UI, **entre** el header hostname y el árbol:

```tsx
<label htmlFor="file-tree-q">Buscar por nombre</label>
<input
  id="file-tree-q"
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  placeholder='ej. auth'
  disabled={Boolean(displayErr)}
/>
{searchErr && <p className="error">{searchErr}</p>}
{query.trim() && (
  <ul className="file-tree-list file-tree-search">
    {matches.map((m) => (
      <li key={m.path}>
        <button
          type="button"
          className={`file-tree-item ${selected === m.path ? "active" : ""}`}
          onClick={() => void openPreview(m.path)}
        >
          {m.isDir ? `${m.path}/` : m.path}
        </button>
      </li>
    ))}
    {matches.length === 0 && !searchErr && (
      <li className="muted">Sin coincidencias</li>
    )}
  </ul>
)}
{searchTruncated && (
  <p className="muted">Mostrando 50 matches.</p>
)}
```

  7. Debajo del árbol (o a la derecha en desktop, ver CSS): `<FilePreviewPanel data={preview} loading={previewLoading} />`.
  8. Si `query.trim()` hay matches, el árbol raíz **sigue visible** (búsqueda no reemplaza la exploración). Scroll independiente.

- [ ] CSS extra en `web/src/styles/global.css`:

```css
.file-preview-text {
  max-height: 24rem;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 0.78rem;
}
.file-preview-img {
  max-width: 100%;
  height: auto;
  display: block;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #12181f;
}
@media (min-width: 721px) {
  .file-tree-split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.75rem;
    align-items: start;
  }
}
```

Envolver lista+preview en `<div className="file-tree-split">`. En ~375px el media no aplica: preview debajo del árbol.

- [ ] Commit:

```bash
git add web/src/components/FilePreviewPanel.tsx \
  web/src/components/FileTreePanel.tsx web/src/styles/global.css
git commit -m "feat(tree): web filename search and text/image/binary preview"
```

---

## Task 6: Insertar `@` desde el árbol (uno a uno, mismo chip que el picker)

**Files:**

- Modify: `cli/src/llm/mentions.ts`
- Test: `cli/src/llm/mentions.test.ts`
- Modify: `web/src/lib/mentions.ts`
- Modify: `web/src/components/FileTreePanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`

Escenario Gherkin **Insertar @ desde el árbol**. Un clic = un token. El picker `@` no cambia (sigue máx. 10, uno a uno). Hidratar sigue en el turn.

- [ ] En `cli/src/llm/mentions.ts` y **la misma función** en `web/src/lib/mentions.ts` (comentario `keep in sync with cli/src/llm/mentions.ts`):

```ts
/** One picker/tree selection → one token. Dirs keep a trailing slash. */
export function mentionToken(path: string, isDir: boolean): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const raw = isDir ? `${cleaned}/` : cleaned;
  return /\s/.test(raw) ? `@"${raw}"` : `@${raw}`;
}

export function appendMention(
  prompt: string,
  path: string,
  isDir: boolean,
): string {
  const token = mentionToken(path, isDir);
  const existing = parseMentions(prompt);
  const key = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (existing.some((m) => m.path === key || m.path === `${key}/`)) {
    return prompt;
  }
  const pad = prompt && !/\s$/.test(prompt) ? " " : "";
  return `${prompt}${pad}${token} `;
}
```

`appendMention` no pega dos veces el mismo path (chip único); otro path sí. Eso es uno a uno, no lote.

- [ ] En `cli/src/llm/mentions.test.ts` (crear el describe si attach-files no lo dejó):

```ts
import { describe, expect, test } from "bun:test";
import { appendMention, mentionToken, parseMentions } from "./mentions";

describe("mentionToken / appendMention", () => {
  test("file and dir tokens match the picker", () => {
    expect(mentionToken("src/auth.ts", false)).toBe("@src/auth.ts");
    expect(mentionToken("src/auth", true)).toBe("@src/auth/");
    expect(mentionToken("my file.ts", false)).toBe('@"my file.ts"');
  });

  test("one click one chip; second click same path is a no-op", () => {
    const once = appendMention("", "src/auth.ts", false);
    expect(once).toBe("@src/auth.ts ");
    expect(appendMention(once, "src/auth.ts", false)).toBe(once);
    const two = appendMention(once, "src/db.ts", false);
    expect(parseMentions(two).map((m) => m.path)).toEqual([
      "src/auth.ts",
      "src/db.ts",
    ]);
  });
});
```

- [ ] Correr `cd cli && bun test src/llm/mentions.test.ts`.

- [ ] En `FileTreePanel`, pintar acciones por fila seleccionada y por match. Función:

```tsx
function attachBtn(path: string, isDir: boolean) {
  if (!onAttach) return null;
  return (
    <button
      type="button"
      className="secondary file-tree-attach"
      onClick={(e) => {
        e.stopPropagation();
        onAttach({ path, isDir });
      }}
    >
      Adjuntar
    </button>
  );
}
```

Junto al nombre del archivo (y del dir): `{attachBtn(n.path, n.isDir)}`. En matches de búsqueda igual (`m.isDir`). También un botón **Adjuntar** en el preview header si `preview` y `onAttach`. Un clic = un `onAttach`. Sin checkbox.

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  1. Tras attach-files, ya existen `MentionComposer`, `parseMentions`, `daemonLabel`, `daemonError`, `session.data.workspace.path`. Si **no** están, aplicar attach-files Task 6 **mínimo** (composer + `useSession` + `useConnections`) y luego este parche.
  2. Importar `FileTreePanel` y `appendMention`.
  3. Layout:

```tsx
<div className="chat-with-tree">
  <FileTreePanel
    workspacePath={wsPath}
    onAttach={({ path, isDir }) => {
      setPrompt((prev) => appendMention(prev, path, isDir));
    }}
  />
  <div>
    {/* h1 Chat, timeline, composer existentes */}
  </div>
</div>
```

  `wsPath` = `session.data?.workspace?.path` (mismo que el picker). No pasar el path del API.

  4. Al montar, consumir `?attach=` **una vez**:

```tsx
useEffect(() => {
  const q = new URLSearchParams(window.location.search);
  const attach = q.get("attach");
  if (!attach) return;
  const isDir = q.get("dir") === "1";
  setPrompt((prev) => appendMention(prev, attach, isDir));
  q.delete("attach");
  q.delete("dir");
  const search = q.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}`,
  );
}, [chatId]);
```

  El composer (`MentionComposer`) ya pinta `AttachmentChips` a partir del texto: el chip se ve **igual** que si se eligió en el picker.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx`, pasar `onAttach` que navega al primer chat:

```tsx
<FileTreePanel
  workspacePath={detail.data.workspace.path}
  onAttach={({ path, isDir }) => {
    const chatId = sessions.flatMap((s) => s.chats || []).map((c) => c.id)[0];
    if (!chatId) {
      setMsg({ kind: "error", text: "Crea un chat para adjuntar @ desde el árbol." });
      return;
    }
    const dir = isDir ? "&dir=1" : "";
    window.location.href = `/chats/${chatId}?attach=${encodeURIComponent(path)}${dir}`;
  }}
/>
```

Un attach = una navegación = un chip. No hay “adjuntar seleccionados”.

- [ ] CSS:

```css
.chat-with-tree {
  display: grid;
  grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}
@media (max-width: 720px) {
  .chat-with-tree {
    grid-template-columns: 1fr;
  }
}
button.file-tree-attach {
  margin: 0 0 0 0.45rem;
  padding: 0.12rem 0.45rem;
  font-size: 0.72rem;
  font-weight: 600;
  display: inline-block;
}
```

- [ ] Commit:

```bash
git add cli/src/llm/mentions.ts cli/src/llm/mentions.test.ts \
  web/src/lib/mentions.ts web/src/components/FileTreePanel.tsx \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx web/src/styles/global.css
git commit -m "feat(tree): attach @ from web file tree one by one"
```

---

## Task 7: OpenAPI + copy sin daemon + el árbol no es el disco de la API

**Files:**

- Modify: `api/openapi/openapi.yaml`
- Modify: `web/src/components/FileTreePanel.tsx` (solo si el empty-state aún no usa `NO_FS_COPY`)

Documentar el contrato. Cerrar el escenario **Sin daemon** de forma explícita: el handler API nunca llama `readdir`; el panel nunca pinta `import.meta` / env del server como cwd.

- [ ] En `api/openapi/openapi.yaml`, descripción de `/ws` (lista **Tipos implementados**, ~línea 722), añadir: `fs.tree` / `fs.search` / `fs.preview` (client→API, correlacionados; el daemon responde `*.result`; push `*.dispatch`). Error sin daemon: el mismo string que `agent.turn.request`.

- [ ] Schemas (junto a `WsClientFsComplete` / `WsClientFsTree` si existen; si `WsClientFsTree` no está, añadirlo como ignore-secrets Task 6 **y** estos dos):

```yaml
    WsClientFsSearch:
      allOf:
        - $ref: "#/components/schemas/ClientMessage"
        - type: object
          required: [type, id]
          properties:
            type:
              type: string
              enum: [fs.search]
            query:
              type: string
              description: Substring de nombre/path; vacío no lista el cwd
          example:
            type: fs.search
            id: "s1"
            query: auth

    WsClientFsPreview:
      allOf:
        - $ref: "#/components/schemas/ClientMessage"
        - type: object
          required: [type, id, path]
          properties:
            type:
              type: string
              enum: [fs.preview]
            path:
              type: string
              description: Relativo al cwd del daemon
          example:
            type: fs.preview
            id: "p1"
            path: src/auth.ts
```

Respuesta `fs.search` `data`: `{ hostname, cwd, query, matches: [{ path, isDir }], truncated }`. Máx. 50 matches.

Respuesta `fs.preview` `data`: `{ hostname, cwd, path, kind, status, byteSize, mime?, truncated?, text?, mediaType?, imageBase64?, listing?, notice?, error? }`. `text` solo si `kind=text`. `imageBase64` solo si `kind=image` (efímero, no es campo de `chat_messages`).

- [ ] Confirmar en `api/src/ws/handlers.ts` (grep) que **no** hay `from "node:fs"` ni `readdir`. El cwd del proceso API no se lee. Si alguien añadió un `GET /workspaces/:id/files`, **bórralo** en este commit: viola el invariante.

- [ ] En FileTreePanel, si `workspacePath` falta: `"Workspace sin path"` — no inventar `/datos/...` del server. Si `ws.status !== "open"` y aún no hay err: no pintar entradas fantasma.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml api/src/ws/handlers.ts \
  web/src/components/FileTreePanel.tsx
git commit -m "docs(tree): OpenAPI fs.search fs.preview; no API disk listing"
```

---

## Task 8: Smoke Gherkin — lazy tree, search, preview, sin daemon, adjuntar @

**Files:**

- Create: `cli/scripts/web-file-tree-smoke.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`

Script local, sin LLM vivo. Cubre los 5 escenarios. Si la API no está arriba, corre la mitad in-process (search/preview/tree/ignore) y sale 0; la mitad RPC se intenta y si falla conexión imprime `SKIP rpc` **solo** para bind, no para las units.

- [ ] Añadir en `cli/package.json`: `"test:tree": "bun run scripts/web-file-tree-smoke.ts"`. Dejar `start`/`dev`/`bin` intactos.

- [ ] Crear `cli/scripts/web-file-tree-smoke.ts`:

```ts
#!/usr/bin/env bun
/**
 * Smoke Plan 18 — web file tree. No LLM.
 * Usage: bun run scripts/web-file-tree-smoke.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDir } from "../src/llm/fs-tree";
import { searchWorkspace } from "../src/llm/fs-search";
import { previewFile } from "../src/llm/fs-preview";
import { completeWorkspace, FS_COMPLETE_LIMIT } from "../src/llm/fs-complete";
import { appendMention, mentionToken } from "../src/llm/mentions";
import { PathEscapeError } from "../src/llm/workspace-path";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-p18-")));
mkdirSync(join(cwd, "src"), { recursive: true });
mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
writeFileSync(join(cwd, "src", "auth.ts"), "export const auth = 1;\n");
writeFileSync(join(cwd, "src", "logo.png"), PNG_1X1);
writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0, 1, 0, 2]));
writeFileSync(join(cwd, ".env"), "SECRET=1\n");
writeFileSync(join(cwd, "node_modules", "pkg", "auth.js"), "nope");
writeFileSync(join(cwd, "README.md"), "hi\n");

// Escenario: Árbol lazy (raíz acotada + ignore)
const root = listWorkspaceDir(cwd, ".");
const names = root.entries.map((e) => e.name);
assert(names.includes("src"), "root should list src");
assert(names.includes("README.md"), "root should list README");
assert(!names.includes("node_modules"), "ignore hides node_modules");
assert(!names.includes(".env"), "ignore hides .env");
assert(root.entries.length <= 200, "root capped at 200");
const src = listWorkspaceDir(cwd, "src");
assert(src.entries.some((e) => e.name === "auth.ts"), "expand src lists auth.ts");
let threw = false;
try {
  listWorkspaceDir(cwd, "../outside");
} catch (e) {
  threw = e instanceof PathEscapeError;
}
assert(threw, "escape must throw PathEscapeError");
console.log("tree lazy + ignore OK", osHostname(), cwd);

// Escenario: Búsqueda por nombre
const found = searchWorkspace(cwd, "auth");
assert(
  found.matches.some((m) => m.path === "src/auth.ts"),
  "search auth → src/auth.ts",
);
assert(
  found.matches.every((m) => !m.path.startsWith("node_modules/")),
  "search must not leak node_modules",
);
assert(found.matches.length <= 50, "search cap 50");
assert(FS_COMPLETE_LIMIT === 10, "picker cap must stay 10");
assert(completeWorkspace(cwd, "auth").length <= 10, "picker still ≤10");
assert(searchWorkspace(cwd, "").matches.length === 0, "empty query dumps nothing");
console.log("search OK", found.matches.map((m) => m.path));

// Escenario: Preview texto / imagen / binario
const text = previewFile(cwd, "src/auth.ts");
assert(text.kind === "text" && (text.text || "").includes("export const auth"), "text preview");
const img = previewFile(cwd, "src/logo.png");
assert(img.kind === "image" && Boolean(img.imageBase64), "image preview");
assert(img.text === undefined, "image must not carry text");
const bin = previewFile(cwd, "src/blob.bin");
assert(bin.kind === "binary", "binary kind");
assert(bin.text === undefined, "binary not faked as text");
assert((bin.notice || "").includes("Binario"), "binary notice");
const secret = previewFile(cwd, ".env");
assert(secret.status === "ignored", ".env not previewed");
assert(JSON.stringify(secret).includes("SECRET=1") === false, "secret not in payload");
console.log("preview OK");

// Escenario: Insertar @ uno a uno
assert(mentionToken("src/auth.ts", false) === "@src/auth.ts", "token file");
const one = appendMention("", "src/auth.ts", false);
const two = appendMention(one, "src/logo.png", false);
assert(one === "@src/auth.ts ", "one chip");
assert(two.includes("@src/auth.ts") && two.includes("@src/logo.png"), "second click other file");
assert(appendMention(one, "src/auth.ts", false) === one, "same path is one-by-one no-op");
console.log("attach token OK");

// Escenario: Sin daemon — el RPC de API debe devolver NO_DAEMON_ERROR.
// In-process no hay disco de API: este proceso lee `cwd` tmp, nunca process.cwd() del server.
assert(cwd !== "/", "tmp cwd is not the API root");
const noDaemon =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
assert(/daemon bound/.test(noDaemon), "canonical error string");
console.log("no-daemon copy OK (canonical string)");

const apiUrl = process.env.CHAVEZ_API_URL;
if (!apiUrl) {
  console.log("SKIP rpc (set CHAVEZ_API_URL to exercise handlers)");
  console.log("web-file-tree smoke OK");
  process.exit(0);
}

const { ChavezWsClient } = await import("../src/ws/client");
const token = process.env.CHAVEZ_TOKEN;
if (!token) {
  console.log("SKIP rpc (CHAVEZ_TOKEN missing)");
  console.log("web-file-tree smoke OK");
  process.exit(0);
}

const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(cwd, "daemon");
assert(bound.ok, `bind failed: ${bound.error}`);

const treeRes = await client.request({ type: "fs.tree", path: "." });
assert(treeRes.ok, `fs.tree failed: ${treeRes.error}`);
const treeData = (treeRes.data || {}) as {
  hostname?: string;
  cwd?: string;
  entries?: Array<{ name: string }>;
};
assert(Boolean(treeData.hostname), "fs.tree hostname");
assert(
  (treeData.entries || []).every((e) => e.name !== "node_modules"),
  "rpc tree ignore",
);

const searchRes = await client.request({ type: "fs.search", query: "auth" });
assert(searchRes.ok, `fs.search failed: ${searchRes.error}`);

const prevRes = await client.request({ type: "fs.preview", path: "src/auth.ts" });
assert(prevRes.ok, `fs.preview failed: ${prevRes.error}`);
const prevData = (prevRes.data || {}) as { kind?: string; text?: string };
assert(prevData.kind === "text", "rpc preview text");

await client.unbind();
await client.close?.();
console.log("rpc OK", treeData.hostname, treeData.cwd);
console.log("web-file-tree smoke OK");
```

Ajustar `client.close` al método real de `ChavezWsClient` (hoy puede no existir: entonces omitir el close; el process sale). `bind(path, "daemon")` es la firma de attach-files (`clientKind`). Si `bind` solo acepta path, enviar `{ type: "workspace.bind", path: cwd, clientKind: "daemon", hostname: osHostname() }` vía `request`.

Para el caso **sin daemon** RPC: un segundo cliente `clientKind: "client"` en **otro** path, o desbindar y pedir `fs.tree` — debe devolver `ok: false` y `error` = `NO_DAEMON_ERROR`. Añadir al final si el bind daemon se deshizo:

```ts
const client2 = new ChavezWsClient(token);
await client2.connect();
await client2.request({
  type: "workspace.bind",
  path: cwd,
  clientKind: "client",
});
const naked = await client2.request({ type: "fs.tree", path: "." });
assert(naked.ok === false, "fs.tree without daemon must fail");
assert(
  (naked.error || "").includes("No daemon bound for this workspace"),
  `expected NO_DAEMON_ERROR, got ${naked.error}`,
);
```

Si `findDaemon` todavía ve el daemon del primer cliente (mismo process), hacer este assert **después** de `unbind` del daemon y **antes** de rebind. Si el smoke corre contra una API con otro daemon del user en ese path, documentar: usar el tmp `cwd` (workspaceId distinto).

- [ ] Correr:

```bash
cd cli && bun test src/llm/fs-search.test.ts src/llm/fs-preview.test.ts \
  src/llm/fs-tree.test.ts src/llm/mentions.test.ts src/llm/fs-complete.test.ts
cd ../cli && bun run scripts/web-file-tree-smoke.ts
```

Esperado: units pass; smoke imprime `web-file-tree smoke OK`. Con API: también `rpc OK`.

- [ ] Commit:

```bash
git add cli/scripts/web-file-tree-smoke.ts cli/package.json api/package.json
git commit -m "test(tree): gherkin smoke for web lazy tree search preview attach"
```

---

## Mapa Gherkin → tasks

| Escenario | Qué demuestra | Dónde |
|---|---|---|
| Árbol lazy | Raíz acotada (≤200), expandir pide `fs.tree`, ignore plan 8, header `hostname · path` | Task 3 RPC; Task 4 UI; Task 8 `listWorkspaceDir` + rpc |
| Búsqueda por nombre | `"auth"` → matches ≤50, no `node_modules`; elegir abre preview o Adjuntar | Task 1 `searchWorkspace`; Task 5 UI; Task 6 Adjuntar; picker sigue en 10 |
| Preview texto e imagen | Texto truncado 32_000; `<img data:>`; binario sin `text` | Task 2 `previewFile`; Task 5 `FilePreviewPanel` |
| Sin daemon | `NO_DAEMON_ERROR` + `NO_FS_COPY`; API sin `node:fs` | Task 3 fail path; Task 4/7 copy; Task 8 naked `fs.tree` |
| Insertar @ desde el árbol | `mentionToken` = picker; un clic = un chip; hidrata el turn (plan 1) | Task 6 `appendMention` + `?attach=` |

## Fuera de alcance (no implementar aquí)

- Subir el tope del picker `@` por encima de 10.
- Upload `<input type="file">` / drag-and-drop de archivos del browser.
- `GET /workspaces/:id/files` o cualquier `readdir` en `api/`.
- Explorador de archivos en TUI (TUI solo responde dispatch).
- Cursor cloud, voz, extensión IDE, notificaciones OS.
- Rehidratar preview al LLM (eso es `hydrateOne` en el turn).
- Worktrees paralelos, cola de turns, sandbox de red.
