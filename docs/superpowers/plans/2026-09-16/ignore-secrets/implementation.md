# Ignore and secrets Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, árbol de búsqueda/preview (eso es el [plan 18](../web-file-tree/plan.md) sobre el RPC `fs.tree` de este plan), commit/push/PR (eso es el [plan 7](../git-workspace/plan.md) — este plan solo exporta la guarda), ni sandbox de red (plan 26). Spec: [`plan.md`](./plan.md). Si un sibling (`attach-files`, `agent-tools`, `execution-modes`, `invariants`) ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** `@`, grep/read/glob, el árbol Web y los diffs respetan el mismo ignore. El picker no gasta el tope de 10 en `node_modules` ni en secrets. Un path ignorado escrito a mano no se silencia: en `ask` se confirma (junk) o se redacta/rechaza (secret); en `auto`/`plan` se avisa y no se hidrata. El output visible de tools redacta API keys. El vault de Chavez (`~/.chavez/config.json` y ciphertext) **nunca** aparece en la timeline. Un edit de `.env` se bloquea. Git (plan 7) reutiliza la misma guarda y no commitea secrets.

**Architecture:** El filesystem real vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). El motor de ignore y la redacción corren **solo ahí**. API y browser no listan disco: reenvían `fs.complete` / `fs.tree` al daemon bound y hacen fan-out de mensajes ya redactados. Web, TUI y `chat watch` observan el mismo chat.

```
.gitignore + .git/info/exclude + nested + .chavezignore
        + HARNESS_JUNK + HARNESS_SECRET + ~/.chavez  + huge
        |
        v
  loadIgnore(cwd)  →  IgnoreSet
        |
        +-- completeWorkspace (@ picker, máx 10)     no junk/secret/vault/huge
        +-- listWorkspaceDir  (fs.tree)              no node_modules por defecto
        +-- hydrateOne (@ attach)                    force / redact / notice
        +-- denyIfIgnored (Read/Grep/Glob/Write/Edit)
        +-- sanitizeToolOutput (redact keys, drop vault)
        +-- redactDiff + gitCommitBlockedReason      (plan 6 / plan 7)
        |
        v
  API persist+broadcast (cinturón redactJson) → Web / TUI / watch
```

Estado actual que este plan extiende (no reescribir):

- Hoy **no hay** gitignore ni redacción de ignore. `grep` del workspace no encuentra `ignore` de producto.
- [attach-files](../attach-files/implementation.md) crea `cli/src/llm/fs-complete.ts` con `SKIP_DIR_NAMES` hardcodeado (`node_modules`, `.git`, `dist`, …) y dice explícitamente que ignore/secrets **no** entra ahí. Esta fase sustituye ese set por `loadIgnore`.
- [attach-files](../attach-files/implementation.md) hidrata cualquier path in-cwd. Esta fase clasifica junk/secret/vault **antes** de leer bytes.
- [agent-tools](../agent-tools/implementation.md) redacta `sk-ant-` / `ghp_` / `xox` en `tool-display.ts` y dice que ignore de grep es este plan. [invariants](../invariants/implementation.md) Task 6 crea `cli/src/llm/redact.ts` + `api/src/lib/redact.ts` (más patrones, vault no viaja al LLM). Esta fase **amplía** esos módulos (líneas `.env`, PEM, vault path) y los usa en grep/diff.
- [execution-modes](../execution-modes/implementation.md) persiste `plan|auto|ask`. Lecturas **no** piden confirmación (invariante). La confirmación de este plan es solo para **hidratar un attach junk ignorado** en `ask`, no para Read/Grep/Glob.
- Claude Agent SDK `query` sigue con `cwd` = workspace. No hay `ignore` nativo que Chavez controle: filtramos picker/tree/hydrate y `canUseTool` / post-filtro de output.
- Vault de providers vive cifrado en `api` (`provider_credentials.ciphertext`). El token CLI vive en `~/.chavez/config.json` (`cli/src/config.ts`). Ninguno de los dos debe hidratarse ni pintarse.
- Web `WorkspaceDetailPanel.tsx` no tiene árbol. El [plan 18](../web-file-tree/plan.md) añade búsqueda/preview; esta fase deja el RPC `fs.tree` + un listado raíz que ya aplica ignore y muestra `hostname · path`.
- Cursor no ejecuta turns hasta el [plan 4](../cursor-provider/plan.md). El ignore es del daemon, no del provider.

**Tech Stack:** Bun, Hono WebSocket, Drizzle `chat_messages.metadata` jsonb, Claude Agent SDK `query` + `canUseTool`, Ink TUI, Astro/React web. Sin dependencia npm nueva (el matcher de gitignore es nuestro).

**Global Constraints:**

1. El filesystem se lee **solo** en el daemon (cwd del workspace). API y browser no listan, no hidratan, no aplican gitignore sobre el disco del servidor.
2. Sin daemon bound, `fs.complete`, `fs.tree` y `agent.turn.request` fallan con **el mismo string**: `"No daemon bound for this workspace. Run: chavez headless workspace open"`. El árbol Web no lista el disco de la API.
3. Picker `@`: máximo **10** candidatos **después** de ignore. `node_modules` no consume el tope.
4. Fuentes de ignore (unión). Las capas secret/vault/huge **no** se pueden deshacer con `!` en gitignore:

   | Capa | Fuente | ¿`!` la anula? |
   |---|---|---|
   | vault | `~/.chavez/**` (abs) y `.chavez/` dentro del cwd | no |
   | secret | `HARNESS_SECRET_PATTERNS` (`.env`, keys, pem, …) salvo `.env.example` / `.env.sample` / `.env.template` | no |
   | huge | size ≥ `HUGE_FILE_BYTES`, o binario ≥ `HUGE_BINARY_BYTES` | no |
   | junk harness | `HARNESS_JUNK_DIR_NAMES` (`.git`, `node_modules`, …) | no |
   | git | `.gitignore` (nested), `.git/info/exclude`, `.chavezignore` | sí (negación git) |

5. Lecturas (Read/Grep/Glob/LS) **no** piden confirmación. Un path ignorado en tool se **deniega con mensaje** (junk) o se **redacta** (secret). No se silencia.
6. `@` junk escrito a mano que existe: en `ask` → `awaiting_approval` (tool canónica `attach`) y si aprueban se hidrata; en `auto`/`plan` → aviso visible y **no** se hidrata. El turn no finge que el archivo llegó al LLM.
7. `@` secret (`.env`, pem, keys): nunca se hidrata en crudo. Por defecto se rechaza el archivo (notice). En `ask`, si el usuario aprueba, se hidrata **redactado**. Vault: siempre `forbidden`, nunca force, el turn **no** llama al LLM si el único attach bloqueante es vault/escape.
8. Output de tools, diffs y stream se redactan **antes** de persistir y de broadcast. El cinturón de API (`api/src/lib/redact.ts`) vuelve a redactar.
9. Write/Edit de secret o vault se **bloquean** en todos los modos (`SECRET_WRITE_DENIED`). No hay diff con valores de `.env`. `gitCommitBlockedReason` es la guarda que el plan 7 debe llamar.
10. Web, TUI y `chat watch` ven el mismo notice de attach ignorado y el mismo output redactado.
11. 1 turn por daemon. Ignore no cambia la cola.
12. Claude es el provider ejecutable. Cursor vinculado no ejecuta; el ignore aplica igual al picker/tree.
13. Fuera de alcance: Cursor cloud, upload desde el navegador, notificaciones OS, commitear (plan 7), búsqueda/preview del árbol (plan 18).

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `FS_COMPLETE_LIMIT` | `10` (ya en attach-files) |
| `DIR_LISTING_LIMIT` | `10` (ya en attach-files) |
| `FS_TREE_MAX_ENTRIES` | `200` |
| `FS_TREE_TIMEOUT_MS` | `5000` |
| `HUGE_FILE_BYTES` | `8_000_000` |
| `HUGE_BINARY_BYTES` | `1_000_000` |
| `REDACT_REPLACEMENT` | `"***"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `IGNORED_ATTACH_NOTICE` | ``Ignored path (not hydrated): ${path} (${reason})`` |
| `SECRET_ATTACH_DENIED` | ``Refusing to attach secret file: ${path}`` |
| `VAULT_ATTACH_DENIED` | ``Refusing to attach Chavez vault: ${path}`` |
| `IGNORED_READ_DENIED` | ``Path is ignored: ${path} (${reason}). Not read.`` |
| `SECRET_READ_REDACTED` | ``Secret file ${path} — values redacted`` |
| `SECRET_WRITE_DENIED` | ``Write blocked: ${path} looks like a secret (.env/key/vault). Git will not commit it.`` |
| `VAULT_DENIED` | `"Chavez vault is not readable or writable by tools"` |
| `HUGE_SKIP_REASON` | ``File too large to index (${bytes} bytes)`` |
| `FORCE_ATTACH_PROMPT` | ``Attach ignored path ${path}? (${reason})`` |
| `GIT_SECRET_COMMIT_DENIED` | ``Refusing to commit secret path: ${path}`` |
| `HARNESS_JUNK_DIR_NAMES` | `.git`, `node_modules`, `dist`, `.next`, `target`, `coverage`, `vendor`, `__pycache__`, `.venv`, `venv`, `.turbo`, `.output`, `.cache` |
| `ASK_APPROVAL_TIMEOUT_MS` | `300_000` (igual que plan 3) |

`IgnoreClass`: `"none"` \| `"junk"` \| `"secret"` \| `"vault"` \| `"huge"`.

Attach statuses nuevos (además de los de attach-files): `"ignored"` \| `"secret"` \| `"vault"`. `blockingAttachError` **no** trata `ignored`/`secret` como bloqueo del turn (se salta el archivo con notice). `vault` y `forbidden` (escape) **sí** bloquean.

Nombres canónicos: la tool sintética de force-attach se pinta `attach` (sdkName `AttachIgnored`).

---

## Task 1: Motor de ignore — gitignore + harness + vault + huge

**Files:**

- Create: `cli/src/llm/ignore-patterns.ts`
- Create: `cli/src/llm/ignore.ts`
- Test: `cli/src/llm/ignore.test.ts`
- Modify: `cli/package.json`

Módulo puro de disco local (lee `.gitignore`, no red). TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/ignore-patterns.ts`:

```ts
export const REDACT_REPLACEMENT = "***";

export const HUGE_FILE_BYTES = 8_000_000;
export const HUGE_BINARY_BYTES = 1_000_000;

export const HARNESS_JUNK_DIR_NAMES = [
  ".git",
  "node_modules",
  "dist",
  ".next",
  "target",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  ".output",
  ".cache",
] as const;

/** gitignore-style. Applied as secret class; `!` exceptions are secret-safe examples. */
export const HARNESS_SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "!**/.env.sample",
  "!**/.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa.pub",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  "**/.aws/credentials",
  "**/credentials.json",
  "**/secrets.json",
  "**/*-service-account.json",
] as const;

export const VAULT_DIR_NAME = ".chavez";

export type IgnoreClass = "none" | "junk" | "secret" | "vault" | "huge";

export function reasonForClass(cls: IgnoreClass, extra?: string): string {
  if (cls === "vault") return "chavez vault";
  if (cls === "secret") return extra || "harness secret";
  if (cls === "huge") return extra || "huge file";
  if (cls === "junk") return extra || "ignored";
  return extra || "";
}
```

- [ ] Crear `cli/src/llm/ignore.ts`. Matcher gitignore (subset suficiente para los escenarios: `node_modules`, `*.pem`, `**/.env`, negación, trailing `/`, anchored `/src`, nested). Un directorio ignorado ignora a sus hijos salvo negación más específica:

```ts
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  HARNESS_JUNK_DIR_NAMES,
  HARNESS_SECRET_PATTERNS,
  HUGE_BINARY_BYTES,
  HUGE_FILE_BYTES,
  VAULT_DIR_NAME,
  type IgnoreClass,
} from "./ignore-patterns";
import { relativePosix, toPosix } from "./workspace-path";

export type IgnoreRule = {
  base: string;
  raw: string;
  negate: boolean;
  dirOnly: boolean;
  /** secret harness rules cannot be undone by gitignore. */
  locked: boolean;
  class: Exclude<IgnoreClass, "none" | "huge">;
  re: RegExp;
};

export type IgnoreSet = {
  cwd: string;
  vaultRoot: string;
  rules: IgnoreRule[];
};

export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegex(ch: string): string {
  return /[\\^$+{}[\]()|.]/.test(ch) ? `\\${ch}` : ch;
}

/** Convert one gitignore glob to a RegExp matching a posix relative path. */
export function globToRegExp(glob: string, anchored: boolean): RegExp {
  let src = "";
  let i = 0;
  while (i < glob.length) {
    const a = glob[i];
    const b = glob[i + 1];
    if (a === "*" && b === "*") {
      if (glob[i + 2] === "/") {
        src += "(?:.*/)?";
        i += 3;
        continue;
      }
      src += ".*";
      i += 2;
      continue;
    }
    if (a === "*") {
      src += "[^/]*";
      i += 1;
      continue;
    }
    if (a === "?") {
      src += "[^/]";
      i += 1;
      continue;
    }
    src += escapeRegex(a!);
    i += 1;
  }
  const body = anchored ? `^${src}` : `(?:^|/)${src}`;
  return new RegExp(`${body}(?:/.*)?$`);
}

export function parseIgnoreLine(
  line: string,
  base: string,
  cls: IgnoreRule["class"],
  locked: boolean,
): IgnoreRule | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed || trimmed.startsWith("#")) return null;
  let raw = trimmed;
  let negate = false;
  if (raw.startsWith("!")) {
    negate = true;
    raw = raw.slice(1);
  }
  raw = raw.replace(/\\ /g, " ");
  let dirOnly = false;
  if (raw.endsWith("/") && raw !== "/") {
    dirOnly = true;
    raw = raw.slice(0, -1);
  }
  if (!raw || raw === ".") return null;
  const anchored = raw.startsWith("/") || raw.slice(0, -1).includes("/");
  const glob = raw.startsWith("/") ? raw.slice(1) : raw;
  return {
    base: toPosixRel(base),
    raw,
    negate,
    dirOnly,
    locked,
    class: cls,
    re: globToRegExp(glob, anchored && !glob.includes("**")),
  };
}

function loadLines(absFile: string): string[] {
  try {
    return readFileSync(absFile, "utf8").split("\n");
  } catch {
    return [];
  }
}

function addPatterns(
  rules: IgnoreRule[],
  patterns: readonly string[],
  base: string,
  cls: IgnoreRule["class"],
  locked: boolean,
) {
  for (const line of patterns) {
    const rule = parseIgnoreLine(line, base, cls, locked);
    if (rule) rules.push(rule);
  }
}

function walkGitignores(cwd: string, rules: IgnoreRule[]) {
  const stack = [cwd];
  const seen = new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const gi = join(dir, ".gitignore");
    if (existsSync(gi)) {
      const base = toPosixRel(relative(cwd, dir));
      addPatterns(rules, loadLines(gi), base === "" ? "" : base, "junk", false);
    }
    const cz = join(dir, ".chavezignore");
    if (existsSync(cz)) {
      const base = toPosixRel(relative(cwd, dir));
      addPatterns(rules, loadLines(cz), base === "" ? "" : base, "junk", false);
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === "." || ent.name === "..") continue;
      if ((HARNESS_JUNK_DIR_NAMES as readonly string[]).includes(ent.name)) {
        continue;
      }
      stack.push(join(dir, ent.name));
    }
  }
}

export function loadIgnore(cwd: string): IgnoreSet {
  const cwdReal = cwd;
  const rules: IgnoreRule[] = [];
  for (const name of HARNESS_JUNK_DIR_NAMES) {
    addPatterns(rules, [name, `${name}/`, `**/${name}`, `**/${name}/`], "", "junk", true);
  }
  addPatterns(rules, HARNESS_SECRET_PATTERNS, "", "secret", true);
  addPatterns(
    rules,
    [VAULT_DIR_NAME, `${VAULT_DIR_NAME}/`, `**/${VAULT_DIR_NAME}`, `**/${VAULT_DIR_NAME}/`],
    "",
    "vault",
    true,
  );
  const exclude = join(cwdReal, ".git", "info", "exclude");
  if (existsSync(exclude)) {
    addPatterns(rules, loadLines(exclude), "", "junk", false);
  }
  walkGitignores(cwdReal, rules);
  return {
    cwd: cwdReal,
    vaultRoot: join(homedir(), VAULT_DIR_NAME),
    rules,
  };
}

function pathUnder(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relUnderBase(rel: string, base: string): string | null {
  if (!base) return rel;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (rel === base) return "";
  if (!rel.startsWith(prefix)) return null;
  return rel.slice(prefix.length);
}

type Hit = { negate: boolean; class: IgnoreRule["class"]; locked: boolean };

function lastHit(set: IgnoreSet, rel: string, isDir: boolean): Hit | null {
  const posix = toPosixRel(rel);
  let hit: Hit | null = null;
  for (const rule of set.rules) {
    const local = relUnderBase(posix, rule.base);
    if (local == null) continue;
    const candidate = local;
    if (rule.dirOnly && !isDir && !candidate.includes("/") && posix === (rule.base ? `${rule.base}/${rule.raw.replace(/\/$/, "")}` : rule.raw.replace(/\/$/, ""))) {
      continue;
    }
    if (!rule.re.test(candidate) && !rule.re.test(posix)) continue;
    if (rule.dirOnly && !isDir && candidate === rule.raw.replace(/\/$/, "") && !posix.startsWith(
      (rule.base ? `${rule.base}/` : "") + rule.raw.replace(/\/$/, "") + "/",
    )) {
      continue;
    }
    hit = { negate: rule.negate, class: rule.class, locked: rule.locked };
  }
  return hit;
}

export type ClassifyOpts = {
  isDir?: boolean;
  size?: number;
  absPath?: string;
  binary?: boolean;
};

/**
 * Walk prefixes so ignoring `node_modules` also ignores `node_modules/pkg/index.js`.
 * Locked secret/vault hits cannot be undone by a later gitignore negation.
 */
export function classifyPath(
  set: IgnoreSet,
  relPath: string,
  opts: ClassifyOpts = {},
): IgnoreClass {
  const posix = toPosixRel(relPath);
  if (!posix || posix === ".") {
    if (opts.absPath && pathUnder(set.vaultRoot, opts.absPath)) return "vault";
    return "none";
  }
  if (opts.absPath && pathUnder(set.vaultRoot, opts.absPath)) return "vault";

  const parts = posix.split("/").filter(Boolean);
  let current: IgnoreClass = "none";
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join("/");
    const isDir = i < parts.length - 1 || Boolean(opts.isDir);
    const hit = lastHit(set, prefix, isDir);
    if (!hit) continue;
    if (hit.negate) {
      if (current === "vault") continue;
      if (current === "secret" && !hit.locked) continue;
      if (hit.locked && hit.class === "secret") {
        current = current === "vault" ? "vault" : "none";
        continue;
      }
      if (current === "junk" && hit.locked) continue;
      current = "none";
      continue;
    }
    if (hit.class === "vault") current = "vault";
    else if (hit.class === "secret" && current !== "vault") current = "secret";
    else if (hit.class === "junk" && current === "none") current = "junk";
  }

  if (current === "none" && !opts.isDir) {
    const size = opts.size ?? 0;
    if (size >= HUGE_FILE_BYTES) return "huge";
    if (opts.binary && size >= HUGE_BINARY_BYTES) return "huge";
  }
  return current;
}

export function isIgnored(
  set: IgnoreSet,
  relPath: string,
  opts: ClassifyOpts = {},
): boolean {
  return classifyPath(set, relPath, opts) !== "none";
}

export function shouldDescend(set: IgnoreSet, relDir: string, absPath?: string): boolean {
  const cls = classifyPath(set, relDir, { isDir: true, absPath });
  return cls === "none";
}

export function classifyAbs(set: IgnoreSet, absPath: string): IgnoreClass {
  let st: { isDirectory(): boolean; size: number } | null = null;
  try {
    st = statSync(absPath);
  } catch {
    st = null;
  }
  const rel = toPosix(relative(set.cwd, absPath));
  if (rel.startsWith("..") || (rel && rel.split(sep)[0] === "..")) {
    return "none";
  }
  return classifyPath(set, rel || ".", {
    isDir: st?.isDirectory() ?? false,
    size: st && !st.isDirectory() ? st.size : undefined,
    absPath,
  });
}
```

Si `cli/src/llm/workspace-path.ts` **no** existe (attach-files no aterrizó), crear el de attach-files Task 1 (`toPosix`, `relativePosix`, `resolveInsideCwd`, `PathEscapeError`) **antes** de este módulo. No reimplementar el sandbox aquí.

Negación: un `!` locked de harness (`.env.example`) deja class `none`. Un `!node_modules/foo` en gitignore **no** reabre `node_modules` (junk harness locked). Los tests de abajo son la spec.

- [ ] Crear `cli/src/llm/ignore.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, globToRegExp, loadIgnore, parseIgnoreLine } from "./ignore";
import { HUGE_FILE_BYTES } from "./ignore-patterns";

describe("globToRegExp", () => {
  test("unanchored node_modules matches nested", () => {
    const re = globToRegExp("node_modules", false);
    expect(re.test("node_modules")).toBe(true);
    expect(re.test("node_modules/pkg/index.js")).toBe(true);
    expect(re.test("apps/web/node_modules/x")).toBe(true);
    expect(re.test("src/node_modules_helpers.ts")).toBe(false);
  });

  test("*.pem", () => {
    const re = globToRegExp("*.pem", false);
    expect(re.test("cert.pem")).toBe(true);
    expect(re.test("secrets/cert.pem")).toBe(true);
    expect(re.test("cert.pem.backup")).toBe(false);
  });
});

describe("parseIgnoreLine", () => {
  test("skips comments and blanks", () => {
    expect(parseIgnoreLine("# hi", "", "junk", false)).toBeNull();
    expect(parseIgnoreLine("  ", "", "junk", false)).toBeNull();
  });

  test("negation", () => {
    const r = parseIgnoreLine("!.env.example", "", "secret", true);
    expect(r?.negate).toBe(true);
  });
});

describe("loadIgnore", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ig-")));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(cwd, ".git", "info"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n*.log\n");
  writeFileSync(join(cwd, "src", "app.ts"), "ok");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  writeFileSync(join(cwd, ".env.example"), "SECRET=\n");
  writeFileSync(join(cwd, "src", "app.log"), "log");
  writeFileSync(join(cwd, "readme.md"), "hi");

  const set = loadIgnore(cwd);

  test("gitignore node_modules", () => {
    expect(classifyPath(set, "node_modules", { isDir: true })).toBe("junk");
    expect(classifyPath(set, "node_modules/pkg/index.js")).toBe("junk");
  });

  test("src is not ignored", () => {
    expect(classifyPath(set, "src/app.ts")).toBe("none");
    expect(classifyPath(set, "readme.md")).toBe("none");
  });

  test("*.log from gitignore", () => {
    expect(classifyPath(set, "src/app.log")).toBe("junk");
  });

  test("harness .env is secret, example is not", () => {
    expect(classifyPath(set, ".env")).toBe("secret");
    expect(classifyPath(set, ".env.example")).toBe("none");
  });

  test("harness .git dir", () => {
    expect(classifyPath(set, ".git", { isDir: true })).toBe("junk");
    expect(classifyPath(set, ".git/config")).toBe("junk");
  });

  test("huge file", () => {
    expect(
      classifyPath(set, "video.mp4", { size: HUGE_FILE_BYTES, isDir: false }),
    ).toBe("huge");
  });

  test("vault dir name", () => {
    expect(classifyPath(set, ".chavez/config.json")).toBe("vault");
  });
});

describe("gitignore negation cannot unlock harness secret", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ig2-")));
  writeFileSync(join(cwd, ".gitignore"), "!.env\n");
  writeFileSync(join(cwd, ".env"), "X=1\n");
  const set = loadIgnore(cwd);
  test(".env stays secret", () => {
    expect(classifyPath(set, ".env")).toBe("secret");
  });
});
```

No asserts sobre `homedir()` en CI (el path de vault abs se cubre en Task 3 con un absPath inyectado).

- [ ] Correr:

```bash
cd cli && bun test src/llm/ignore.test.ts
```

Esperado: todos pasan. Si `workspace-path.ts` falta, los tests de Task 1 de attach-files también se añaden y se corren.

- [ ] Commit:

```bash
git add cli/src/llm/ignore.ts cli/src/llm/ignore-patterns.ts \
  cli/src/llm/ignore.test.ts cli/package.json \
  cli/src/llm/workspace-path.ts cli/src/llm/workspace-path.test.ts
git commit -m "feat(ignore): gitignore + harness patterns for workspace paths"
```

---

## Task 2: Redacción de keys, líneas `.env` y vault

**Files:**

- Create: `cli/src/llm/redact.ts` (si invariants **no** lo creó; si existe, **extender**)
- Test: `cli/src/llm/redact.test.ts` (crear o extender)
- Create: `api/src/lib/redact.ts` (si no existe; si existe, extender **los mismos** patrones — API no importa CLI)
- Test: `api/src/lib/redact.test.ts`
- Create: `cli/src/llm/secret-scan.ts`
- Test: `cli/src/llm/secret-scan.test.ts`

La redacción de agent-tools (`tool-display.redactSecrets`) y de invariants (`redactText`) se **unifican** aquí. `tool-display.ts` debe reexportar `redactText` en Task 4; no dejes dos regex divergentes.

- [ ] Crear o reemplazar el cuerpo de `cli/src/llm/redact.ts` con este módulo (si el archivo ya existe, añadir los patrones que falten y `redactEnvValues` / `redactVaultPaths`; no borrar `redactJson`):

```ts
export const REDACT_REPLACEMENT = "***";

const KEY_NAME =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token|ciphertext)$/i;

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]+/g,
  /ghu_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const ENV_LINE =
  /^([A-Za-z_][A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH)[A-Za-z0-9_]*)\s*=\s*(.+)$/gm;

const VAULT_PATH_RE = /(?:^|[^\w.])(?:~\/)?\.chavez\/[A-Za-z0-9._\-\/]+/g;

export function redactText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  out = out.replace(ENV_LINE, `$1=${REDACT_REPLACEMENT}`);
  out = out.replace(VAULT_PATH_RE, (m) => {
    const prefix = m[0] === "~" || m[0] === "." ? "" : m[0];
    const rest = prefix ? m.slice(1) : m;
    return `${prefix}${REDACT_REPLACEMENT}`;
  });
  return out;
}

export function redactEnvValues(input: string): string {
  return input.replace(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/gm, (full, k, v) => {
    if (v === "" || v === REDACT_REPLACEMENT) return full;
    return `${k}=${REDACT_REPLACEMENT}`;
  });
}

export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactJson(v);
    }
    return out;
  }
  return value;
}

export function looksLikeSecretText(input: string): boolean {
  if (PATTERNS.some((re) => new RegExp(re.source, re.flags).test(input))) return true;
  ENV_LINE.lastIndex = 0;
  return ENV_LINE.test(input);
}
```

Copiar **el mismo archivo** a `api/src/lib/redact.ts` (sí, duplicado; el comentario `keep in sync with cli/src/llm/redact.ts` arriba del export).

- [ ] Crear `cli/src/llm/secret-scan.ts`:

```ts
import { looksLikeSecretText, redactEnvValues, redactText } from "./redact";
import type { IgnoreClass } from "./ignore-patterns";

export function redactByClass(text: string, cls: IgnoreClass): string {
  if (cls === "vault") return "***";
  if (cls === "secret") return redactEnvValues(redactText(text));
  return redactText(text);
}

export function containsSecret(text: string): boolean {
  return looksLikeSecretText(text);
}

/** Drop any line that names the Chavez vault config. */
export function stripVaultLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/\.chavez\/config\.json|CHAVEZ_ACCESS_TOKEN/i.test(line))
    .join("\n");
}
```

- [ ] Tests `cli/src/llm/redact.test.ts` (extender si ya hay casos de invariants):

```ts
import { describe, expect, test } from "bun:test";
import {
  redactEnvValues,
  redactJson,
  redactText,
} from "./redact";

describe("redactText", () => {
  test("anthropic and github tokens", () => {
    expect(redactText("key sk-ant-api03-abc rest")).toBe("key *** rest");
    expect(redactText("ghp_abc123")).toBe("***");
  });

  test("env secret lines", () => {
    expect(redactText("OPENAI_API_KEY=sk-abc\nOK=1")).toContain("OPENAI_API_KEY=***");
  });

  test("innocent code intact", () => {
    expect(redactText("hello src/auth.ts")).toBe("hello src/auth.ts");
  });

  test("json keys", () => {
    const s = redactJson({ api_key: "x", file: "a.ts" }) as Record<string, unknown>;
    expect(s.api_key).toBe("***");
    expect(s.file).toBe("a.ts");
  });
});

describe("redactEnvValues", () => {
  test("all assignments in a dotenv file", () => {
    const out = redactEnvValues("FOO=bar\nBAZ=qux\n");
    expect(out).toBe("FOO=***\nBAZ=***\n");
  });
});
```

Duplicar los mismos tests de `redactText`/`redactJson` en `api/src/lib/redact.test.ts` importando desde `../lib/redact`.

- [ ] `cli/src/llm/secret-scan.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { redactByClass, stripVaultLines } from "./secret-scan";

describe("redactByClass", () => {
  test("vault is fully stars", () => {
    expect(redactByClass('{"accessToken":"abc"}', "vault")).toBe("***");
  });
  test("secret dotenv", () => {
    expect(redactByClass("AWS_SECRET_ACCESS_KEY=wxyz\n", "secret")).toContain("=***");
  });
});

describe("stripVaultLines", () => {
  test("drops config.json hits", () => {
    const out = stripVaultLines("a\n~/.chavez/config.json\nb");
    expect(out).not.toContain("config.json");
    expect(out).toContain("a");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/redact.test.ts src/llm/secret-scan.test.ts
cd ../api && bun test src/lib/redact.test.ts
```

Si `api/package.json` no tiene `"test": "bun test"`, añadirlo (dejar el resto de scripts).

- [ ] Commit:

```bash
git add cli/src/llm/redact.ts cli/src/llm/redact.test.ts \
  cli/src/llm/secret-scan.ts cli/src/llm/secret-scan.test.ts \
  api/src/lib/redact.ts api/src/lib/redact.test.ts api/package.json
git commit -m "feat(secrets): redact API keys, dotenv values, and vault paths"
```

---

## Task 3: Picker `@` e hidratación respetan ignore; force no silencia

**Files:**

- Create: `cli/src/llm/fs-complete.ts` (si attach-files **no** lo creó; si existe, **modificar**)
- Test: `cli/src/llm/fs-complete.test.ts` (extender)
- Create: `cli/src/llm/hydrate-attachments.ts` (si no existe; si existe, **modificar**)
- Test: `cli/src/llm/hydrate-attachments.test.ts` (extender)
- Create: `cli/src/llm/attach-force.ts`
- Test: `cli/src/llm/attach-force.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`

El picker camina el cwd **sin entrar** a dirs ignorados. Hidratar un junk ignorado exige force (ask) o deja notice. Secret nunca viaja en crudo.

- [ ] En `cli/src/llm/fs-complete.ts`, si el archivo ya tiene `SKIP_DIR_NAMES` y `walk()`, sustituir el skip hardcodeado por `loadIgnore` + `shouldDescend`. Firma pública **igual** (`completeWorkspace(cwd, query, limit?)`). Cuerpo objetivo:

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadIgnore, shouldDescend, classifyPath, type IgnoreSet } from "./ignore";
import { relativePosix, toPosix } from "./workspace-path";

export const FS_COMPLETE_LIMIT = 10;
export const FS_WALK_MAX_ENTRIES = 8000;

export type FsCandidate = {
  path: string;
  isDir: boolean;
};

function walk(cwd: string, set: IgnoreSet): FsCandidate[] {
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
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, name);
      const rel = relativePosix(cwd, abs);
      if (rel.startsWith("..")) continue;
      let size: number | undefined;
      try {
        if (ent.isFile()) size = statSync(abs).size;
      } catch {
        size = undefined;
      }
      const cls = classifyPath(set, rel, {
        isDir: ent.isDirectory(),
        size,
        absPath: abs,
      });
      if (cls !== "none") continue;
      if (ent.isDirectory()) {
        out.push({ path: rel, isDir: true });
        if (shouldDescend(set, rel, abs)) stack.push(abs);
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
  return null;
}

export function completeWorkspace(
  cwd: string,
  query: string,
  limit = FS_COMPLETE_LIMIT,
): FsCandidate[] {
  const set = loadIgnore(cwd);
  const q = toPosix(query).replace(/^@/, "").replace(/^\.\//, "");
  return walk(cwd, set)
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
}
```

Si el archivo **no** existe, créalo entero (incluye este `walk` + exports). El RPC `fs.complete` del plan 1 ya llama `completeWorkspace`; no hace falta cambiar el protocolo.

- [ ] Extender `cli/src/llm/fs-complete.test.ts` (crear el describe de attach-files si falta, **más** estos casos):

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace } from "./fs-complete";

describe("completeWorkspace ignore", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-fsig-")));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "node-util.ts"), "export {}\n");
  writeFileSync(join(cwd, "src", "auth.ts"), "a");
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(cwd, "node_modules", "pkg", `n${i}.js`), "x");
  }
  writeFileSync(join(cwd, ".env"), "K=1\n");

  test("gitignore: @node does not list node_modules and cap is not wasted", () => {
    const hits = completeWorkspace(cwd, "node");
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(hits.every((c) => !c.path.startsWith("node_modules/"))).toBe(true);
    expect(hits.some((c) => c.path === "src/node-util.ts")).toBe(true);
  });

  test("harness .env is not offered", () => {
    const hits = completeWorkspace(cwd, ".env");
    expect(hits.some((c) => c.path === ".env")).toBe(false);
  });
});
```

- [ ] En `cli/src/llm/hydrate-attachments.ts`, extender tipos y `hydrateOne`:

```ts
export type AttachStatus =
  | "ok"
  | "missing"
  | "forbidden"
  | "too_large"
  | "unsupported"
  | "ignored"
  | "secret"
  | "vault";
```

Añadir argumento opcional:

```ts
export type HydrateOpts = {
  force?: boolean;
  /** When true, secret files hydrate redacted text instead of raw. Vault still forbidden. */
  redactSecret?: boolean;
};

export function hydrateOne(
  cwd: string,
  relPath: string,
  opts: HydrateOpts = {},
): HydratedAttachment {
```

Inmediatamente **después** de `resolveInsideCwd` y `statSync` (y de saber si es dir/file), **antes** de `readFileSync`:

```ts
  const set = loadIgnore(cwd);
  const cls = classifyPath(set, relPath, {
    isDir: st.isDirectory(),
    size: st.isFile() ? st.size : undefined,
    absPath: abs,
  });
  if (cls === "vault") {
    return {
      path: relPath,
      kind: st.isDirectory() ? "directory" : "text",
      status: "vault",
      byteSize: 0,
      error: `Refusing to attach Chavez vault: ${relPath}`,
    };
  }
  if (cls === "huge") {
    return {
      path: relPath,
      kind: "binary",
      status: "ignored",
      byteSize: st.size,
      error: `Ignored path (not hydrated): ${relPath} (huge file)`,
    };
  }
  if (cls === "secret") {
    if (!opts.force && !opts.redactSecret) {
      return {
        path: relPath,
        kind: "text",
        status: "secret",
        byteSize: st.size,
        error: `Refusing to attach secret file: ${relPath}`,
      };
    }
    if (st.isFile()) {
      const raw = readFileSync(abs, "utf8");
      return {
        path: relPath,
        kind: "text",
        status: "ok",
        byteSize: st.size,
        hydratedText: redactByClass(raw, "secret"),
        truncated: false,
      };
    }
  }
  if (cls === "junk" && !opts.force) {
    return {
      path: relPath,
      kind: st.isDirectory() ? "directory" : "text",
      status: "ignored",
      byteSize: 0,
      error: `Ignored path (not hydrated): ${relPath} (ignored)`,
    };
  }
```

Usar import estático de `loadIgnore` / `classifyPath` / `redactByClass` arriba del archivo, no `require`.

Listing de directorio: filtrar hijos con `classifyPath !== "none"` **salvo** `opts.force` (si se fuerza un dir junk, listar ≤10 hijos, todavía sin secrets/vault).

`blockingAttachError`: tratar `status === "vault"` como bloqueo (igual que `forbidden`). **No** bloquear `ignored` ni `secret`.

- [ ] Tests nuevos en `hydrate-attachments.test.ts`:

```ts
  test("hand-typed .env is secret, not raw", () => {
    const a = hydrateOne(cwd, ".env");
    expect(a.status).toBe("secret");
    expect(a.hydratedText ?? "").not.toContain("SECRET=1");
  });

  test("force secret hydrates redacted", () => {
    writeFileSync(join(cwd, ".env"), "SECRET=super\n");
    const a = hydrateOne(cwd, ".env", { force: true, redactSecret: true });
    expect(a.status).toBe("ok");
    expect(a.hydratedText ?? "").toContain("SECRET=***");
    expect(a.hydratedText ?? "").not.toContain("super");
  });

  test("ignored junk without force", () => {
    const a = hydrateOne(cwd, "node_modules/pkg/index.js");
    expect(a.status).toBe("ignored");
    expect(a.hydratedText).toBeUndefined();
  });

  test("force junk hydrates", () => {
    const a = hydrateOne(cwd, "node_modules/pkg/index.js", { force: true });
    expect(a.status).toBe("ok");
    expect(a.hydratedText ?? "").toContain("x");
  });
```

El tmp de este describe debe tener `.gitignore` + `node_modules/pkg/index.js` + `.env` (reutilizar el cwd de Task 1 o armar uno).

- [ ] Crear `cli/src/llm/attach-force.ts`. Si `cli/src/llm/tool-approval.ts` **existe**, importar `waitForApproval` / `resolveApproval`. Si **no**, copiar esas dos funciones (mismo timeout 300_000) en este archivo — no esperar al plan 3.

```ts
import { statSync } from "node:fs";
import type { ExecutionMode } from "./execution-mode";
import type { HydratedAttachment } from "./hydrate-attachments";
import { hydrateOne } from "./hydrate-attachments";
import { classifyPath, loadIgnore } from "./ignore";
import { reasonForClass } from "./ignore-patterns";
import { resolveInsideCwd } from "./workspace-path";

export const FORCE_ATTACH_SDK = "AttachIgnored";

export function isForceAttachName(sdkName: string): boolean {
  return sdkName === FORCE_ATTACH_SDK || sdkName === "attach";
}

export type AttachDecision = {
  attachment: HydratedAttachment;
  notice?: string;
  needsAsk?: { path: string; reason: string; cls: string };
};

export function decideAttach(
  cwd: string,
  relPath: string,
  mode: ExecutionMode | "ask" | "auto" | "plan",
): AttachDecision {
  const set = loadIgnore(cwd);
  let abs = relPath;
  try {
    abs = resolveInsideCwd(cwd, relPath);
  } catch {
    const a = hydrateOne(cwd, relPath);
    return { attachment: a };
  }
  let isDir = false;
  let size: number | undefined;
  try {
    const st = statSync(abs);
    isDir = st.isDirectory();
    size = st.isFile() ? st.size : undefined;
  } catch {
    return { attachment: hydrateOne(cwd, relPath) };
  }
  const cls = classifyPath(set, relPath, { isDir, size, absPath: abs });
  if (cls === "none") return { attachment: hydrateOne(cwd, relPath) };
  const reason = reasonForClass(cls);
  if (cls === "vault") {
    const attachment = hydrateOne(cwd, relPath);
    return { attachment, notice: attachment.error };
  }
  if (cls === "secret") {
    if (mode === "ask") {
      return {
        attachment: hydrateOne(cwd, relPath),
        needsAsk: { path: relPath, reason, cls },
      };
    }
    const attachment = hydrateOne(cwd, relPath);
    return {
      attachment,
      notice: attachment.error || `Refusing to attach secret file: ${relPath}`,
    };
  }
  if (mode === "ask") {
    return {
      attachment: hydrateOne(cwd, relPath),
      needsAsk: { path: relPath, reason, cls },
    };
  }
  const attachment = hydrateOne(cwd, relPath);
  return {
    attachment,
    notice: attachment.error || `Ignored path (not hydrated): ${relPath} (${reason})`,
  };
}

export function hydrateForced(cwd: string, relPath: string, cls: string): HydratedAttachment {
  if (cls === "secret") {
    return hydrateOne(cwd, relPath, { force: true, redactSecret: true });
  }
  if (cls === "vault") return hydrateOne(cwd, relPath);
  return hydrateOne(cwd, relPath, { force: true });
}
```

Si `execution-mode.ts` no existe, declara `type ExecutionMode = "plan" | "auto" | "ask"` localmente.

- [ ] `cli/src/llm/attach-force.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAttach, hydrateForced } from "./attach-force";

describe("decideAttach", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-af-")));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "secretless\n");
  writeFileSync(join(cwd, ".env"), "K=live\n");
  writeFileSync(join(cwd, "src.ts"), "ok\n");

  test("normal file", () => {
    expect(decideAttach(cwd, "src.ts", "auto").attachment.status).toBe("ok");
  });

  test("junk auto warns and does not hydrate", () => {
    const d = decideAttach(cwd, "node_modules/pkg/index.js", "auto");
    expect(d.attachment.status).toBe("ignored");
    expect(d.notice).toMatch(/not hydrated/i);
    expect(d.needsAsk).toBeUndefined();
  });

  test("junk ask needs confirmation", () => {
    const d = decideAttach(cwd, "node_modules/pkg/index.js", "ask");
    expect(d.needsAsk?.path).toBe("node_modules/pkg/index.js");
  });

  test("force junk hydrates", () => {
    const a = hydrateForced(cwd, "node_modules/pkg/index.js", "junk");
    expect(a.status).toBe("ok");
    expect(a.hydratedText).toContain("secretless");
  });

  test("secret auto refuses raw", () => {
    const d = decideAttach(cwd, ".env", "auto");
    expect(d.attachment.status).toBe("secret");
    expect(d.notice).toMatch(/secret file/i);
  });
});
```

- [ ] En `cli/src/llm/publish-turn.ts`, **después** de parsear menciones y **antes** de `runClaudeTurn`:

  1. Resolver `executionMode` desde `input.executionMode` si existe, si no `"ask"`.
  2. Para cada path de `mergeMentions(prompt, input.mentions)`: `decideAttach(cwd, path, mode)`.
  3. Si `needsAsk`, emitir `chat.tool.start` con `toolName: "attach"`, `metadata.sdkName: "AttachIgnored"`, `status: "awaiting_approval"`, `input: { path, reason }`, `toolCallId: crypto.randomUUID()`. `waitForApproval(toolCallId, chatId)`. Approve → `hydrateForced`. Deny/timeout → leave `status: "ignored"` + notice. Luego `chat.tool.result` (`done` o `error`).
  4. Concatenar notices en un `chat.append` `role: "system"` **o** (preferido, no ensucia historial LLM de más) en `metadata.ignoredAttaches` del user message **y** una línea al bloque de prompt:

```
[Skipped ignored attach: node_modules/pkg/index.js (ignored)]
[Refusing to attach secret file: .env]
```

  5. `blockingAttachError` solo con vault/forbidden/missing/too_large → `chat.stream.error`, no LLM.
  6. Nunca persistir `hydratedText` crudo de secret. `persistableAttachment` igual que plan 1.

Si `publishAgentTurn` aún no hidrata (attach-files no aterrizó), implementar el bloque mínimo: parseMentions + decideAttach + notices + attachmentsPromptBlock, y pasar el prompt aumentado a `runClaudeTurn`. No reescribir el runner.

- [ ] En `cli/src/ws/daemon.ts` y `tui/src/App.tsx`, si aún no hay handler de `agent.tool.approve` / `agent.tool.deny` (plan 3), añadir:

```ts
import { resolveApproval } from "../llm/tool-approval";
// tui: from "../../cli/src/llm/tool-approval"

if (msg.type === "agent.tool.approve" || msg.type === "agent.tool.deny") {
  const data = (msg.data || {}) as { toolCallId?: string };
  if (data.toolCallId) {
    resolveApproval(
      data.toolCallId,
      msg.type === "agent.tool.approve" ? "approve" : "deny",
    );
  }
  return;
}
```

Si el handler ya existe, no duplicarlo: `waitForApproval` de force-attach usa el **mismo** mapa.

Si `tool-approval.ts` no existe, créalo con el cuerpo de execution-modes Task 1 (`waitForApproval`, `resolveApproval`, timeout 300s) y un test corto `approve then second resolve is false`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/fs-complete.test.ts src/llm/hydrate-attachments.test.ts \
  src/llm/attach-force.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/fs-complete.ts cli/src/llm/fs-complete.test.ts \
  cli/src/llm/hydrate-attachments.ts cli/src/llm/hydrate-attachments.test.ts \
  cli/src/llm/attach-force.ts cli/src/llm/attach-force.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/tool-approval.ts \
  cli/src/llm/tool-approval.test.ts cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(ignore): picker and attach hydration skip secrets and gitignore"
```

---

## Task 4: Tools — grep/read no ofrecen ignore; output con key redactado; vault fuera de la timeline

**Files:**

- Create: `cli/src/llm/tool-ignore.ts`
- Test: `cli/src/llm/tool-ignore.test.ts`
- Modify: `cli/src/llm/tool-sandbox.ts` (si no existe, crear `denyIfEscapes` como en agent-tools y este gate al lado)
- Modify: `cli/src/llm/tool-display.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `api/src/ws/handlers.ts`

Las lecturas **no** pasan por `awaiting_approval`. Un Read de `.env` se deniega o se deja pasar al SDK y el resultado se redacta **antes** de persistir. Elegimos: **Read/Grep/Glob con path secret/junk/vault/huge → deny visible**. Grep/Glob **sin** path (repo entero) se permiten y el output se filtra.

- [ ] Crear `cli/src/llm/tool-ignore.ts`:

```ts
import { extractToolPath } from "./tool-sandbox";
import { classifyPath, loadIgnore, type IgnoreSet } from "./ignore";
import { reasonForClass, type IgnoreClass } from "./ignore-patterns";
import { toolClass } from "./tool-names";
import { redactByClass, stripVaultLines } from "./secret-scan";
import { redactText } from "./redact";
import { relativePosix, resolveInsideCwd } from "./workspace-path";

export function classifyToolPath(
  cwd: string,
  set: IgnoreSet,
  rawPath: string | null,
): { cls: IgnoreClass; rel: string } | null {
  if (!rawPath) return null;
  let abs: string;
  try {
    abs = resolveInsideCwd(cwd, rawPath);
  } catch {
    return null;
  }
  const rel = relativePosix(cwd, abs);
  const cls = classifyPath(set, rel, { absPath: abs });
  return { cls, rel };
}

export function denyIfIgnored(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
  set?: IgnoreSet,
): { behavior: "deny"; message: string } | null {
  const ignore = set ?? loadIgnore(cwd);
  const raw = extractToolPath(input);
  const hit = classifyToolPath(cwd, ignore, raw);
  if (!hit || hit.cls === "none") return null;
  const cls = toolClass(sdkName);
  if (hit.cls === "vault") {
    return { behavior: "deny", message: "Chavez vault is not readable or writable by tools" };
  }
  if (cls === "write" && (hit.cls === "secret" || hit.cls === "huge")) {
    return {
      behavior: "deny",
      message: `Write blocked: ${hit.rel} looks like a secret (.env/key/vault). Git will not commit it.`,
    };
  }
  if (cls === "read" && hit.cls === "secret") {
    return {
      behavior: "deny",
      message: `Secret file ${hit.rel} — values redacted`,
    };
  }
  if (cls === "read" || cls === "write") {
    return {
      behavior: "deny",
      message: `Path is ignored: ${hit.rel} (${reasonForClass(hit.cls)}). Not read.`,
    };
  }
  return null;
}

const GREP_LINE = /^([^:\n]+):(\d+:)?(.*)$/;

export function filterGrepOrGlobOutput(
  cwd: string,
  sdkName: string,
  output: string,
  set?: IgnoreSet,
): string {
  const ignore = set ?? loadIgnore(cwd);
  const name = sdkName.toLowerCase();
  const lines = output.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (name.includes("grep") || name.includes("glob") || name === "ls") {
      const m = GREP_LINE.exec(line);
      const pathPart = m ? m[1]! : (name.includes("glob") ? line.trim() : "");
      if (pathPart) {
        const cls = classifyPath(ignore, pathPart.replace(/^\.\//, ""));
        if (cls === "vault") continue;
        if (cls === "junk" || cls === "huge") continue;
        if (cls === "secret") {
          kept.push(redactByClass(line, "secret"));
          continue;
        }
      }
    }
    kept.push(redactText(stripVaultLines(line)));
  }
  return kept.join("\n");
}

export function sanitizeVisibleToolOutput(
  cwd: string,
  sdkName: string,
  output: string,
): string {
  const filtered = filterGrepOrGlobOutput(cwd, sdkName, output);
  return redactText(stripVaultLines(filtered));
}
```

Si `tool-names.ts` / `tool-sandbox.ts` no existen, crear los mínimos de agent-tools Task 1 (`canonicalToolName`, `toolClass`, `extractToolPath`) — no reinventar el mapa de names.

Usar import estático de `relativePosix`.

Para Read secret: el mensaje `Secret file … — values redacted` es deny (no se envían valores al LLM ni a la timeline). Cumple “rechaza o redacta” sin filtrar el vault. Grep repo-wide que pega una key en `src/config.ts` (no ignorado) **sí** llega al filtro de redacción.

- [ ] `cli/src/llm/tool-ignore.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyIfIgnored, filterGrepOrGlobOutput } from "./tool-ignore";

describe("denyIfIgnored", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ti-")));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, ".env"), "OPENAI_API_KEY=sk-live\n");
  writeFileSync(join(cwd, "src", "ok.ts"), "export {}\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");

  test("allows normal read", () => {
    expect(denyIfIgnored(cwd, "Read", { file_path: "src/ok.ts" })).toBeNull();
  });

  test("denies read of gitignored", () => {
    const d = denyIfIgnored(cwd, "Read", {
      file_path: join(cwd, "node_modules", "pkg", "index.js"),
    });
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toMatch(/ignored/i);
  });

  test("denies write of .env", () => {
    const d = denyIfIgnored(cwd, "Write", { file_path: ".env" });
    expect(d?.message).toMatch(/Write blocked/i);
  });

  test("denies vault", () => {
    const d = denyIfIgnored(cwd, "Read", { file_path: ".chavez/config.json" });
    expect(d?.message).toMatch(/vault/i);
  });
});

describe("filterGrepOrGlobOutput", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-gr-")));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");

  test("redacts key in non-ignored file", () => {
    const out = filterGrepOrGlobOutput(
      cwd,
      "Grep",
      "src/config.ts:3:const k = sk-ant-api03-abc",
    );
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain("***");
    expect(out).toContain("src/config.ts");
  });

  test("drops node_modules hits", () => {
    const out = filterGrepOrGlobOutput(
      cwd,
      "Grep",
      "node_modules/pkg/index.js:1:foo\nsrc/a.ts:1:bar",
    );
    expect(out).not.toContain("node_modules");
    expect(out).toContain("src/a.ts");
  });

  test("vault never appears", () => {
    const out = filterGrepOrGlobOutput(
      cwd,
      "Grep",
      ".chavez/config.json:1:accessToken=abc\nsrc/a.ts:1:ok",
    );
    expect(out).not.toContain(".chavez");
    expect(out).not.toContain("accessToken");
  });
});
```

Para el test de vault, `classifyPath(".chavez/config.json")` es `"vault"` aunque el archivo no exista (regla harness). `denyIfIgnored` con path relativo `.chavez/config.json`: `resolveInsideCwd` devuelve lexical in-cwd; class vault. No hace falta crear el dir.

- [ ] En `canUseTool` de `cli/src/llm/claude-runner.ts` (lo añade agent-tools / execution-modes), **después** de `denyIfEscapes` y **antes** del gate de modo:

```ts
const ignored = denyIfIgnored(input.cwd, toolName, rec);
if (ignored) return ignored;
```

Si `canUseTool` aún no existe, añadirlo con `permissionMode: "default"` como en agent-tools Task 3, incluyendo sandbox + ignore. No volver a `bypassPermissions`.

- [ ] En `cli/src/llm/publish-turn.ts`, al emitir `chat.tool.result` y `chat.tool.start`:

```ts
import { sanitizeVisibleToolOutput } from "./tool-ignore";
import { redactJson, redactText } from "./redact";
import { stringifyToolOutput, sanitizeToolInput } from "./tool-display";
```

`metadata.input = redactJson(sanitizeToolInput(ev.input))`. `content` / `metadata.output = sanitizeVisibleToolOutput(cwd, ev.toolName, stringifyToolOutput(ev.output))`. El secret de `GET /providers/claude/credentials` **sigue** solo en variable local (invariants). En `catch`, si `message` incluye `creds.secret`, reemplazar por `***`.

Si `tool-display.ts` tiene su propio `redactSecrets`, cambiarlo a:

```ts
export { redactText as redactSecrets } from "./redact";
```

y hacer que `stringifyToolOutput` use `redactText`.

- [ ] En `api/src/ws/handlers.ts`, cinturón (si invariants no lo puso): en `chat.append`, `chat.stream.end`, `chat.stream.delta`, `chat.tool.start`, `chat.tool.result`, `chat.tool.update` — `msg.content = redactText(msg.content)` y `msg.metadata = redactJson(msg.metadata) as …` **antes** de INSERT/UPDATE y broadcast. Importar desde `api/src/lib/redact.ts`. Los deltas se redactan para que un `sk-ant-` en el stream no llegue a Web.

- [ ] Correr:

```bash
cd cli && bun test src/llm/tool-ignore.test.ts src/llm/tool-display.test.ts src/llm/redact.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/tool-ignore.ts cli/src/llm/tool-ignore.test.ts \
  cli/src/llm/tool-sandbox.ts cli/src/llm/tool-display.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts \
  api/src/ws/handlers.ts
git commit -m "feat(ignore): tools skip ignored paths and redact secret output"
```

---

## Task 5: Diffs de `.env` bloqueados y guarda de commit para Git (plan 7)

**Files:**

- Create: `cli/src/llm/secret-diff.ts`
- Test: `cli/src/llm/secret-diff.test.ts`
- Create: `cli/src/llm/git-secret-guard.ts`
- Test: `cli/src/llm/git-secret-guard.test.ts`
- Modify: `cli/src/llm/tool-ignore.ts` (Write/Edit ya deniegan secret en Task 4; aquí se cubre el diff visible)
- Modify: `cli/src/llm/publish-turn.ts`

El [plan 6](../diffs-review/plan.md) aún no persiste diffs por turn. Esta fase: (1) el Write/Edit de secret **no ocurre**; (2) si el SDK igual devuelve un patch (p.ej. Bash `sed` sobre `.env`), el output visible se redacta o se sustituye por `SECRET_WRITE_DENIED`; (3) se exporta `gitCommitBlockedReason` para que el plan 7 no commitee secrets ni el vault.

- [ ] Crear `cli/src/llm/secret-diff.ts`:

```ts
import { redactEnvValues, redactText } from "./redact";
import { classifyPath, loadIgnore } from "./ignore";

export function redactDiffForCwd(cwd: string, text: string): string {
  const set = loadIgnore(cwd);
  const lines = text.split("\n");
  let inSecretFile = false;
  const out: string[] = [];
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    const minus = /^--- a\/(.+)$/.exec(line);
    const file = header?.[2] || plus?.[1] || minus?.[1];
    if (file) {
      const rel = file.replace(/^\.\//, "");
      const cls = classifyPath(set, rel);
      inSecretFile = cls === "secret" || cls === "vault" || /(^|\/)\.env(\.|$)/.test(rel);
    }
    if (
      inSecretFile &&
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      out.push(line[0] + redactEnvValues(redactText(line.slice(1))));
      continue;
    }
    out.push(redactText(line));
  }
  return out.join("\n");
}
```

- [ ] Crear `cli/src/llm/git-secret-guard.ts`:

```ts
import { classifyPath, loadIgnore, type IgnoreSet } from "./ignore";

export function gitCommitBlockedReason(
  cwd: string,
  relPath: string,
  set?: IgnoreSet,
): string | null {
  const ignore = set ?? loadIgnore(cwd);
  const cls = classifyPath(ignore, relPath);
  if (cls === "vault") {
    return `Refusing to commit secret path: ${relPath}`;
  }
  if (cls === "secret") {
    return `Refusing to commit secret path: ${relPath}`;
  }
  return null;
}

export function assertCommitPathsAllowed(cwd: string, paths: string[]): void {
  const set = loadIgnore(cwd);
  const blocked = paths
    .map((p) => gitCommitBlockedReason(cwd, p, set))
    .filter((x): x is string => Boolean(x));
  if (blocked.length) {
    throw new Error(blocked.join("; "));
  }
}
```

El plan 7 debe llamar `assertCommitPathsAllowed` **antes** de `git commit`. Esta fase no implementa git.

- [ ] Tests:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactDiffForCwd } from "./secret-diff";
import { assertCommitPathsAllowed, gitCommitBlockedReason } from "./git-secret-guard";

describe("redactDiffForCwd", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-diff-")));
  writeFileSync(join(cwd, ".env"), "K=1\n");

  test("redacts dotenv values in a unified diff", () => {
    const diff = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-K=oldsecret",
      "+K=newsecret",
    ].join("\n");
    const out = redactDiffForCwd(cwd, diff);
    expect(out).not.toContain("oldsecret");
    expect(out).not.toContain("newsecret");
    expect(out).toContain("K=***");
  });
});

describe("gitCommitBlockedReason", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-gc-")));
  writeFileSync(join(cwd, ".env"), "K=1\n");
  writeFileSync(join(cwd, "ok.ts"), "x\n");

  test("blocks .env and vault, allows source", () => {
    expect(gitCommitBlockedReason(cwd, ".env")).toMatch(/secret path/);
    expect(gitCommitBlockedReason(cwd, ".chavez/config.json")).toMatch(/secret path/);
    expect(gitCommitBlockedReason(cwd, "ok.ts")).toBeNull();
  });

  test("assert throws", () => {
    expect(() => assertCommitPathsAllowed(cwd, [".env"])).toThrow(/secret path/);
    expect(() => assertCommitPathsAllowed(cwd, ["ok.ts"])).not.toThrow();
  });
});
```

- [ ] En `sanitizeVisibleToolOutput`, si `sdkName` es `Edit` / `Write` / `Bash` y el output parece diff (`startsWith("diff --git")` o contiene `+++ b/`), pasar por `redactDiffForCwd(cwd, output)` **después** del filtro grep.

- [ ] En `denyIfIgnored`, Bash no tiene `file_path`. No podemos bloquear `sed -i .env` aquí (plan 26 / plan 7 cubren más). Cinturón: `sanitizeVisibleToolOutput` redacta. Documentar en el commit que Bash que mutea `.env` se redacta en timeline y Git no lo commitea (guarda). Write/Edit canónicos **sí** se bloquean.

- [ ] Correr:

```bash
cd cli && bun test src/llm/secret-diff.test.ts src/llm/git-secret-guard.test.ts src/llm/tool-ignore.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/secret-diff.ts cli/src/llm/secret-diff.test.ts \
  cli/src/llm/git-secret-guard.ts cli/src/llm/git-secret-guard.test.ts \
  cli/src/llm/tool-ignore.ts cli/src/llm/publish-turn.ts
git commit -m "feat(secrets): block .env writes and export git commit guard"
```

---

## Task 6: RPC `fs.tree` — el mismo ignore, hostname + cwd del daemon

**Files:**

- Create: `cli/src/llm/fs-tree.ts`
- Test: `cli/src/llm/fs-tree.test.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/pending.ts` (crear si attach-files no lo creó)
- Modify: `api/src/ws/handlers.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`
- Modify: `api/openapi/openapi.yaml`

El árbol es exploración (plan 18). Aquí el contrato: listar **un** directorio del cwd del daemon, filtrado, con `hostname` y `cwd`. Sin daemon → `NO_DAEMON_ERROR`. No se lista el disco de la API.

- [ ] Crear `cli/src/llm/fs-tree.ts`:

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadIgnore, classifyPath } from "./ignore";
import { PathEscapeError, relativePosix, resolveInsideCwd } from "./workspace-path";

export const FS_TREE_MAX_ENTRIES = 200;

export type FsTreeEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

export type FsTreeResult = {
  cwd: string;
  path: string;
  entries: FsTreeEntry[];
  truncated: boolean;
};

export function listWorkspaceDir(cwd: string, relDir = "."): FsTreeResult {
  const set = loadIgnore(cwd);
  let abs = cwd;
  const rel = relDir === "" || relDir === "." ? "." : relDir.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel !== ".") {
    try {
      abs = resolveInsideCwd(cwd, rel);
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      throw err;
    }
  }
  const cls = classifyPath(set, rel === "." ? "" : rel, { isDir: true, absPath: abs });
  if (cls !== "none" && rel !== ".") {
    return { cwd, path: rel, entries: [], truncated: false };
  }
  let names: string[] = [];
  try {
    names = readdirSync(abs);
  } catch {
    names = [];
  }
  names.sort((a, b) => a.localeCompare(b));
  const entries: FsTreeEntry[] = [];
  let truncated = false;
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const childAbs = join(abs, name);
    let isDir = false;
    let size: number | undefined;
    try {
      const st = statSync(childAbs);
      isDir = st.isDirectory();
      size = st.isFile() ? st.size : undefined;
    } catch {
      continue;
    }
    const childRel = relativePosix(cwd, childAbs);
    const childCls = classifyPath(set, childRel, { isDir, size, absPath: childAbs });
    if (childCls !== "none") continue;
    if (entries.length >= FS_TREE_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name, path: childRel, isDir });
  }
  return { cwd, path: rel, entries, truncated };
}
```

- [ ] `cli/src/llm/fs-tree.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDir } from "./fs-tree";
import { PathEscapeError } from "./workspace-path";

describe("listWorkspaceDir", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-tree-")));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "a.ts"), "a");
  writeFileSync(join(cwd, "README.md"), "hi");
  writeFileSync(join(cwd, ".env"), "K=1\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");

  test("root hides node_modules and .env", () => {
    const r = listWorkspaceDir(cwd, ".");
    const names = r.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".env");
  });

  test("escape throws", () => {
    expect(() => listWorkspaceDir(cwd, "../outside")).toThrow(PathEscapeError);
  });
});
```

- [ ] Si `api/src/ws/pending.ts` no existe, crearlo **idéntico** al de attach-files Task 3 (`createPendingMap(timeoutMs)`). Reutilizar **el mismo mapa** para `fs.complete` y `fs.tree` (ids de request no colisionan). Si `fsPending` ya está en handlers, declara `const fsRpcPending = fsPending` o un segundo `createPendingMap(5000)` llamado `treePending`.

- [ ] En `api/src/ws/protocol.ts`, extender `ClientMessage` con los campos que falten: `query?: string`, `hostname?: string`, `requestId?: string`, `limit?: number`. `path` ya existe.

- [ ] En `api/src/ws/handlers.ts`, nuevo case `fs.tree` **antes** de `default` (y junto a `fs.complete` si existe):

```ts
case "fs.tree": {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) {
    return fail(type, id, "No daemon bound for this workspace. Run: chavez headless workspace open");
  }
  const rel = typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : ".";
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("fs.tree.dispatch", {
      requestId: id,
      path: rel,
      requesterConnectionId: connectionId,
      workspacePath: daemon.path,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return await treePending.wait(id, type);
}

case "fs.tree.result": {
  if (!msg.requestId) return fail(type, id, "requestId is required");
  const meta = (msg.metadata || {}) as {
    cwd?: string;
    path?: string;
    entries?: unknown;
    truncated?: unknown;
  };
  const payload = {
    hostname: msg.hostname || null,
    cwd: meta.cwd || msg.path || null,
    path: meta.path || ".",
    entries: Array.isArray(meta.entries) ? meta.entries.slice(0, 200) : [],
    truncated: Boolean(meta.truncated),
  };
  const forwarded = treePending.complete(
    msg.requestId,
    ok("fs.tree", msg.requestId, payload),
  );
  return ok(type, id, { forwarded });
}
```

`requireWorkspace` ya existe: el cliente Web debe haber hecho `workspace.bind` (WorkspaceDetailPanel ya llama `ensureBound`). No usar `chatId` (el árbol es del workspace, no del chat).

- [ ] En `cli/src/ws/client.ts`, extender `WsRequest` con `hostname?: string`, `requestId?: string` si faltan.

- [ ] En `cli/src/ws/daemon.ts`, handler **antes** del early-return de `agent.turn.dispatch` (no usar `turnBusy`):

```ts
import { hostname } from "node:os";
import { listWorkspaceDir } from "../llm/fs-tree";

if (msg.type === "fs.tree.dispatch") {
  const data = (msg.data || {}) as {
    requestId?: string;
    path?: string;
    workspacePath?: string;
  };
  if (!data.requestId) return;
  try {
    const tree = listWorkspaceDir(data.workspacePath || path, data.path || ".");
    await client.request({
      type: "fs.tree.result",
      requestId: data.requestId,
      hostname: hostname(),
      path,
      metadata: {
        cwd: tree.cwd,
        path: tree.path,
        entries: tree.entries,
        truncated: tree.truncated,
      },
    });
  } catch (err) {
    await client.request({
      type: "fs.tree.result",
      requestId: data.requestId,
      hostname: hostname(),
      path,
      metadata: {
        cwd: path,
        path: data.path || ".",
        entries: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
  return;
}
```

Si `listWorkspaceDir` tira `PathEscapeError`, el result lleva `entries: []` y el API igual responde `ok` con lista vacía. El Web muestra el error si `metadata.error` se propaga: incluye `error` en el payload de `fs.tree.result` cuando exista:

```ts
error: typeof meta.error === "string" ? meta.error : undefined,
```

- [ ] El mismo handler de `fs.tree.dispatch` en `tui/src/App.tsx` `onPush` (TUI **es** daemon). Importar `listWorkspaceDir` desde `../../cli/src/llm/fs-tree` y `hostname` desde `node:os`. No marcar `turnBusyRef`.

- [ ] En `api/openapi/openapi.yaml`, en la lista de tipos WS, añadir `fs.tree`, `fs.tree.result`, push `fs.tree.dispatch`. Schema:

```yaml
WsClientFsTree:
  allOf:
    - $ref: "#/components/schemas/ClientMessage"
    - type: object
      required: [type, id]
      properties:
        type:
          type: string
          enum: [fs.tree]
        path:
          type: string
          description: Directorio relativo al cwd del daemon; "." = raíz
      example:
        type: fs.tree
        id: "t1"
        path: "src"
```

Respuesta `data`: `{ hostname, cwd, path, entries: [{ name, path, isDir }], truncated }`. Error sin daemon: el mismo string que `agent.turn.request`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/fs-tree.test.ts
cd ../api && bun test src/ws/pending.test.ts
```

Si `pending.test.ts` no existe, créalo como en attach-files Task 3.

- [ ] Commit:

```bash
git add cli/src/llm/fs-tree.ts cli/src/llm/fs-tree.test.ts \
  cli/src/ws/client.ts cli/src/ws/daemon.ts tui/src/App.tsx \
  api/src/ws/protocol.ts api/src/ws/pending.ts api/src/ws/pending.test.ts \
  api/src/ws/handlers.ts api/openapi/openapi.yaml
git commit -m "feat(ignore): fs.tree RPC uses the same ignore as @"
```

---

## Task 7: Web árbol + notices en TUI / watch (mismo ignore, hostname · path)

**Files:**

- Create: `web/src/components/FileTreePanel.tsx`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `tui/src/App.tsx`
- Modify: `cli/src/llm/watch-format.ts` (crear si agent-tools no lo creó)
- Modify: `cli/src/commands/headless.ts`

Plan 18 añadirá búsqueda y preview. Esta fase deja un árbol raíz **usable**: expandir carpeta pide `fs.tree`, no lista `node_modules`, muestra `hostname · cwd`.

- [ ] Extender `WsRequest` en `web/src/lib/ws-client.ts` con `query?: string`, `hostname?: string`, `requestId?: string` si faltan.

- [ ] En `web/src/lib/ws-hooks.ts`:

```ts
export type FsTreeEntry = { name: string; path: string; isDir: boolean };

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
```

Si el tipo de `ws.request` en `ws-context.tsx` no admite `path` extra, el campo ya está en `WsRequest`.

- [ ] Crear `web/src/components/FileTreePanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { formatQueryError } from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsFsTree, type FsTreeEntry } from "../lib/ws-hooks";

export function FileTreePanel({
  workspacePath,
}: {
  workspacePath: string | undefined;
}) {
  const ws = useWs();
  const bind = useWsBind();
  const tree = useWsFsTree();
  const [rel, setRel] = useState(".");
  const [stack, setStack] = useState<string[]>(["."]);
  const [entries, setEntries] = useState<FsTreeEntry[]>([]);
  const [hostname, setHostname] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  async function load(path: string) {
    setErr(null);
    if (!workspacePath) {
      setErr("Workspace sin path");
      return;
    }
    try {
      await bind.mutateAsync(workspacePath);
      const res = await tree.mutateAsync({ path });
      if (!res.ok) {
        setEntries([]);
        setErr(res.error || "fs.tree failed");
        return;
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
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setTruncated(Boolean(data.truncated));
      if (data.error) setErr(data.error);
      setRel(path);
    } catch (e) {
      setEntries([]);
      setErr(formatQueryError(e));
    }
  }

  useEffect(() => {
    if (ws.status === "open" && workspacePath) {
      void load(".");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.status, workspacePath]);

  function enter(dir: FsTreeEntry) {
    if (!dir.isDir) return;
    setStack((s) => [...s, dir.path]);
    void load(dir.path);
  }

  function up() {
    setStack((s) => {
      const next = s.slice(0, -1);
      const dest = next[next.length - 1] || ".";
      void load(dest);
      return next.length ? next : ["."];
    });
  }

  return (
    <div className="panel file-tree">
      <h2>Archivos</h2>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {hostname || "—"} · {cwd || workspacePath || "sin daemon"}
      </p>
      {err && (
        <p className="error">
          {err.includes("daemon bound")
            ? "No hay filesystem: arranca el daemon en este workspace (`chavez headless workspace open` o `chavez tui`). El árbol no lista el disco del servidor."
            : err}
        </p>
      )}
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        cwd relativo: <code>{rel}</code>
        {rel !== "." && (
          <>
            {" "}
            <button type="button" onClick={up}>
              ..
            </button>
          </>
        )}
      </p>
      <ul className="file-tree-list">
        {entries.map((e) => (
          <li key={e.path}>
            {e.isDir ? (
              <button type="button" onClick={() => enter(e)}>
                {e.name}/
              </button>
            ) : (
              <span>{e.name}</span>
            )}
          </li>
        ))}
      </ul>
      {entries.length === 0 && !err && (
        <p className="muted">Vacío (o todo ignorado).</p>
      )}
      {truncated && <p className="muted">Listado truncado a 200 entradas.</p>}
    </div>
  );
}
```

Si `useWsBind` espera `(path: string)` — sí, hoy `bind.mutateAsync(path)`.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx`, dentro del panel principal **después** del bloque de sessions (antes del cierre del fragmento), renderizar:

```tsx
<FileTreePanel workspacePath={detail.data?.workspace?.path} />
```

Importar `FileTreePanel`. El path del workspace es el del row, no el del servidor API.

- [ ] En `web/src/styles/global.css` añadir:

```css
.file-tree-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  font-family: var(--mono);
  font-size: 0.85rem;
}
.file-tree-list li {
  padding: 0.15rem 0;
}
.file-tree-list button {
  background: none;
  border: 0;
  color: #8ec8ff;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`, pintar attaches ignorados. Si existe `AttachmentChips` (plan 1), extenderlo: `status === "ignored" | "secret" | "vault"` → chip con clase `warn` / `err` y el `error` como title. Si **no** existe, en el bubble `role === "user"` leer `metadata.attachments` y `metadata.ignoredAttaches`:

```tsx
function IgnoredAttachNote({ m }: { m: ChatMessage }) {
  const meta = (m.metadata || {}) as {
    attachments?: Array<{ path?: string; status?: string; error?: string }>;
    ignoredAttaches?: Array<{ path?: string; error?: string }>;
  };
  const items = [
    ...(meta.attachments || []).filter(
      (a) => a.status === "ignored" || a.status === "secret" || a.status === "vault",
    ),
    ...(meta.ignoredAttaches || []),
  ];
  if (!items.length) return null;
  return (
    <ul className="muted" style={{ fontSize: "0.8rem" }}>
      {items.map((a) => (
        <li key={String(a.path)}>
          ⚠ {a.error || `Ignored path (not hydrated): ${a.path}`}
        </li>
      ))}
    </ul>
  );
}
```

Renderizarlo bajo el `<pre>` del user. ToolCard: el `content` ya viene redactado; no hace falta otro filtro. Añadir: si `m.content` o `JSON.stringify(meta)` contuviera `.chavez/config.json` en tests mentales, el cinturón de API ya lo sustituyó.

- [ ] En `tui/src/App.tsx`, tipo `Message` ampliar a `metadata?: Record<string, unknown>`. Al pintar un user message, si `metadata.attachments` tiene status ignored/secret/vault, línea extra `Text color="yellow"`: `⚠ Ignored path (not hydrated): …`. Al pintar tools, el `content` ya redactado. No listar `.chavez`.

El `chat.get` de la API ya devuelve `metadata` jsonb — hoy el TUI lo tira. Incluir `metadata: row.metadata` al mapear `loadChat`.

- [ ] `cli/src/llm/watch-format.ts`: si no existe, crear `formatWatchLine` como agent-tools Task 5. Añadir:

```ts
  if (msg.type === "message.appended") {
    const message = rec(data.message);
    // ...
    const meta = rec(message?.metadata);
    const ignored = Array.isArray(meta?.ignoredAttaches)
      ? (meta!.ignoredAttaches as Array<{ error?: string; path?: string }>)
      : [];
    const attachNotes = ignored
      .map((a) => a.error || `Ignored path (not hydrated): ${a.path}`)
      .join(" | ");
    if (attachNotes) return `${role}: ${content}\n⚠ ${attachNotes}`;
  }
```

En `cli/src/commands/headless.ts` `chat watch`, si aún vuelca JSON crudo, pasar cada push por `formatWatchLine` y `console.log` esa línea (agent-tools). Garantizar que un output con `sk-ant-` **no** se imprime: el persistido ya viene redactado; como cinturón, `formatWatchLine` aplica `redactText` al string final.

- [ ] Correr (no hay runner de test en `web/`; cobertura RPC en Task 8):

```bash
cd cli && bun test src/llm/watch-format.test.ts src/llm/fs-tree.test.ts
```

Si `watch-format.test.ts` no existe, crear un caso: `formatWatchLine` de un `chat.tool.result` con output `sk-ant-abc` no contiene `sk-ant-`.

- [ ] Commit:

```bash
git add web/src/components/FileTreePanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/ChatDetailPanel.tsx \
  web/src/lib/ws-client.ts web/src/lib/ws-context.tsx web/src/lib/ws-hooks.ts \
  web/src/styles/global.css tui/src/App.tsx \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  cli/src/commands/headless.ts
git commit -m "feat(ignore): web tree + visible ignored-attach notices"
```

---

## Task 8: Smoke Gherkin — picker, harness, force, grep redact, diff, árbol

**Files:**

- Create: `cli/scripts/ignore-secrets-smoke.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`

Script local, sin LLM vivo. Usa un cwd tmp, el motor de ignore, hydrate, tools filter, fs.tree y (si la API está arriba) el RPC. No sustituye las units.

- [ ] Añadir en `cli/package.json`: `"test:ignore": "bun run scripts/ignore-secrets-smoke.ts"`.

- [ ] Crear `cli/scripts/ignore-secrets-smoke.ts`:

```ts
#!/usr/bin/env bun
/**
 * Smoke Plan 8 — ignore / secrets. No LLM.
 * Usage: bun run scripts/ignore-secrets-smoke.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace } from "../src/llm/fs-complete";
import { hydrateOne } from "../src/llm/hydrate-attachments";
import { decideAttach, hydrateForced } from "../src/llm/attach-force";
import { denyIfIgnored, filterGrepOrGlobOutput } from "../src/llm/tool-ignore";
import { listWorkspaceDir } from "../src/llm/fs-tree";
import { gitCommitBlockedReason } from "../src/llm/git-secret-guard";
import { redactDiffForCwd } from "../src/llm/secret-diff";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-p8-")));
mkdirSync(join(cwd, "src"));
mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
writeFileSync(join(cwd, "src", "node-util.ts"), "export const n = 1;\n");
writeFileSync(join(cwd, "src", "config.ts"), 'export const k = "sk-ant-api03-abc";\n');
writeFileSync(join(cwd, "src", "ok.ts"), "export {}\n");
writeFileSync(join(cwd, ".env"), "OPENAI_API_KEY=sk-live-super\n");
writeFileSync(join(cwd, ".env.example"), "OPENAI_API_KEY=\n");
writeFileSync(join(cwd, "README.md"), "hi\n");
for (let i = 0; i < 12; i++) {
  writeFileSync(join(cwd, "node_modules", "pkg", `n${i}.js`), "dep\n");
}

// Escenario: gitignore aplica al picker @
const nodeHits = completeWorkspace(cwd, "node");
assert(nodeHits.length <= 10, "picker cap 10");
assert(
  nodeHits.every((c) => !c.path.startsWith("node_modules/")),
  "picker leaked node_modules",
);
assert(
  nodeHits.some((c) => c.path === "src/node-util.ts"),
  "picker should still find src/node-util.ts",
);
console.log("ok  gitignore picker");

// Escenario: ignore del harness
assert(
  completeWorkspace(cwd, ".env").every((c) => c.path !== ".env"),
  ".env offered by picker",
);
const envAttach = hydrateOne(cwd, ".env");
assert(envAttach.status === "secret", ".env not rejected");
assert(!(envAttach.hydratedText || "").includes("sk-live-super"), "raw .env hydrated");
const readEnv = denyIfIgnored(cwd, "Read", { file_path: ".env" });
assert(readEnv?.behavior === "deny", "read .env not denied");
console.log("ok  harness ignore");

// Escenario: forzar archivo ignorado
const auto = decideAttach(cwd, "node_modules/pkg/n0.js", "auto");
assert(auto.attachment.status === "ignored", "auto should not hydrate junk");
assert(Boolean(auto.notice), "auto ignored silently");
const ask = decideAttach(cwd, "node_modules/pkg/n0.js", "ask");
assert(Boolean(ask.needsAsk), "ask should confirm junk");
const forced = hydrateForced(cwd, "node_modules/pkg/n0.js", "junk");
assert(forced.status === "ok", "force junk should hydrate");
console.log("ok  force ignored");

// Escenario: output de tool con key + vault nunca en timeline
const grep = filterGrepOrGlobOutput(
  cwd,
  "Grep",
  [
    'src/config.ts:1:export const k = "sk-ant-api03-abc";',
    ".chavez/config.json:1:accessToken=totally-secret",
    "node_modules/pkg/n0.js:1:dep",
  ].join("\n"),
);
assert(!grep.includes("sk-ant-"), "key not redacted");
assert(!grep.includes(".chavez"), "vault path in grep output");
assert(!grep.includes("accessToken"), "vault content in grep output");
assert(!grep.includes("node_modules"), "gitignore not applied to grep");
assert(grep.includes("src/config.ts"), "lost real grep hit");
console.log("ok  grep redact + vault");

// Escenario: diff no muestra secretos + git no commitea
const diff = redactDiffForCwd(
  cwd,
  [
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-OPENAI_API_KEY=old",
    "+OPENAI_API_KEY=new",
  ].join("\n"),
);
assert(!diff.includes("old") && !diff.includes("new"), "diff leaked .env values");
assert(gitCommitBlockedReason(cwd, ".env"), "git guard missed .env");
assert(gitCommitBlockedReason(cwd, ".chavez/config.json"), "git guard missed vault");
assert(gitCommitBlockedReason(cwd, "src/ok.ts") === null, "git guard blocked source");
const writeEnv = denyIfIgnored(cwd, "Write", { file_path: ".env" });
assert(writeEnv?.message.includes("Write blocked"), "write .env not blocked");
console.log("ok  diff + git guard");

// Escenario: árbol usa el mismo ignore
const tree = listWorkspaceDir(cwd, ".");
const names = tree.entries.map((e) => e.name);
assert(!names.includes("node_modules"), "tree listed node_modules");
assert(!names.includes(".env"), "tree listed .env");
assert(names.includes("src") && names.includes("README.md"), "tree missing root files");
console.log("ok  tree ignore");

console.log(`ignore-secrets smoke passed cwd=${cwd}`);
```

- [ ] Correr:

```bash
cd cli && bun run scripts/ignore-secrets-smoke.ts
cd cli && bun test src/llm/ignore.test.ts src/llm/redact.test.ts \
  src/llm/secret-scan.test.ts src/llm/fs-complete.test.ts \
  src/llm/hydrate-attachments.test.ts src/llm/attach-force.test.ts \
  src/llm/tool-ignore.test.ts src/llm/secret-diff.test.ts \
  src/llm/git-secret-guard.test.ts src/llm/fs-tree.test.ts
```

Esperado: `ignore-secrets smoke passed` y todos los tests verdes.

- [ ] Verificación manual (daemon + Web, no se automatiza en este script):

  1. `chavez headless workspace open` en un repo con `node_modules` en `.gitignore`.
  2. Web chat: escribir `@node` — el picker (plan 1) no lista `node_modules/…`; tope 10.
  3. Prompt con `@.env` — notice visible, el modelo no recibe el valor.
  4. En `ask`, `@node_modules/pkg/index.js` — chip/tool `attach` awaiting_approval; approve hidrata, deny avisa.
  5. Turn que hace Grep de `sk-ant-` en un `.ts` — ToolCard muestra `***`.
  6. Workspace page: panel Archivos con `hostname · path`; raíz sin `node_modules`. Sin daemon: mensaje de no filesystem, lista vacía.
  7. TUI y `chavez headless chat watch` muestran el mismo notice y el mismo output redactado.

- [ ] Commit:

```bash
git add cli/scripts/ignore-secrets-smoke.ts cli/package.json api/package.json
git commit -m "test(ignore): gherkin smoke for picker, secrets, tree, git guard"
```

---

## Orden y dependencias

| Task | Depende de | Demuestra |
|---|---|---|
| 1 | `workspace-path` (plan 1, se crea si falta) | gitignore + harness class |
| 2 | — | keys / dotenv / vault redact |
| 3 | 1, 2, attach-files hydrate/picker | `@` picker + force |
| 4 | 1, 2, agent-tools sandbox | grep/read/write |
| 5 | 1, 4 | diff + git guard |
| 6 | 1, attach-files pending/fs.complete | `fs.tree` |
| 7 | 3, 6 | Web árbol + notices |
| 8 | 1–7 | seis escenarios Gherkin |

Si attach-files o agent-tools no han aterrizado, las Tasks 1–2 y `fs-tree` / `completeWorkspace` siguen siendo válidas: el plan 1 llamará `completeWorkspace` ya filtrado; el plan 2 llamará `denyIfIgnored` desde `canUseTool`. No reescribir runners, solo enganchar.

Plan 7 (`git-workspace`) **debe** importar `assertCommitPathsAllowed` en el tool de commit. Plan 18 (`web-file-tree`) **debe** reutilizar `useWsFsTree` / `listWorkspaceDir` (no un segundo ignore). Plan 6 (`diffs-review`) **debe** pasar diffs por `redactDiffForCwd`.
