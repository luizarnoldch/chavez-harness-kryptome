# Attach files (`@`) Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement browser upload, `@` de personas/issues/URLs, ni Cursor cloud. Spec: [`plan.md`](./plan.md).

**Goal:** El usuario menciona archivos y directorios del workspace con `@` en Web, TUI y CLI. El picker lista como máximo 10 candidatos resueltos contra el cwd del **daemon** (nunca el disco de la API ni el del navegador). Al enviar el turn, el daemon hidrata el contenido (texto, imagen, binario o listing de directorio ≤10) **antes** de llamar al LLM. El mensaje persistido conserva las menciones; recargar Web/TUI/`watch` las muestra; un follow-up reinyecta el snapshot hidratado, no relee el disco.

**Architecture:** El filesystem real vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"` en `tui/src/App.tsx`). Web dispara `fs.complete` y `agent.turn.request` por WebSocket; la API reenvía al daemon bound (`hub.findDaemon`) y hace fan-out del stream. TUI/CLI daemon resuelven picker e hidratación en local. El prompt crudo conserva `@rel/path`; el snapshot va en `chat_messages.metadata.attachments` (jsonb, **ya existe** en `api/src/db/schema.ts` — no hay migración).

```
Composer (Web | TUI | CLI ask)
        |  "@src/au"  (máx 10)
        v
  fs.complete  --WS-->  API hub.findDaemon  --push-->  daemon completeWorkspace(cwd)
        |  { hostname, cwd, candidates[] }
        v
  insert one token "@src/auth.ts"  (picker se cierra; otro @ para más)
        |
        v
  agent.turn.request { prompt, metadata.mentions? }
        |
        v
  daemon: parseMentions → resolveInsideCwd → hydrate
        |  persist user message + metadata.attachments
        |  missing/forbidden/too_large → chat.stream.error, NO LLM
        v
  runClaudeTurn (texto/dir/binario inlined; imágenes como content blocks)
        |
        v
  chat.stream.* / message.appended  →  Web + TUI + CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `api/src/ws/handlers.ts` ya despacha `agent.turn.request` → `agent.turn.dispatch` y persiste `chat.append` con `metadata`.
- `cli/src/ws/daemon.ts` y `tui/src/App.tsx` ya ejecutan `publishAgentTurn` al recibir el dispatch.
- `cli/src/llm/publish-turn.ts` hace `chat.append` del user **sin** attachments y llama `runClaudeTurn` con `prompt: string`.
- `cli/src/llm/history.ts` reinyecta solo `content`; ignora `metadata`.
- `hub.listForUser` ya expone `clientKind`; **no** expone `hostname`.
- TUI compose (`tui/src/App.tsx` ~444): Escape **mata la TUI**; no hay picker.
- Web compositor (`web/src/components/ChatDetailPanel.tsx`) es un `<textarea>` plano.

**Tech Stack:** Bun, Hono WebSocket, Drizzle `chat_messages.metadata` jsonb, Claude Agent SDK (`query` acepta `string | AsyncIterable<SDKUserMessage>`), Ink TUI, Astro/React web.

**Global Constraints:**

1. El filesystem se lee **solo** en el daemon (cwd del workspace). API y browser no listan ni hidratan archivos.
2. Sin daemon bound, `fs.complete` y `agent.turn.request` fallan con **el mismo string**: `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Picker: máximo **10** candidatos; se afina con el prefijo; selección **de uno en uno**.
4. Directorio adjunto: listing de máximo **10** hijos; nunca un árbol ilimitado.
5. `@` es path de workspace, no URL ni secret. `user@example.com` y `@decorator` no son attaches.
6. Varios `@` en el mismo prompt están permitidos (cada uno elegido por separado, o escritos a mano).
7. Hidratación una vez por mención, en el daemon, antes del LLM. Follow-up usa el snapshot persistido; el disco no se relee salvo nueva mención o tool `read`.
8. Texto se trunca a 100_000 bytes con marca explícita. Imagen se envía como imagen, nunca como UTF-8 corrupto. Binario/PDF/zip: metadatos + stub, nunca basura UTF-8.
9. Path traversal (`../`, absoluto fuera del cwd, symlink escape vía `realpathSync`) se rechaza; no se lee ni se envía.
10. Claude es el provider ejecutable de esta fase. Cursor sigue sin ejecutar turns (plan 4).
11. No upload desde el navegador. No `@` de personas/issues/URLs. No Cursor cloud.
12. Web, TUI y CLI `watch` ven el mismo mensaje (menciones en `content` + `metadata.attachments`).
13. 1 turn por daemon (ya existe `turnBusy` / `turnBusyRef`); no se cambia la cola.
14. CLI interactivo **es** la TUI (`chavez tui`). Headless `chat ask` no tiene picker; el parser del daemon cubre `@path` escrito a mano.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `FS_COMPLETE_LIMIT` | `10` |
| `DIR_LISTING_LIMIT` | `10` |
| `TEXT_ATTACH_MAX_BYTES` | `100_000` |
| `IMAGE_ATTACH_MAX_BYTES` | `4_500_000` |
| `FS_WALK_MAX_ENTRIES` | `8000` |
| `FS_COMPLETE_TIMEOUT_MS` | `5000` |
| `SKIP_DIR_NAMES` | `node_modules`, `.git`, `dist`, `.next`, `target`, `coverage`, `vendor` |
| `IMAGE_EXT` | `png`, `jpg`, `jpeg`, `webp`, `gif` |

Ignore/secrets (plan 8) **no** entra aquí: el picker solo salta directorios pesados de `SKIP_DIR_NAMES` para no gastar el tope de 10.

Política de tamaño (Gherkin: truncar **o** rechazar): texto **trunca** a `TEXT_ATTACH_MAX_BYTES` con marca `[truncated: showing N of M bytes]`. Imagen **rechaza** (`status: "too_large"`) por encima de `IMAGE_ATTACH_MAX_BYTES`. Missing/forbidden/too_large **bloquean** el LLM (`blockingAttachError`). Binary `ok` no bloquea: el modelo recibe un stub de metadatos.

---

## Task 1: Parser de menciones y sandbox de path

**Files:**

- Create: `cli/src/llm/mentions.ts`
- Create: `cli/src/llm/workspace-path.ts`
- Test: `cli/src/llm/mentions.test.ts`
- Test: `cli/src/llm/workspace-path.test.ts`
- Modify: `cli/package.json`

Módulo puro. El parser decide qué `@` es attach; el sandbox impide leer fuera del cwd. TUI importa estos archivos igual que ya importa `cli/src/ws/client`. Web **no** importa CLI (`web/tsconfig.json` solo incluye `web/src`); se duplica el parser en Task 6.

- [ ] Añadir script de test en `cli/package.json` (dejar `start`/`dev` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/workspace-path.ts`:

```ts
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export class PathEscapeError extends Error {
  readonly code = "PATH_ESCAPE" as const;
  constructor(public readonly relPath: string) {
    super(`Path outside workspace: ${relPath}`);
  }
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Resolve relPath against cwd. Throws PathEscapeError if it leaves the workspace. */
export function resolveInsideCwd(cwd: string, relPath: string): string {
  const trimmed = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") {
    throw new PathEscapeError(relPath);
  }
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new PathEscapeError(relPath);
  }
  const cwdReal = realpathSync(cwd);
  const candidate = join(cwdReal, trimmed);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    const lexical = join(cwdReal, trimmed);
    const rel = relative(cwdReal, lexical);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new PathEscapeError(relPath);
    }
    return lexical;
  }
  const rel = relative(cwdReal, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(relPath);
  }
  return resolved;
}

export function relativePosix(cwd: string, absPath: string): string {
  return toPosix(relative(cwd, absPath)) || ".";
}

export function isDir(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] Crear `cli/src/llm/mentions.ts`. El regex **sí** captura `../` y absolutos para que el sandbox los rechace con error visible (Gherkin: no LLM silencioso). No filtrar `..` aquí.

```ts
/**
 * Path-like @mentions. Keep the regex in sync with web/src/lib/mentions.ts.
 *
 * Matches:
 *   @"quoted path"  |  @'quoted'  |  @src/auth.ts  |  @package.json  |  @src/  |  @../../x  |  @/etc/passwd
 * Does not match:
 *   user@example.com  (word char before @)
 *   @decorator        (no slash, no extension, no trailing slash)
 */
export const MENTION_RE =
  /(?<![A-Za-z0-9_])@(?:"([^"]+)"|'([^']+)'|(\/[A-Za-z0-9._/-]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._/-]*|[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}|[A-Za-z0-9._-]+\/))/g;

export type ParsedMention = {
  raw: string;
  path: string;
  start: number;
  end: number;
};

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function parseMentions(prompt: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  const re = new RegExp(MENTION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const captured = m[1] ?? m[2] ?? m[3] ?? "";
    const path = normalizeRel(captured);
    if (!path || path === ".") continue;
    out.push({ raw: m[0], path, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Union text mentions with picker-supplied paths (relative posix, no leading @). */
export function mergeMentions(
  prompt: string,
  extraPaths: string[] = [],
): string[] {
  const fromText = parseMentions(prompt).map((x) => x.path);
  const extra = extraPaths
    .map((p) => normalizeRel(p.replace(/^@/, "")))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...fromText, ...extra]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function isPathLikeMentionToken(token: string): boolean {
  const t = token.startsWith("@") ? token.slice(1) : token;
  if (!t) return false;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return true;
  }
  return (
    t.startsWith("/") ||
    t.includes("/") ||
    t.endsWith("/") ||
    /\.[A-Za-z0-9]{1,12}$/.test(t)
  );
}
```

- [ ] Crear `cli/src/llm/mentions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mergeMentions, parseMentions } from "./mentions";

describe("parseMentions", () => {
  test("picker and hand-typed paths", () => {
    const p = parseMentions("see @src/auth.ts and @package.json please");
    expect(p.map((x) => x.path)).toEqual(["src/auth.ts", "package.json"]);
  });

  test("quoted path", () => {
    expect(parseMentions('look @"foo bar.ts"').map((x) => x.path)).toEqual([
      "foo bar.ts",
    ]);
  });

  test("directory with trailing slash", () => {
    expect(parseMentions("list @src/").map((x) => x.path)).toEqual(["src"]);
  });

  test("email is not an attach", () => {
    expect(parseMentions("mail user@example.com thanks")).toEqual([]);
  });

  test("decorator is not an attach", () => {
    expect(parseMentions("use @override on the method")).toEqual([]);
  });

  test("multiple distinct mentions", () => {
    const p = parseMentions("@README.md then @src/index.ts");
    expect(p.map((x) => x.path)).toEqual(["README.md", "src/index.ts"]);
  });

  test("captures traversal so sandbox can reject it", () => {
    expect(parseMentions("x @../../.ssh/id_rsa").map((x) => x.path)).toEqual([
      "../../.ssh/id_rsa",
    ]);
  });

  test("captures absolute path so sandbox can reject it", () => {
    expect(parseMentions("x @/etc/passwd").map((x) => x.path)).toEqual([
      "/etc/passwd",
    ]);
  });
});

describe("mergeMentions", () => {
  test("unions picker extras with text", () => {
    expect(mergeMentions("see @a.ts", ["src", "@a.ts"])).toEqual(["a.ts", "src"]);
  });
});
```

- [ ] Crear `cli/src/llm/workspace-path.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";

describe("resolveInsideCwd", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ws-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "ok");

  test("resolves relative file", () => {
    expect(resolveInsideCwd(cwd, "src/a.ts")).toBe(join(cwd, "src", "a.ts"));
  });

  test("rejects parent escape", () => {
    expect(() => resolveInsideCwd(cwd, "../../.ssh/id_rsa")).toThrow(
      PathEscapeError,
    );
  });

  test("rejects absolute path", () => {
    expect(() => resolveInsideCwd(cwd, "/etc/passwd")).toThrow(PathEscapeError);
  });

  test("missing file still in-workspace returns lexical path", () => {
    const p = resolveInsideCwd(cwd, "no-existe.ts");
    expect(p.startsWith(cwd)).toBe(true);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/mentions.test.ts src/llm/workspace-path.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/mentions.ts cli/src/llm/workspace-path.ts \
  cli/src/llm/mentions.test.ts cli/src/llm/workspace-path.test.ts cli/package.json
git commit -m "feat(attach): parse @path mentions and sandbox workspace paths"
```

---

## Task 2: Completar picker (máx 10) e hidratar attaches

**Files:**

- Create: `cli/src/llm/fs-complete.ts`
- Create: `cli/src/llm/hydrate-attachments.ts`
- Test: `cli/src/llm/fs-complete.test.ts`
- Test: `cli/src/llm/hydrate-attachments.test.ts`

El picker camina el cwd del daemon. La hidratación clasifica texto / imagen / binario / directorio y **nunca** inyecta bytes no-UTF8 como texto.

- [ ] Crear `cli/src/llm/fs-complete.ts`:

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { relativePosix, toPosix } from "./workspace-path";

export const FS_COMPLETE_LIMIT = 10;
export const FS_WALK_MAX_ENTRIES = 8000;
export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "target",
  "coverage",
  "vendor",
]);

export type FsCandidate = {
  path: string;
  isDir: boolean;
};

function walk(cwd: string): FsCandidate[] {
  const out: FsCandidate[] = [];
  const stack: string[] = [cwd];
  while (stack.length && out.length < FS_WALK_MAX_ENTRIES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= FS_WALK_MAX_ENTRIES) break;
      const name = ent.name;
      if (name === "." || name === "..") continue;
      if (ent.isDirectory() && SKIP_DIR_NAMES.has(name)) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, name);
      const rel = relativePosix(cwd, abs);
      if (rel.startsWith("..")) continue;
      if (ent.isDirectory()) {
        out.push({ path: rel, isDir: true });
        stack.push(abs);
      } else if (ent.isFile()) {
        out.push({ path: rel, isDir: false });
      }
    }
  }
  return out;
}

function score(path: string, query: string): number | null {
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

export function completeWorkspace(
  cwd: string,
  query: string,
  limit = FS_COMPLETE_LIMIT,
): FsCandidate[] {
  const q = toPosix(query).replace(/^@/, "").replace(/^\.\//, "");
  const ranked = walk(cwd)
    .map((c) => {
      const s = score(c.path, q);
      return s == null ? null : { c, s };
    })
    .filter((x): x is { c: FsCandidate; s: number } => x != null)
    .sort(
      (a, b) =>
        a.s - b.s ||
        a.c.path.length - b.c.path.length ||
        a.c.path.localeCompare(b.c.path),
    )
    .slice(0, limit)
    .map((x) => x.c);
  return ranked;
}
```

- [ ] Crear `cli/src/llm/hydrate-attachments.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";

export const DIR_LISTING_LIMIT = 10;
export const TEXT_ATTACH_MAX_BYTES = 100_000;
export const IMAGE_ATTACH_MAX_BYTES = 4_500_000;
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export type AttachKind = "text" | "image" | "binary" | "directory";
export type AttachStatus =
  | "ok"
  | "missing"
  | "forbidden"
  | "too_large"
  | "unsupported";

export type DirEntry = { name: string; isDir: boolean };

export type HydratedAttachment = {
  path: string;
  kind: AttachKind;
  status: AttachStatus;
  byteSize: number;
  mime?: string;
  truncated?: boolean;
  listing?: DirEntry[];
  /** Snapshot for LLM + history. Never raw binary. Omitted for images (bytes stay in memory only). */
  hydratedText?: string;
  sha256?: string;
  mediaType?: string;
  /** In-memory only; do not persist in chat_messages.metadata. */
  imageBase64?: string;
  error?: string;
};

function sniffUtf8(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function mimeFor(path: string, kind: AttachKind): string {
  const ext = extname(path).toLowerCase();
  if (kind === "image") {
    if (ext === ".png") return "image/png";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    return "image/jpeg";
  }
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (kind === "text") return "text/plain";
  return "application/octet-stream";
}

export function persistableAttachment(
  a: HydratedAttachment,
): Omit<HydratedAttachment, "imageBase64"> {
  const { imageBase64: _drop, ...rest } = a;
  return rest;
}

export function hydrateOne(cwd: string, relPath: string): HydratedAttachment {
  let abs: string;
  try {
    abs = resolveInsideCwd(cwd, relPath);
  } catch (err) {
    return {
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

  let st;
  try {
    st = statSync(abs);
  } catch {
    return {
      path: relPath,
      kind: "binary",
      status: "missing",
      byteSize: 0,
      error: `File not found: ${relPath}`,
    };
  }

  if (st.isDirectory()) {
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      names = [];
    }
    const listing: DirEntry[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (listing.length >= DIR_LISTING_LIMIT) break;
      if (name === "." || name === "..") continue;
      let childIsDir = false;
      try {
        childIsDir = statSync(join(abs, name)).isDirectory();
      } catch {
        childIsDir = false;
      }
      listing.push({ name, isDir: childIsDir });
    }
    const extra =
      names.length > DIR_LISTING_LIMIT
        ? `\n… ${names.length - DIR_LISTING_LIMIT} more entries not listed`
        : "";
    const lines = listing.map((e) => (e.isDir ? `${e.name}/` : e.name));
    return {
      path: relPath,
      kind: "directory",
      status: "ok",
      byteSize: 0,
      listing,
      hydratedText: `[directory ${relPath} — ${Math.min(names.length, DIR_LISTING_LIMIT)} of ${names.length} entries]\n${lines.join("\n")}${extra}`,
    };
  }

  const ext = extname(relPath).toLowerCase();
  const buf = readFileSync(abs);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  if (IMAGE_EXT.has(ext)) {
    if (buf.length > IMAGE_ATTACH_MAX_BYTES) {
      return {
        path: relPath,
        kind: "image",
        status: "too_large",
        byteSize: buf.length,
        mime: mimeFor(relPath, "image"),
        sha256,
        error: `Image exceeds ${IMAGE_ATTACH_MAX_BYTES} bytes: ${relPath}`,
      };
    }
    const mediaType = mimeFor(relPath, "image");
    return {
      path: relPath,
      kind: "image",
      status: "ok",
      byteSize: buf.length,
      mime: mediaType,
      mediaType,
      sha256,
      imageBase64: buf.toString("base64"),
    };
  }

  if (sniffUtf8(buf)) {
    const truncated = buf.length > TEXT_ATTACH_MAX_BYTES;
    const slice = truncated ? buf.subarray(0, TEXT_ATTACH_MAX_BYTES) : buf;
    const text = slice.toString("utf8");
    const mark = truncated
      ? `\n\n[truncated: showing ${TEXT_ATTACH_MAX_BYTES} of ${buf.length} bytes]`
      : "";
    return {
      path: relPath,
      kind: "text",
      status: "ok",
      byteSize: buf.length,
      mime: mimeFor(relPath, "text"),
      truncated,
      sha256,
      hydratedText: text + mark,
    };
  }

  return {
    path: relPath,
    kind: "binary",
    status: "ok",
    byteSize: buf.length,
    mime: mimeFor(relPath, "binary"),
    sha256,
    hydratedText: `[Attached binary ${relPath} (${mimeFor(relPath, "binary")}, ${buf.length} bytes). Content is not UTF-8 and was not inlined. Use tools to inspect if the provider supports this type.]`,
  };
}

export function hydrateAll(cwd: string, paths: string[]): HydratedAttachment[] {
  return paths.map((p) => hydrateOne(cwd, p));
}

export function blockingAttachError(
  attachments: HydratedAttachment[],
): string | null {
  const bad = attachments.filter(
    (a) =>
      a.status === "missing" ||
      a.status === "forbidden" ||
      a.status === "too_large",
  );
  if (!bad.length) return null;
  return bad.map((a) => a.error || `${a.path}: ${a.status}`).join("; ");
}

/** Text injected into the LLM string prompt (images go as content blocks). */
export function attachmentsPromptBlock(
  attachments: HydratedAttachment[],
): string {
  const parts: string[] = [];
  for (const a of attachments) {
    if (a.status !== "ok") continue;
    if (a.kind === "image") {
      parts.push(
        `[Attached image ${a.path} (${a.mime}, ${a.byteSize} bytes) — sent as image block, not as text.]`,
      );
      continue;
    }
    parts.push(
      `<attached path="${a.path}" kind="${a.kind}">\n${a.hydratedText ?? ""}\n</attached>`,
    );
  }
  if (!parts.length) return "";
  return [
    "The user attached the following workspace files. Treat them as context for this turn. Do not assume later disk contents match this snapshot.",
    "",
    ...parts,
  ].join("\n");
}
```

- [ ] Crear `cli/src/llm/fs-complete.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace } from "./fs-complete";

describe("completeWorkspace", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-fs-")));
  mkdirSync(join(cwd, "src", "gen"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "hi");
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "src", "auth.ts"), "a");
  writeFileSync(join(cwd, "src", "index.ts"), "i");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(cwd, "src", "gen", `f${String(i).padStart(2, "0")}.ts`), "");
  }

  test("caps at 10", () => {
    expect(completeWorkspace(cwd, "").length).toBeLessThanOrEqual(10);
  });

  test("refines to prefix", () => {
    const paths = completeWorkspace(cwd, "src/au").map((c) => c.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("package.json");
    expect(paths.length).toBeLessThanOrEqual(10);
  });

  test("empty when nothing matches", () => {
    expect(completeWorkspace(cwd, "no-such-prefix-xyz")).toEqual([]);
  });

  test("skips node_modules", () => {
    const paths = completeWorkspace(cwd, "index");
    expect(paths.some((c) => c.path.startsWith("node_modules/"))).toBe(false);
  });

  test("more specific path ranks first", () => {
    const paths = completeWorkspace(cwd, "src/au").map((c) => c.path);
    expect(paths[0]).toBe("src/auth.ts");
  });
});
```

- [ ] Crear `cli/src/llm/hydrate-attachments.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockingAttachError,
  hydrateOne,
  persistableAttachment,
  TEXT_ATTACH_MAX_BYTES,
} from "./hydrate-attachments";

describe("hydrateOne", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-hy-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "auth.ts"), "export const x = 1;\n");
  writeFileSync(join(cwd, "big.txt"), "a".repeat(TEXT_ATTACH_MAX_BYTES + 50));
  mkdirSync(join(cwd, "lots"));
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(cwd, "lots", `f${i}.txt`), "x");
  }
  writeFileSync(
    join(cwd, "shot.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  writeFileSync(join(cwd, "blob.bin"), Buffer.from("hello\0world"));

  test("text", () => {
    const a = hydrateOne(cwd, "src/auth.ts");
    expect(a.kind).toBe("text");
    expect(a.status).toBe("ok");
    expect(a.hydratedText).toContain("export const x");
  });

  test("truncates large text", () => {
    const a = hydrateOne(cwd, "big.txt");
    expect(a.truncated).toBe(true);
    expect(a.hydratedText).toContain("[truncated:");
  });

  test("directory lists at most 10", () => {
    const a = hydrateOne(cwd, "lots");
    expect(a.kind).toBe("directory");
    expect(a.listing?.length).toBe(10);
    expect(a.hydratedText).toContain("10 of 15");
  });

  test("image is not utf8", () => {
    const a = hydrateOne(cwd, "shot.png");
    expect(a.kind).toBe("image");
    expect(a.imageBase64).toBeTruthy();
    expect("imageBase64" in persistableAttachment(a)).toBe(false);
  });

  test("binary never inlined as utf8", () => {
    const a = hydrateOne(cwd, "blob.bin");
    expect(a.kind).toBe("binary");
    expect(a.hydratedText).toContain("not UTF-8");
    expect(a.hydratedText).not.toContain("\0");
  });

  test("forbidden escape", () => {
    expect(hydrateOne(cwd, "../outside.txt").status).toBe("forbidden");
  });

  test("missing", () => {
    expect(hydrateOne(cwd, "no-existe.ts").status).toBe("missing");
  });

  test("blockingAttachError", () => {
    expect(blockingAttachError([hydrateOne(cwd, "src/auth.ts")])).toBeNull();
    expect(blockingAttachError([hydrateOne(cwd, "no-existe.ts")])).toMatch(
      /not found/i,
    );
    expect(blockingAttachError([hydrateOne(cwd, "../../.ssh/id_rsa")])).toMatch(
      /outside workspace/i,
    );
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/fs-complete.test.ts src/llm/hydrate-attachments.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/fs-complete.ts cli/src/llm/hydrate-attachments.ts \
  cli/src/llm/fs-complete.test.ts cli/src/llm/hydrate-attachments.test.ts
git commit -m "feat(attach): workspace picker ranking and typed hydration"
```

---

## Task 3: Protocolo WS — hostname del daemon + RPC `fs.complete`

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/hub.ts`
- Modify: `api/src/ws/handlers.ts`
- Create: `api/src/ws/pending.ts`
- Test: `api/src/ws/pending.test.ts`
- Modify: `api/package.json`

Hoy `workspace.bind` guarda `path` y `clientKind` pero no hostname. `agent.turn.request` ya despacha al daemon; `fs.complete` replica ese patrón con respuesta correlacionada (`requestId` = id del cliente Web/TUI). `GET /connections` ya lista `clientKind` vía `hub.listForUser`; hay que añadir `hostname`.

- [ ] Añadir `"test": "bun test"` en scripts de `api/package.json` (dejar el resto).

- [ ] Crear `api/src/ws/pending.ts`:

```ts
import { fail, type ServerMessage } from "./protocol";

export type PendingReply = {
  resolve: (msg: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createPendingMap(timeoutMs: number) {
  const map = new Map<string, PendingReply>();
  return {
    wait(id: string, type: string): Promise<ServerMessage> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          map.delete(id);
          resolve(
            fail(
              type,
              id,
              "No daemon bound for this workspace. Run: chavez headless workspace open",
            ),
          );
        }, timeoutMs);
        map.set(id, { resolve, timer });
      });
    },
    complete(id: string, msg: ServerMessage): boolean {
      const p = map.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      map.delete(id);
      p.resolve(msg);
      return true;
    },
    has(id: string) {
      return map.has(id);
    },
  };
}
```

El timeout usa **el mismo texto** que `agent.turn.request` sin daemon (Gherkin: mismo tipo de error).

- [ ] Crear `api/src/ws/pending.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createPendingMap } from "./pending";
import { ok } from "./protocol";

describe("createPendingMap", () => {
  test("times out", async () => {
    const p = createPendingMap(20);
    const msg = await p.wait("a", "fs.complete");
    expect(msg.ok).toBe(false);
    expect(msg.error || "").toMatch(/daemon bound/i);
  });

  test("complete wins over timeout", async () => {
    const p = createPendingMap(200);
    const done = p.wait("b", "fs.complete");
    expect(p.complete("b", ok("fs.complete", "b", { n: 1 }))).toBe(true);
    const msg = await done;
    expect(msg.ok).toBe(true);
    expect((msg.data as { n: number }).n).toBe(1);
  });
});
```

- [ ] En `api/src/ws/protocol.ts`, extender `ClientMessage` con:

```ts
  query?: string;
  hostname?: string;
  requestId?: string;
  limit?: number;
```

Dejar el resto de campos igual.

- [ ] En `api/src/ws/hub.ts`:

  - Añadir `hostname: string | null` a `HubConnection` y `ConnectionPublic`.
  - Default `hostname: null` en `hub.add` (mismo patrón que `clientKind: "client"`): extender el `Omit`/`Partial` para incluir `hostname`.
  - Añadir `setHostname(connectionId, hostname: string | null)` que asigne `c.hostname`.
  - `listForUser` incluye `hostname` en el objeto mapeado (junto a `clientKind` que ya se mapea).
  - `findDaemon` no cambia el matching (sigue siendo 1 daemon por workspace).

- [ ] En `api/src/ws/handlers.ts`:

  1. Importar `createPendingMap` y declarar a nivel de módulo `const fsPending = createPendingMap(5000)`.
  2. En `workspace.bind`, después de `hub.setClientKind(...)`: si `typeof msg.hostname === "string" && msg.hostname.trim()`, `hub.setHostname(connectionId, msg.hostname.trim())`; si no, `hub.setHostname(connectionId, null)`. Incluir `hostname: hub.get(connectionId)?.hostname ?? null` en el `data` de la respuesta junto a `workspace` y `clientKind`.
  3. Nuevo case `fs.complete` (insertar **antes** de `agent.turn.request`):
     - `chatId` obligatorio. `query` puede ser `""` (`String(msg.query ?? "")`).
     - `workspaceIdForChat`; si falta chat → `fail(type, id, "Chat not found")`.
     - `hub.findDaemon`; si no hay daemon → `fail` con **el mismo texto** que `agent.turn.request`: `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
     - Cargar `workspaces` row como en `agent.turn.request`.
     - `hub.sendTo(daemon.connectionId, hub.pushEvent("fs.complete.dispatch", { requestId: id, query: String(msg.query ?? ""), limit: 10, requesterConnectionId: connectionId, path: workspace?.path || daemon.path, chatId: msg.chatId }))`.
     - Si `!sent` → `fail(type, id, "Daemon connection unavailable")`.
     - `return await fsPending.wait(id, type)`.
  4. Nuevo case `fs.complete.result` (lo envía el daemon como request RPC, no push):
     - Requiere `msg.requestId`.
     - `const meta = (msg.metadata || {}) as { cwd?: string; candidates?: unknown }`.
     - Payload: `{ hostname: msg.hostname || null, cwd: meta.cwd || msg.path || null, candidates: Array.isArray(meta.candidates) ? meta.candidates.slice(0, 10) : [] }`.
     - `fsPending.complete(msg.requestId, ok("fs.complete", msg.requestId, payload))`.
     - Responder al daemon `ok(type, id, { forwarded: boolean })`.
  5. En `agent.turn.request`, al armar el push `agent.turn.dispatch`, añadir:

```ts
mentions: Array.isArray(msg.metadata?.mentions)
  ? (msg.metadata!.mentions as unknown[]).filter((x) => typeof x === "string")
  : undefined,
```

- [ ] Correr:

```bash
cd api && bun test src/ws/pending.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/hub.ts api/src/ws/handlers.ts \
  api/src/ws/pending.ts api/src/ws/pending.test.ts api/package.json
git commit -m "feat(attach): fs.complete RPC and daemon hostname on bind"
```

---

## Task 4: Daemon hidrata, publica menciones y alimenta al LLM

**Files:**

- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/history.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Test: `cli/src/llm/history.test.ts`
- Modify: `cli/scripts/history-smoke.ts`

Este es el corazón: bind envía hostname; el daemon responde `fs.complete`; `publishAgentTurn` hidrata **antes** de `runClaudeTurn` y persiste el snapshot en metadata. TUI reutiliza `ChavezWsClient.bind` y `publishAgentTurn`.

- [ ] En `cli/src/ws/client.ts`, extender `WsRequest` con `query?: string`, `hostname?: string`, `requestId?: string`, `limit?: number`. En `bind()`, si `clientKind === "daemon"`, enviar `hostname` de `node:os`:

```ts
import { hostname } from "node:os";
// ...
async bind(
  path = cwdPath(),
  clientKind: "client" | "daemon" = "client",
): Promise<WsResponse> {
  return this.request({
    type: "workspace.bind",
    path,
    clientKind,
    hostname: clientKind === "daemon" ? hostname() : undefined,
  });
}
```

- [ ] En `cli/src/ws/daemon.ts`, además del handler de `agent.turn.dispatch`, manejar `fs.complete.dispatch` **primero** (no compartir el `turnBusy`):

```ts
import { hostname } from "node:os";
import { completeWorkspace } from "../llm/fs-complete";

client.onPush(async (msg: WsPushMessage) => {
  if (msg.type === "fs.complete.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      query?: string;
      path?: string;
    };
    if (!data.requestId) return;
    const candidates = completeWorkspace(data.path || path, data.query || "", 10);
    await client.request({
      type: "fs.complete.result",
      requestId: data.requestId,
      hostname: hostname(),
      path,
      metadata: { cwd: data.path || path, candidates },
    });
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    mentions?: string[];
  };
  if (!data.chatId || !data.prompt) {
    log("dispatch missing chatId/prompt");
    return;
  }
  if (turnBusy) {
    log("turn already running — ignoring dispatch");
    return;
  }
  turnBusy = true;
  log(`turn start chat=${data.chatId}`);
  try {
    await publishAgentTurn({
      client,
      chatId: data.chatId,
      prompt: data.prompt,
      cwd: data.path || path,
      token: config.accessToken!,
      mentions: data.mentions,
    });
    log(`turn ok chat=${data.chatId}`);
  } catch (err) {
    log(`turn fail: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    turnBusy = false;
  }
});
```

- [ ] En `cli/src/llm/history.ts`, ampliar `DbMessage` con `metadata?: Record<string, unknown> | null`. Añadir:

```ts
export function formatUserContentForHistory(
  content: string,
  metadata?: Record<string, unknown> | null,
): string {
  const attachments = Array.isArray(metadata?.attachments)
    ? (metadata!.attachments as Array<Record<string, unknown>>)
    : [];
  if (!attachments.length) return content;
  const blocks = attachments.map((a) => {
    const attPath = String(a.path || "");
    const kind = String(a.kind || "");
    if (kind === "text" && typeof a.hydratedText === "string") {
      return `\n\n[attached ${attPath} — snapshot, not re-read from disk]\n${a.hydratedText}`;
    }
    if (kind === "directory" && typeof a.hydratedText === "string") {
      return `\n\n[attached dir ${attPath}]\n${a.hydratedText}`;
    }
    if (kind === "image") {
      return `\n\n[attached image ${attPath} (${String(a.mime || "image")}, ${String(a.byteSize || 0)} bytes)]`;
    }
    if (typeof a.hydratedText === "string") {
      return `\n\n[attached ${kind} ${attPath}]\n${a.hydratedText}`;
    }
    return `\n\n[attached ${kind} ${attPath}]`;
  });
  return content + blocks.join("");
}
```

En `historyFromChatMessages`, al pushear, si `role === "user"` usar `formatUserContentForHistory(content, m.metadata)`. Así un follow-up **sin** nueva mención reinyecta el snapshot. No hay `readFile` aquí. Las imágenes históricas se recuerdan como texto (`[attached image …]`), no se reenvían bytes; una nueva mención `@shot.png` sí rehidrata del disco.

- [ ] Crear `cli/src/llm/history.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { historyFromChatMessages } from "./history";

describe("historyFromChatMessages attachments", () => {
  test("rehydrates snapshot, not a disk reread", () => {
    const hist = historyFromChatMessages(
      [
        {
          role: "user",
          content: "explica @src/auth.ts",
          metadata: {
            attachments: [
              {
                path: "src/auth.ts",
                kind: "text",
                status: "ok",
                hydratedText: "export const TOKEN = 'SNAP-1';",
              },
            ],
          },
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "¿cuál era el token del attach?" },
      ],
      "¿cuál era el token del attach?",
    );
    expect(hist[0]!.content).toMatch(/SNAP-1/);
    expect(hist[0]!.content).toMatch(/not re-read from disk/);
  });
});
```

- [ ] Añadir el mismo caso en `cli/scripts/history-smoke.ts` (bloque unit, **antes** del live, junto al helper existente):

```ts
{
  const hist = historyFromChatMessages(
    [
      {
        role: "user",
        content: "explica @src/auth.ts",
        metadata: {
          attachments: [
            {
              path: "src/auth.ts",
              kind: "text",
              status: "ok",
              hydratedText: "export const TOKEN = 'SNAP-1';",
            },
          ],
        },
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: "¿cuál era el token del attach?" },
    ],
    "¿cuál era el token del attach?",
  );
  assert.match(hist[0]!.content, /SNAP-1/);
  assert.match(hist[0]!.content, /not re-read from disk/);
  console.log("history attach snapshot OK");
}
```

- [ ] En `cli/src/llm/claude-runner.ts`:

  - Importar tipo `HydratedAttachment` y `attachmentsPromptBlock`.
  - Extender `RunClaudeTurnInput` con `attachments?: HydratedAttachment[]`.
  - Si hay imágenes `status === "ok"` con `imageBase64` y `mediaType`, pasar a `query` un `AsyncIterable<SDKUserMessage>` (`query` ya acepta `string | AsyncIterable<SDKUserMessage>` en `@anthropic-ai/claude-agent-sdk`):

```ts
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  attachmentsPromptBlock,
  type HydratedAttachment,
} from "./hydrate-attachments";

function buildPrompt(
  input: RunClaudeTurnInput,
): string | AsyncIterable<SDKUserMessage> {
  const attachBlock = attachmentsPromptBlock(input.attachments ?? []);
  const text = promptWithHistory(
    attachBlock ? `${attachBlock}\n\n${input.prompt}` : input.prompt,
    input.history ?? [],
  );
  const images = (input.attachments ?? []).filter(
    (a) =>
      a.kind === "image" &&
      a.status === "ok" &&
      a.imageBase64 &&
      a.mediaType,
  );
  if (!images.length) return text;
  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp",
              data: img.imageBase64!,
            },
          })),
          { type: "text" as const, text },
        ],
      },
    };
  }
  return gen();
}
```

  Reemplazar `const prompt = promptWithHistory(...)` por `const prompt = buildPrompt(input)`. Si el SDK rechaza el media_type, el `catch` de `publishAgentTurn` ya emite `chat.stream.error` — el turn falla visible, nunca se inyecta el PNG como UTF-8.

- [ ] Reescribir el inicio de `publishAgentTurn` en `cli/src/llm/publish-turn.ts` (el resto del flujo providers/credentials/stream se queda; pasar `attachments` a `runClaudeTurn` y ampliar el tipo de `chat.get`):

```ts
import { mergeMentions } from "./mentions";
import {
  blockingAttachError,
  hydrateAll,
  persistableAttachment,
  type HydratedAttachment,
} from "./hydrate-attachments";

export async function publishAgentTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  prompt: string;
  cwd: string;
  token?: string;
  skipUserAppend?: boolean;
  mentions?: string[];
}): Promise<string> {
  const { client, chatId, prompt, cwd, token } = input;
  const paths = mergeMentions(prompt, input.mentions ?? []);
  const attachments: HydratedAttachment[] = paths.length
    ? hydrateAll(cwd, paths)
    : [];

  if (!input.skipUserAppend) {
    const userRes = await client.request({
      type: "chat.append",
      chatId,
      role: "user",
      content: prompt,
      metadata: attachments.length
        ? { attachments: attachments.map(persistableAttachment) }
        : undefined,
    });
    if (!userRes.ok) {
      throw new Error(userRes.error || "chat.append user failed");
    }
  }

  const blocked = blockingAttachError(attachments);
  if (blocked) {
    const streamId = crypto.randomUUID();
    await client.request({ type: "chat.stream.start", chatId, streamId });
    await client.request({
      type: "chat.stream.error",
      chatId,
      streamId,
      content: blocked,
    });
    throw new Error(blocked);
  }

  // existing provider/credentials/history/stream unchanged,
  // except pass attachments into runClaudeTurn({ ..., attachments })
  // and widen chat.get messages type:
  // Array<{ role?: string; content?: string; metadata?: Record<string, unknown> | null }>
```

Orden obligatorio: **append user (con snapshot) → si blocked, stream.error y NO LLM**. El mensaje de usuario queda visible con `status: missing|forbidden|too_large` en metadata.

- [ ] Correr unitarios:

```bash
cd cli && bun test src/llm
```

El live de `history-smoke.ts` requiere API + login + Claude; el bloque unitario al inicio debe pasar aunque no haya token (el `process.exit(1)` por falta de token ocurre **después** del unit).

- [ ] Commit:

```bash
git add cli/src/ws/client.ts cli/src/ws/daemon.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/history.ts cli/src/llm/history.test.ts cli/src/llm/claude-runner.ts \
  cli/scripts/history-smoke.ts
git commit -m "feat(attach): hydrate @files on daemon before the LLM turn"
```

---

## Task 5: TUI compose — picker `@`, Tab/Enter, Escape

**Files:**

- Modify: `tui/src/App.tsx`

Hoy `mode === "compose"` concatena caracteres y Enter envía; Escape **mata la TUI** (el `if (key.escape || ctrl+c) { exit }` está **antes** del branch compose, líneas 445–448). Hay que: picker local (TUI **es** el daemon, `completeWorkspace(cwd)` directo, no RPC para su propio compositor), Tab/Enter insertan una mención, Escape cierra el picker sin enviar, Enter con input vacío no dispara turn (ya ocurre). TUI también responde `fs.complete.dispatch` de Web.

- [ ] Ampliar tipo `Message`:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna `messages` desde `chat.get`; el metadata llega si el tipo lo admite.

- [ ] Imports nuevos (mismo estilo que `ChavezWsClient` desde `../../cli/src/ws/client`; bun resuelve aunque `tui/tsconfig.json` solo liste `src/**/*`):

```ts
import { hostname } from "node:os";
import {
  completeWorkspace,
  type FsCandidate,
} from "../../cli/src/llm/fs-complete";
```

- [ ] Estado nuevo junto a `input` / `mode`:

```ts
const [pickerOpen, setPickerOpen] = useState(false);
const [pickerItems, setPickerItems] = useState<FsCandidate[]>([]);
const [pickerIndex, setPickerIndex] = useState(0);
```

- [ ] Helper en el mismo archivo (encima de `export function App`):

```ts
function activeMention(text: string): { start: number; query: string } | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1]!)) return null;
  const rest = text.slice(at + 1);
  if (/\s/.test(rest)) return null;
  return { start: at, query: rest };
}

function formatAttachSuffix(m: Message): string {
  const atts = Array.isArray((m.metadata as { attachments?: unknown } | null)?.attachments)
    ? ((m.metadata as { attachments: Array<Record<string, unknown>> }).attachments)
    : [];
  if (!atts.length) return "";
  return (
    " " +
    atts
      .map((a) => {
        const p = String(a.path || "");
        if (a.kind === "image") return `[@${p} imagen]`;
        if (a.kind === "directory") return `[@${p} dir]`;
        if (a.kind === "binary") return `[@${p} binario]`;
        return `[@${p}]`;
      })
      .join(" ")
  );
}
```

- [ ] Recalcular picker en el mismo callback de texto (no `useEffect` que luche con el cursor):

```ts
function applyComposeText(next: string) {
  setInput(next);
  const mention = activeMention(next);
  if (!mention) {
    setPickerOpen(false);
    setPickerItems([]);
    return;
  }
  const items = completeWorkspace(cwd, mention.query, 10);
  setPickerOpen(true);
  setPickerItems(items);
  setPickerIndex((i) => (items.length ? Math.min(i, items.length - 1) : 0));
}
```

Definir `applyComposeText` con `useCallback` dependiente de `cwd`, **dentro** de `App`.

- [ ] En el `useEffect` de `onPush` (el que hoy empieza con `if (msg.type === "agent.turn.dispatch")`), **antes** de ese branch, manejar `fs.complete.dispatch` (Web usa el TUI como daemon). Ampliar el type de `data` con `requestId?: string; query?: string; mentions?: string[]`.

```ts
if (msg.type === "fs.complete.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    query?: string;
    path?: string;
  };
  if (!data.requestId) return;
  const candidates = completeWorkspace(data.path || cwd, data.query || "", 10);
  void client.request({
    type: "fs.complete.result",
    requestId: data.requestId,
    hostname: hostname(),
    path: data.path || cwd,
    metadata: { cwd: data.path || cwd, candidates },
  });
  return;
}
```

En el handler existente de `agent.turn.dispatch`, pasar `mentions: data.mentions` a `publishAgentTurn`.

- [ ] Reestructurar `useInput`: el kill global **no** puede ir primero. Orden:

  1. `if (key.ctrl && ch === "c") { client?.close(); exit(); return; }` (kill global).
  2. Branch `if (mode === "compose")` completo (abajo).
  3. `if (key.escape) { client?.close(); exit(); return; }` solo en command mode.
  4. Resto de command mode intacto (`q`, tab, flechas, `p`, `m`, …).

Reemplazar el bloque compose actual (return/backspace/char) por:

```ts
if (mode === "compose") {
  if (busy) return;
  if (key.escape) {
    if (pickerOpen) {
      setPickerOpen(false);
      setPickerItems([]);
      setLog("Picker cerrado");
      return;
    }
    setMode("command");
    setInput("");
    setLog("Compose cancelado");
    return;
  }
  if (pickerOpen && (key.upArrow || key.downArrow)) {
    const dir = key.downArrow ? 1 : -1;
    setPickerIndex((i) => {
      const n = pickerItems.length;
      if (!n) return 0;
      return (i + dir + n) % n;
    });
    return;
  }
  if (pickerOpen && (key.tab || key.return) && pickerItems[pickerIndex]) {
    const chosen = pickerItems[pickerIndex]!;
    const raw = chosen.isDir ? `${chosen.path}/` : chosen.path;
    const token = /\s/.test(raw) ? `@"${raw}"` : `@${raw}`;
    const mention = activeMention(input);
    const next = mention
      ? input.slice(0, mention.start) + token + " "
      : input + token + " ";
    applyComposeText(next);
    setPickerOpen(false);
    setPickerItems([]);
    return;
  }
  if (pickerOpen && key.return && pickerItems.length === 0) {
    setPickerOpen(false);
    setLog("Sin coincidencias");
    return;
  }
  if (key.return) {
    const text = input.trim();
    setInput("");
    setMode("command");
    setPickerOpen(false);
    if (!text) return;
    await sendWithLlm(text);
    return;
  }
  if (key.tab) return;
  if (key.backspace || key.delete) {
    applyComposeText(input.slice(0, -1));
    return;
  }
  if (ch && !key.ctrl && !key.meta) {
    applyComposeText(input + ch);
  }
  return;
}
```

- [ ] Render: debajo de `compose> {input}` (hoy líneas 716–721):

```tsx
{mode === "compose" && pickerOpen ? (
  <Box flexDirection="column">
    <Text dimColor>
      @ picker · {hostname()} · {cwd} · máx 10
    </Text>
    {pickerItems.length === 0 ? (
      <Text color="yellow">Sin coincidencias</Text>
    ) : (
      pickerItems.map((c, i) => (
        <Text
          key={c.path}
          color={i === pickerIndex ? "cyan" : undefined}
          bold={i === pickerIndex}
        >
          {i === pickerIndex ? ">" : " "}{" "}
          {c.isDir ? `${c.path}/` : c.path}
        </Text>
      ))
    )}
    <Text dimColor>Tab/Enter insertan · Esc cierra el picker</Text>
  </Box>
) : null}
```

- [ ] En la lista de messages (`.slice(-8).map`), si `m.role === "user"`, anexar `formatAttachSuffix(m)` al contenido truncado.

- [ ] Al pulsar `m` (hoy línea 603), log: `"@ abre picker · Tab/Enter insertan · Esc cierra picker · Enter vacío cancela"`.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(attach): TUI compose @ picker with Tab/Enter/Escape"
```

---

## Task 6: Web — compositor, chips, hostname del daemon, timeline

**Files:**

- Create: `web/src/lib/mentions.ts`
- Create: `web/src/components/MentionComposer.tsx`
- Create: `web/src/components/AttachmentChips.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/styles/global.css`

El picker Web **no** lee `FileList` del browser ni el disco de la API. Solo `fs.complete` contra el daemon bound. Muestra `hostname · path`. Sin daemon: copy claro. No hay runner de tests en `web/`; la cobertura RPC vive en Task 8.

- [ ] Crear `web/src/lib/mentions.ts` copiando `MENTION_RE`, `ParsedMention`, `parseMentions`, `isPathLikeMentionToken` de `cli/src/llm/mentions.ts` (mismo regex; comentario `keep in sync with cli/src/llm/mentions.ts`). Exportar también:

```ts
export function activeMention(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const slice = text.slice(0, cursor);
  const at = slice.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(slice[at - 1]!)) return null;
  const rest = slice.slice(at + 1);
  if (/\s/.test(rest)) return null;
  if (/^\S/.test(text.slice(cursor))) return null;
  return { start: at, query: rest };
}
```

- [ ] Extender `Connection` en `web/src/lib/hooks.ts` (hoy no tiene `clientKind` ni `hostname`; el API **ya** devuelve `clientKind`):

```ts
export type Connection = {
  connectionId?: string;
  id?: string;
  workspaceId?: string | null;
  path?: string | null;
  clientKind?: "client" | "daemon";
  hostname?: string | null;
  connectedAt?: string;
};
```

- [ ] Extender `WsRequest` en `web/src/lib/ws-client.ts` con `query?: string`, `hostname?: string`, `requestId?: string`, `limit?: number`.

- [ ] Extender el tipo de `request` en `web/src/lib/ws-context.tsx` (`WsContextValue.request` y el `partial` interno) con `query?: string`. Sin eso TypeScript rechaza `useWsFsComplete`.

- [ ] En `web/src/lib/ws-hooks.ts`, añadir `useWsFsComplete` y **reemplazar** (no duplicar) `useWsAgentTurn`:

```ts
export type FsCandidate = { path: string; isDir: boolean };

export function useWsFsComplete() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; query: string }) =>
      ws.request({
        type: "fs.complete",
        chatId: input.chatId,
        query: input.query,
      }),
  });
}

export function useWsAgentTurn() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      prompt: string;
      mentions?: string[];
    }) =>
      ws.request({
        type: "agent.turn.request",
        chatId: input.chatId,
        prompt: input.prompt,
        metadata: input.mentions?.length
          ? { mentions: input.mentions }
          : undefined,
      }),
  });
}
```

- [ ] Crear `web/src/components/AttachmentChips.tsx`:

```tsx
import { parseMentions } from "../lib/mentions";

export type AttachmentMeta = {
  path?: string;
  kind?: string;
  status?: string;
};

export function AttachmentChips({
  content,
  attachments,
}: {
  content: string;
  attachments?: AttachmentMeta[] | null;
}) {
  const fromMeta = (attachments || []).map((a) => ({
    path: String(a.path || ""),
    kind: String(a.kind || "text"),
    status: String(a.status || "ok"),
  }));
  const fromText = parseMentions(content).map((m) => ({
    path: m.path,
    kind: fromMeta.find((x) => x.path === m.path)?.kind || "text",
    status: fromMeta.find((x) => x.path === m.path)?.status || "ok",
  }));
  const items = fromMeta.length ? fromMeta : fromText;
  if (!items.length) return null;
  return (
    <div className="attach-row">
      {items.map((a) => (
        <span
          key={a.path}
          className={`attach-chip ${a.kind === "image" ? "image" : ""} ${a.status !== "ok" ? "err" : ""}`}
        >
          @{a.path}
          {a.kind === "image" ? " · imagen" : ""}
          {a.kind === "directory" ? " · dir" : ""}
          {a.kind === "binary" ? " · binario" : ""}
          {a.status !== "ok" ? ` · ${a.status}` : ""}
        </span>
      ))}
    </div>
  );
}
```

- [ ] Crear `web/src/components/MentionComposer.tsx` como componente controlado.

Props:

```ts
type Props = {
  chatId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  daemonLabel: string | null;
  daemonError: string | null;
  textareaId?: string;
};
```

Comportamiento obligatorio:

1. `<textarea>` controlado con `value`/`onChange`. En `onChange` y `onSelect`/`onKeyUp` leer `event.currentTarget.selectionStart` y calcular `activeMention(value, cursor)`.
2. Si hay mención activa y **no** hay `daemonError`: debounce 80ms (`useRef` + `setTimeout`), llamar `useWsFsComplete().mutateAsync({ chatId, query })`. Guardar `candidates` (slice 0..10) desde `(res.data as { candidates?: FsCandidate[]; hostname?: string; cwd?: string }).candidates`. Guardar header `{hostname} · {cwd}` desde `data` si viene.
3. Si `fs.complete` falla: mostrar `err.message` en el panel; **no** insertar un attach falso.
4. Click o Enter con ítem resaltado: reemplazar desde `mention.start` hasta el cursor por `@path` (si `isDir`, `@path/`; si hay whitespace, `@"path"`) + espacio; cerrar picker. Un solo path por selección.
5. Flechas arriba/abajo con picker abierto mueven el highlight; `preventDefault` para que no muevan el caret del textarea. Enter con picker abierto inserta (`preventDefault`), no envía el form.
6. `candidates.length === 0` y query no vacío → texto `"Sin coincidencias"`.
7. Header: `data.hostname · data.cwd` o `daemonLabel`. Si `daemonError`, el cuerpo del picker es solo ese mensaje: `"No hay filesystem disponible. Abre CLI (chavez headless workspace open) o TUI (chavez tui) en este path."`
8. Debajo del textarea, `<AttachmentChips content={value} />`.
9. No uses `<input type="file">`. No leas `event.dataTransfer.files`.

Implementación de referencia (usar tal cual, ajustando imports):

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatQueryError } from "../lib/hooks";
import { activeMention } from "../lib/mentions";
import { useWsFsComplete, type FsCandidate } from "../lib/ws-hooks";
import { AttachmentChips } from "./AttachmentChips";

export function MentionComposer({
  chatId,
  value,
  onChange,
  disabled,
  daemonLabel,
  daemonError,
  textareaId,
}: {
  chatId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  daemonLabel: string | null;
  daemonError: string | null;
  textareaId?: string;
}) {
  const complete = useWsFsComplete();
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<FsCandidate[]>([]);
  const [hi, setHi] = useState(0);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [header, setHeader] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mention = activeMention(value, cursor);
  const pickerOpen = Boolean(mention);

  useEffect(() => {
    if (!mention || daemonError) {
      setItems([]);
      setRpcError(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void complete
        .mutateAsync({ chatId, query: mention.query })
        .then((res) => {
          const data = (res.data || {}) as {
            hostname?: string | null;
            cwd?: string | null;
            candidates?: FsCandidate[];
          };
          const next = (data.candidates || []).slice(0, 10);
          setItems(next);
          setHi(0);
          setRpcError(null);
          if (data.hostname || data.cwd) {
            setHeader(`${data.hostname || "daemon"} · ${data.cwd || ""}`);
          }
        })
        .catch((err) => {
          setItems([]);
          setRpcError(formatQueryError(err));
        });
    }, 80);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [mention?.start, mention?.query, chatId, daemonError]);

  function insert(c: FsCandidate) {
    if (!mention) return;
    const raw = c.isDir ? `${c.path}/` : c.path;
    const token = /\s/.test(raw) ? `@"${raw}"` : `@${raw}`;
    const next = value.slice(0, mention.start) + token + " " + value.slice(cursor);
    onChange(next);
    setItems([]);
    setCursor(mention.start + token.length + 1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!pickerOpen || daemonError) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter" && items[hi]) {
      e.preventDefault();
      insert(items[hi]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setItems([]);
    }
  }

  const headerText = header || daemonLabel || "daemon · (cwd)";
  const bodyError = daemonError || rpcError;

  return (
    <div className="composer-wrap">
      <textarea
        id={textareaId}
        rows={3}
        required
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        placeholder="Escribe @ para adjuntar un archivo del daemon"
      />
      <AttachmentChips content={value} />
      {pickerOpen && (
        <div className="mention-picker" role="listbox">
          <header>{headerText}</header>
          {bodyError ? (
            <p className="error" style={{ margin: "0.5rem 0.7rem" }}>
              {bodyError}
            </p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ margin: "0.5rem 0.7rem" }}>
              Sin coincidencias
            </p>
          ) : (
            items.map((c, i) => (
              <button
                type="button"
                key={c.path}
                className={`pick ${i === hi ? "active" : ""}`}
                onClick={() => insert(c)}
              >
                {c.isDir ? `${c.path}/` : c.path}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  - Importar `useSession`, `useConnections`, `MentionComposer`, `AttachmentChips`, `parseMentions`.
  - `const sessionId = chat.data?.chat?.sessionId`.
  - `const session = useSession(sessionId || "", Boolean(sessionId) && signedIn)`.
  - `const connections = useConnections(signedIn)`.
  - `const wsPath = session.data?.workspace?.path`.
  - `const daemon = (connections.data || []).find((c) => c.clientKind === "daemon" && c.path === wsPath)`.
  - `const daemonLabel = daemon ? \`${daemon.hostname || "daemon"} · ${daemon.path}\` : null`.
  - `const daemonError = connections.isLoading || daemon ? null : "No hay filesystem disponible. Abre CLI (chavez headless workspace open) o TUI (chavez tui) en este path."`.
  - Sustituir el `<textarea id="prompt">` del form agente por:

```tsx
<MentionComposer
  textareaId="prompt"
  chatId={chatId}
  value={prompt}
  onChange={setPrompt}
  disabled={agent.isPending || ws.status !== "open"}
  daemonLabel={daemonLabel}
  daemonError={daemonError}
/>
```

  - En `onAgent`:

```ts
await agent.mutateAsync({
  chatId,
  prompt: prompt.trim(),
  mentions: parseMentions(prompt.trim()).map((m) => m.path),
});
```

  El error de `agent.turn.request` sin daemon ya es el mismo string; `formatQueryError` lo muestra. El picker además explica el filesystem. El form `onSubmit` sigue siendo el que envía el turn (Enter en textarea sin picker abierto).

  - En el timeline, para `role === "user"`, **encima** del `<pre>`:

```tsx
<AttachmentChips
  content={m.content}
  attachments={
    (m.metadata as { attachments?: AttachmentMeta[] } | null)?.attachments
  }
/>
<pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>{m.content}</pre>
```

  Importar `AttachmentMeta` desde `./AttachmentChips`.

- [ ] CSS en `web/src/styles/global.css` (al final; variables `--border`, `--muted`, `--fg`, `--ok`, `--accent-dim`, `--mono` ya existen):

```css
.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0.35rem 0 0.15rem;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: #12181f;
  font-family: var(--mono);
  font-size: 0.78rem;
  color: #8ec8ff;
}
.attach-chip.image { color: var(--ok); }
.attach-chip.err {
  color: #ff8f8f;
  border-color: color-mix(in srgb, #ff8f8f 40%, var(--border));
}
.mention-picker {
  margin-top: 0.35rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #12181f;
  max-height: 16rem;
  overflow: auto;
}
.mention-picker header {
  padding: 0.4rem 0.7rem;
  font-size: 0.78rem;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.mention-picker button.pick {
  display: block;
  width: 100%;
  text-align: left;
  margin: 0;
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 0.82rem;
  font-weight: 400;
  padding: 0.35rem 0.7rem;
}
.mention-picker button.pick.active,
.mention-picker button.pick:hover {
  background: var(--accent-dim);
}
.composer-wrap { position: relative; }
```

- [ ] Verificar layout: `.shell` max-width 960px. El picker no debe desbordar. En viewport ~375px el header `hostname · path` wrapea (`overflow-wrap: anywhere`). No hace falta media query nueva.

- [ ] Commit:

```bash
git add web/src/lib/mentions.ts web/src/components/MentionComposer.tsx \
  web/src/components/AttachmentChips.tsx web/src/lib/hooks.ts \
  web/src/lib/ws-client.ts web/src/lib/ws-context.tsx web/src/lib/ws-hooks.ts \
  web/src/components/ChatDetailPanel.tsx web/src/styles/global.css
git commit -m "feat(attach): web @ picker from daemon fs with hostname chips"
```

---

## Task 7: OpenAPI, CLI headless y tipos de conexión

**Files:**

- Modify: `api/openapi/openapi.yaml`
- Modify: `cli/src/index.ts`

CLI `chat ask` (`cli/src/commands/headless.ts`) ya manda el prompt crudo al daemon vía `agent.turn.request`; con Task 4, `@src/app.ts` se hidrata sin cambios de comando. `chat watch` imprime el JSON de `message.appended` (incluye `metadata.attachments`). Esta task documenta el contrato y asegura que `GET /connections` expone `hostname` + `clientKind`.

- [ ] En `api/openapi/openapi.yaml` schema `ConnectionPublic` (hoy solo `connectionId`, `workspaceId`, `path`, `connectedAt`), añadir:

```yaml
clientKind:
  type: string
  enum: [client, daemon]
hostname:
  type: string
  nullable: true
  description: os.hostname() del proceso daemon; null en clientes web
```

- [ ] En la descripción de `/ws` (línea ~722, lista **Tipos implementados**), añadir: `fs.complete` (client→API, correlacionado), `fs.complete.result` (daemon→API), y que `workspace.bind` acepta `hostname` cuando `clientKind=daemon`. Push nuevo: `fs.complete.dispatch`.

- [ ] En schema `WsClientWorkspaceBind`, añadir `hostname` (string, opcional) y `clientKind` (`client` | `daemon`).

- [ ] Añadir schema `WsClientFsComplete` junto a los otros `WsClient*` (después de `WsClientChatGet`):

```yaml
WsClientFsComplete:
  allOf:
    - $ref: "#/components/schemas/ClientMessage"
    - type: object
      required: [type, id, chatId]
      properties:
        type:
          type: string
          enum: [fs.complete]
        chatId:
          type: string
        query:
          type: string
          description: Prefijo tras @; vacío = top 10 del cwd del daemon
      example:
        type: fs.complete
        id: "p1"
        chatId: "chat-uuid"
        query: "src/au"
```

Respuesta `data`: `{ hostname, cwd, candidates: [{ path, isDir }] }` (máx 10). Error sin daemon: el mismo string que `agent.turn.request`.

- [ ] En schema `ChatMessage` (hoy no documenta `metadata`; la columna jsonb ya existe), añadir:

```yaml
metadata:
  type: object
  additionalProperties: true
  nullable: true
  description: |
    User attaches: `{ attachments: [{ path, kind, status, byteSize, mime,
    truncated, listing, hydratedText, sha256 }] }`. Never `imageBase64`.
    Tool rows: toolName, toolCallId, status, input, output.
```

- [ ] En `cli/src/index.ts` `usage()`, una línea bajo `chat ask`:

```
  chavez headless chat ask <chatId> 'explica @src/app.ts'  # daemon hidrata @
```

No hay picker interactivo en headless; el parser del daemon cubre el escenario Gherkin.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml cli/src/index.ts
git commit -m "docs(attach): OpenAPI fs.complete and connection hostname"
```

---

## Task 8: Smokes de integración (picker, hidratación, sync, guardas)

**Files:**

- Create: `cli/scripts/attach-smoke.ts`
- Test: `cli/scripts/attach-smoke.ts` (live, no unit)

- [ ] Crear `cli/scripts/attach-smoke.ts`:

```ts
/**
 * Live attach smoke.
 * Requires: API up, CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json, Claude linked.
 * This script binds as daemon so fs.complete and turns run in-process.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { historyFromChatMessages } from "../src/llm/history";
import { publishAgentTurn } from "../src/llm/publish-turn";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const bindPath = cwdPath();
const daemon = new ChavezWsClient(token);
const client = new ChavezWsClient(token);
await daemon.connect();
await client.connect();
const bound = await daemon.bind(bindPath, "daemon");
if (!bound.ok) throw new Error(bound.error || "daemon bind failed");
const clientBind = await client.bind(bindPath, "client");
if (!clientBind.ok) throw new Error(clientBind.error || "client bind failed");

const session = await client.request({ type: "session.create", title: "attach-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await client.request({
  type: "chat.create",
  sessionId,
  title: "attach-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const complete = await client.request({
  type: "fs.complete",
  chatId,
  query: "package",
});
if (!complete.ok) throw new Error(complete.error || "fs.complete failed");
const data = complete.data as {
  hostname?: string;
  cwd?: string;
  candidates?: Array<{ path: string; isDir: boolean }>;
};
assert.ok(data.hostname && data.hostname.length > 0, "hostname");
assert.ok((data.candidates || []).length <= 10, "max 10");
assert.ok(
  (data.candidates || []).every((c) => !c.path.includes("..")),
  "no escapes",
);
console.log("fs.complete OK", data.hostname, data.candidates?.slice(0, 3));

await publishAgentTurn({
  client: daemon,
  chatId,
  prompt: "Responde solo pong. Contexto: @package.json",
  cwd: bindPath,
  token,
});
const afterOk = await client.request({ type: "chat.get", chatId });
const msgs = (
  afterOk.data as {
    messages: Array<{
      role: string;
      content: string;
      metadata?: { attachments?: Array<{ path: string; kind: string; status: string }> };
    }>;
  }
).messages;
const userOk = [...msgs].reverse().find((m) => m.role === "user");
assert.ok(userOk?.content.includes("@package.json"));
assert.equal(userOk?.metadata?.attachments?.[0]?.path, "package.json");
assert.equal(userOk?.metadata?.attachments?.[0]?.status, "ok");
console.log("hydrate text attach OK");

let missingErr = "";
try {
  await publishAgentTurn({
    client: daemon,
    chatId,
    prompt: "lee @no-existe-xyz.ts",
    cwd: bindPath,
    token,
  });
} catch (e) {
  missingErr = e instanceof Error ? e.message : String(e);
}
assert.match(missingErr, /not found|no-existe/i);
const afterMiss = await client.request({ type: "chat.get", chatId });
const missUser = (
  afterMiss.data as {
    messages: Array<{ role: string; metadata?: { attachments?: Array<{ status: string }> } }>;
  }
).messages
  .filter((m) => m.role === "user")
  .pop();
assert.equal(missUser?.metadata?.attachments?.[0]?.status, "missing");
console.log("missing path OK");

let escapeErr = "";
try {
  await publishAgentTurn({
    client: daemon,
    chatId,
    prompt: "lee @../../.ssh/id_rsa",
    cwd: bindPath,
    token,
  });
} catch (e) {
  escapeErr = e instanceof Error ? e.message : String(e);
}
assert.match(escapeErr, /outside workspace|forbidden/i);
console.log("path escape OK");

await publishAgentTurn({
  client: daemon,
  chatId,
  prompt: "hola user@example.com no es un attach",
  cwd: bindPath,
  token,
});
const afterMail = await client.request({ type: "chat.get", chatId });
const mailUser = (
  afterMail.data as {
    messages: Array<{
      role: string;
      content: string;
      metadata?: { attachments?: unknown[] };
    }>;
  }
).messages
  .filter((m) => m.role === "user")
  .pop();
assert.ok(mailUser?.content.includes("user@example.com"));
assert.ok(!mailUser?.metadata?.attachments?.length);
console.log("email not attach OK");

const markerDir = join(bindPath, ".chavez-attach-smoke");
mkdirSync(markerDir, { recursive: true });
const markerFile = join(markerDir, "MARK.txt");
writeFileSync(markerFile, "MARKER=attach-smoke-42\n");
await publishAgentTurn({
  client: daemon,
  chatId,
  prompt: "memoriza el attach @.chavez-attach-smoke/MARK.txt",
  cwd: bindPath,
  token,
});
writeFileSync(markerFile, "MARKER=CHANGED-ON-DISK\n");
const snap = await client.request({ type: "chat.get", chatId });
const hist = historyFromChatMessages(
  (
    snap.data as {
      messages: Array<{
        role?: string;
        content?: string;
        metadata?: Record<string, unknown> | null;
      }>;
    }
  ).messages,
  "follow-up",
);
assert.match(hist.map((h) => h.content).join("\n"), /attach-smoke-42/);
assert.doesNotMatch(hist.map((h) => h.content).join("\n"), /CHANGED-ON-DISK/);
console.log("snapshot not re-read OK");

daemon.close();
client.close();
console.log("ATTACH SMOKE PASS");
```

`@../../.ssh/id_rsa` ahora **sí** matchea el parser (Task 1) y el sandbox lo rechaza — no hace falta `mentions:` extra.

- [ ] Correr unitarios siempre (no requieren stack):

```bash
cd cli && bun test src/llm
cd ../api && bun test src/ws/pending.test.ts
```

- [ ] Correr smoke live cuando el stack esté up:

```bash
# terminal A
bun run --filter @chavez/api start
# terminal B (repo root, logged in, Claude linked)
bun run cli/scripts/attach-smoke.ts
```

- [ ] `bun run cli/scripts/ws-sync-smoke.ts` sigue pasando: broadcast de append y `agent.turn.request` sin daemon sigue devolviendo el error de daemon (el smoke no bindea daemon).

- [ ] Commit:

```bash
git add cli/scripts/attach-smoke.ts
git commit -m "test(attach): live smoke for picker hydration guards and history snapshot"
```

---

## Verificación de escenarios Gherkin

| Escenario | Dónde se cubre |
|---|---|
| Autocompletar `@`, máx 10, cwd del daemon | Task 2 `completeWorkspace`; Task 5 TUI; Task 6 Web `fs.complete` |
| Lista se afina con prefijo; orden específico; vacío sin attach falso | Task 2 ranking; UI "Sin coincidencias" Tasks 5–6 |
| Selección de uno en uno; picker se cierra; otro `@` para más | Tasks 5–6 insertan un token y cierran |
| Web usa FS del daemon; hostname · path; sin daemon explica | Tasks 3–4 RPC; Task 6 header + `daemonError` |
| Hostname evita workspace equivocado; no lista API ni browser | `completeWorkspace(cwd daemon)`; picker no usa `<input file>` |
| Chip/token `@src/auth.ts`; texto crudo inequívoco | `AttachmentChips` + prompt crudo |
| Varios archivos en el mismo prompt | `mergeMentions` + `hydrateAll` |
| Directorio lista máx 10 hijos | `DIR_LISTING_LIMIT` |
| Path a mano `@package.json` | `parseMentions` + hydrate |
| CLI headless `@src/app.ts` | Task 4 daemon + Task 7 ask |
| TUI Tab/Enter insertan; Esc cierra picker; Enter vacío no envía | Task 5 |
| Daemon hidrata antes del LLM; API no tiene el archivo | `publishAgentTurn` lee disco local |
| Attach texto truncado con marca | `TEXT_ATTACH_MAX_BYTES` |
| Imagen como imagen, chip indica imagen | `imageBase64` → SDK blocks; chip `· imagen` |
| Binario permitido, no UTF-8 basura; fallo visible si el modelo no puede | `kind: "binary"` stub; SDK error → `chat.stream.error` |
| Mensaje persistido muestra menciones al recargar | `content` + `metadata.attachments` |
| Follow-up recuerda attach; disco no se rehidrata | `formatUserContentForHistory` |
| Web dispara; daemon hidrata; stream en las 3 superficies | `agent.turn.request` existente + hydrate |
| Inexistente: no LLM silencioso; error visible | `blockingAttachError` |
| `../.ssh` / absoluto: reject, no leer | parse captura + `PathEscapeError` |
| Demasiado grande: aviso + truncate o reject | texto truncate; imagen `too_large` |
| Sin daemon = mismo error que turn | `fs.complete` y `agent.turn.request` mismo string |
| `user@example.com` / `@decorator` no son attach | lookbehind + path-like filter |

---

## Orden de implementación

1 → 2 (libs puras) → 3 (API RPC) → 4 (daemon + LLM) → 5 (TUI) y 6 (Web) en paralelo tras 4 → 7 docs → 8 smokes.

No mezclar ignore/secrets, tools, modos, ni Cursor ejecutable en estos commits.
