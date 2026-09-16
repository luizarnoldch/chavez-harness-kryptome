# Agent tools Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, modos `plan`/`auto`/`ask` (plan 3), cola de turns (plan 29), sandbox de red (plan 26), ni aprobaciones con timeout (plan 13). Spec: [`plan.md`](./plan.md).

**Goal:** El agente (Claude, ejecutable hoy) lee, busca, crea, parchea y opera vía shell el workspace local **por defecto**, sin que el usuario declare tools. Cada invocación se persiste como `role=tool`, se ve en vivo en Web, TUI y `chat watch`, y sobrevive un reload. Las lecturas no se confirman. Write/edit/bash se ejecutan en esta fase (equivalente a `auto`); el estado `awaiting_approval` existe en el contrato y en la UI para que el [plan 3](../execution-modes/plan.md) lo encienda. Cursor sigue sin ejecutar turns ([plan 4](../cursor-provider/plan.md)).

**Architecture:** El filesystem real vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). El Claude Agent SDK (`query`) corre **en ese proceso**, con `cwd` = path del workspace. La API **no** lee ni escribe disco: persiste `chat_messages` (`role=tool`) y hace fan-out WebSocket. Web / TUI / CLI `watch` son observadores del mismo chat.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API hub.findDaemon
        |                         | no daemon → fail "No daemon bound…"
        |                         | daemon.turnBusy → fail "Turn already running…"
        v                         v
  agent.turn.dispatch  ------>  daemon / TUI
        |
        v
  publishAgentTurn
        |  chat.append user (si no skip)
        |  provider runnable? (solo claude)
        |  query({ cwd, tools: DEFAULT_CLAUDE_TOOLS, canUseTool: sandbox })
        |
        |  tool_use  → chat.tool.start  { status: running, input, streamId }
        |  canUseTool path escape → deny → chat.tool.result { status: error }
        |  tool_result → chat.tool.result { status: done|error, output truncado }
        |  text        → chat.stream.delta
        |  success     → chat.stream.end (assistant)
        |  catch       → fail in-flight tools + chat.stream.error
        |  finally     → agent.turn.ended
        v
  API persist + broadcast  →  Web ToolCard | TUI messages | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` ya llama `query()` con `cwd` y `permissionMode: "bypassPermissions"`. **No** pasa `tools` / `allowedTools` / `canUseTool`. `bypassPermissions` se salta el sandbox de path.
- `cli/src/llm/publish-turn.ts` ya emite `chat.tool.start` / `chat.tool.result` y el error de provider no ejecutable. **No** trunca output, **no** redacts secretos, **no** marca tools in-flight como error si el turn muere.
- `api/src/ws/handlers.ts` ya persiste `role=tool` en start/result y hace broadcast. **No** hay `chat.tool.update`, **no** trunca, **no** falla tools `running` en `chat.stream.error`, **no** rechaza un segundo turn (el daemon lo ignora en silencio).
- Web `ChatDetailPanel.tsx` ya tiene `ToolCard` (nombre + status + JSON crudo). Falta `awaiting_approval`, truncado, summary, patch in-place, botones approve/deny.
- Web `WorkspaceDetailPanel.tsx` preview: `tool · ${name}` sin status.
- TUI `App.tsx`: `Message` no tiene `metadata`; pinta `role: content` y recarga `chat.get` entero. Compose se bloquea con `busy` (banner `… generando respuesta`).
- CLI `chat watch` vuelca JSON crudo de cada push (puede congelar con un grep enorme).
- `cli/src/llm/history.ts` **tira** filas `role=tool` al reconstruir el prompt. Correcto: el modelo relee con tools; el historial humano vive en DB.
- Schema `chat_messages.metadata` jsonb **ya existe**. No hay migración.
- Cursor `runnable: false`. No simular tools falsas.

**Tech Stack:** Bun, Hono WebSocket, Drizzle `chat_messages` jsonb, Claude Agent SDK `query` (`tools`, `allowedTools`, `canUseTool`, `PermissionResult`), Ink TUI, Astro/React web.

**Global Constraints:**

1. El filesystem se lee y escribe **solo** en el daemon (cwd del workspace). API y browser no ejecutan tools.
2. Sin daemon bound, `agent.turn.request` falla con **el mismo string** que ya existe: `"No daemon bound for this workspace. Run: chavez headless workspace open"`. No queda un mensaje `tool` huérfano.
3. Tools por defecto, sin configuración del usuario: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`. Otras tools del SDK que el modelo emita (p.ej. `TodoWrite`) se **visualizan** con el mismo contrato si aparecen; esta fase **no** las ofrece (`tools` es la lista de las 6).
4. Lecturas (read/grep/glob) no piden confirmación. Write/edit/bash en esta fase **se ejecutan** tras el sandbox de path (paridad `auto`). `awaiting_approval` es status de primer nivel en persistencia y UI; el gating lo enciende el plan 3.
5. Path traversal (`../`, absoluto fuera del cwd, symlink escape vía `realpathSync`) → la tool falla con `status: "error"` y mensaje `Path outside workspace: …`. No se lee ni escribe fuera.
6. Output enorme se trunca a `TOOL_OUTPUT_MAX_CHARS` **antes** de persistir, de enviarlo al broadcast y de pintarlo. El marcador es visible. El LLM recibe el resultado que el SDK ya acota; Chavez acota lo que ven los clientes.
7. Input visible **sin secretos crudos**: valores de keys `api_key`/`token`/`secret`/`password`/`authorization`/`credential` y patrones `sk-ant-…`, `ghp_…` se sustituyen por `***`.
8. 1 turn por daemon. El segundo `agent.turn.request` **falla de forma visible** (`"Turn already running on this daemon"`). No se mezclan tools de dos turns. Encolar es el plan 29.
9. Fallo a mitad de stream: `chat.stream.error`; tools `running` / `awaiting_approval` de ese `streamId` pasan a `error`; el chat acepta un turn nuevo (`agent.turn.ended` limpia `turnBusy`).
10. Append manual (`chat.append`) no dispara el runner ni tools.
11. Claude es el provider ejecutable. Cursor vinculado **no** ejecuta turns y **no** simula tools. El error existente se mantiene.
12. Web, TUI y CLI `watch` ven el mismo contrato: `tool · <nombre canónico> · <status>` + summary de input + output acotado.
13. Aprobaciones una a una, sin lote ni “siempre permitir”. Esta fase cablea `agent.tool.approve` / `agent.tool.deny` (forward al daemon). Sin waiter (plan 3 no activo) el daemon responde `"No tool awaiting approval"`.
14. No upload desde el navegador. No Cursor cloud. No red/sandbox de bash (plan 26). No ignore/secrets de grep (plan 8).

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `DEFAULT_CLAUDE_TOOLS` | `["Read", "Write", "Edit", "Grep", "Glob", "Bash"]` |
| `TOOL_OUTPUT_MAX_CHARS` | `8000` |
| `TOOL_STATUSES` | `"running"` \| `"awaiting_approval"` \| `"done"` \| `"error"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `PATH_ESCAPE_PREFIX` | `"Path outside workspace: "` |
| `PROVIDER_NOT_RUNNABLE` | `` `Provider activo "${id}" no ejecuta agente en daemon (solo claude)` `` |
| `CLAUDE_UNLINKED` | `"Claude no está vinculado — chavez provider link claude"` |

Nombres canónicos (timeline, nunca el PascalCase del SDK como único label):

| SDK `toolName` | Canónico |
|---|---|
| `Read` | `read` |
| `Write` | `write` |
| `Edit`, `NotebookEdit` | `edit` |
| `Grep` | `grep` |
| `Glob`, `LS` | `glob` |
| `Bash` | `bash` |
| cualquier otra | `toolName.toLowerCase()` |

Clases de tool para el sandbox (y para el plan 3):

- **read:** `Read`, `Grep`, `Glob`, `LS`
- **write:** `Write`, `Edit`, `NotebookEdit`, `Bash`

Campos de path en el input SDK: `file_path`, `path`, `notebook_path`.

---

## Task 1: Contrato canónico — nombres, summary, truncado, sandbox

**Files:**

- Create: `cli/src/llm/tool-names.ts`
- Create: `cli/src/llm/tool-display.ts`
- Create: `cli/src/llm/workspace-path.ts` (si attach-files **no** lo creó; si ya existe con `resolveInsideCwd` / `PathEscapeError`, no tocar)
- Create: `cli/src/llm/tool-sandbox.ts`
- Test: `cli/src/llm/tool-names.test.ts`
- Test: `cli/src/llm/tool-display.test.ts`
- Test: `cli/src/llm/tool-sandbox.test.ts`
- Test: `cli/src/llm/workspace-path.test.ts` (solo si creas el módulo aquí)
- Modify: `cli/package.json`

Módulos puros. TUI importa desde `cli/src/llm/…` igual que ya importa `publish-turn`. Web **no** importa CLI: Task 7 duplica el display.

- [ ] Añadir script de test en `cli/package.json` (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/tool-names.ts`:

```ts
export const DEFAULT_CLAUDE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash",
] as const;

export type SdkToolName = (typeof DEFAULT_CLAUDE_TOOLS)[number] | string;

export type CanonicalToolName =
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "bash"
  | string;

export const TOOL_STATUSES = [
  "running",
  "awaiting_approval",
  "done",
  "error",
] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

const CANONICAL: Record<string, CanonicalToolName> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "grep",
  Glob: "glob",
  LS: "glob",
  Bash: "bash",
};

const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);
const WRITE_SDK = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export function canonicalToolName(sdkName: string): CanonicalToolName {
  return CANONICAL[sdkName] ?? sdkName.toLowerCase() || "tool";
}

export function toolClass(sdkName: string): "read" | "write" | "other" {
  if (READ_SDK.has(sdkName)) return "read";
  if (WRITE_SDK.has(sdkName)) return "write";
  return "other";
}

export function isToolStatus(v: unknown): v is ToolStatus {
  return TOOL_STATUSES.includes(v as ToolStatus);
}
```

- [ ] Crear `cli/src/llm/tool-display.ts`:

```ts
import { canonicalToolName } from "./tool-names";

export const TOOL_OUTPUT_MAX_CHARS = 8000;

const SECRET_KEY_RE =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token)$/i;
const SECRET_VALUE_RE = /sk-ant-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+/g;

export function truncateToolText(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE_RE, "***");
}

export function sanitizeToolInput(input: unknown): unknown {
  if (typeof input === "string") return redactSecrets(input);
  if (Array.isArray(input)) return input.map(sanitizeToolInput);
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "***";
    } else {
      out[k] = sanitizeToolInput(v);
    }
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** One-line summary for timeline / watch. Never dumps file contents or secrets. */
export function summarizeToolInput(sdkName: string, input: unknown): string {
  const rec = asRecord(sanitizeToolInput(input));
  const name = canonicalToolName(sdkName);
  if (!rec) {
    const s = typeof input === "string" ? redactSecrets(input) : "";
    return s ? `${name} ${s.slice(0, 200)}` : name;
  }
  const filePath = str(rec.file_path) || str(rec.notebook_path) || str(rec.path);
  if (name === "read") {
    const off = rec.offset != null ? ` offset=${rec.offset}` : "";
    const lim = rec.limit != null ? ` limit=${rec.limit}` : "";
    return filePath ? `${filePath}${off}${lim}` : "read";
  }
  if (name === "write") return filePath || "write";
  if (name === "edit") {
    const oldS = str(rec.old_string);
    const newS = str(rec.new_string);
    if (filePath && oldS && newS) {
      return `${filePath}  −${oldS.split("\n").length} +${newS.split("\n").length} lines`;
    }
    return filePath || "edit";
  }
  if (name === "grep") {
    const pat = str(rec.pattern) || "";
    const p = filePath ? ` in ${filePath}` : "";
    return pat ? `${pat}${p}` : "grep";
  }
  if (name === "glob") {
    const pat = str(rec.pattern) || "";
    const p = filePath ? ` in ${filePath}` : "";
    return pat ? `${pat}${p}` : "glob";
  }
  if (name === "bash") {
    const cmd = str(rec.command) || "";
    return cmd ? redactSecrets(cmd).slice(0, 200) : "bash";
  }
  if (filePath) return filePath;
  try {
    return redactSecrets(JSON.stringify(rec)).slice(0, 200);
  } catch {
    return name;
  }
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return truncateToolText(redactSecrets(output));
  try {
    return truncateToolText(redactSecrets(JSON.stringify(output, null, 2)));
  } catch {
    return truncateToolText(String(output));
  }
}

export function toolHeadline(sdkName: string, status: string, input?: unknown): string {
  const name = canonicalToolName(sdkName);
  const summary = input !== undefined ? summarizeToolInput(sdkName, input) : "";
  return summary && summary !== name
    ? `tool · ${name} · ${status}  ${summary}`
    : `tool · ${name} · ${status}`;
}
```

- [ ] Si `cli/src/llm/workspace-path.ts` **no existe**, crearlo:

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
    const cwdReal = realpathSync(cwd);
    let resolved: string;
    try {
      resolved = realpathSync(relPath);
    } catch {
      throw new PathEscapeError(relPath);
    }
    const rel = relative(cwdReal, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new PathEscapeError(relPath);
    }
    return resolved;
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

Nota: un `file_path` absoluto **dentro** del cwd (el SDK casi siempre manda absolutos) debe **aceptarse**. Por eso `resolveInsideCwd` trata absolutos: `realpath` + `relative(cwd)` no puede empezar por `..`.

- [ ] Crear `cli/src/llm/tool-sandbox.ts`:

```ts
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";
import { toolClass } from "./tool-names";

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

export function extractToolPath(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Deny file tools whose path leaves cwd. Bash has no single path field;
 * network/FS de bash es plan 26. Reads y writes se sandboxean igual.
 */
export function assertToolPathInsideCwd(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
): void {
  const p = extractToolPath(input);
  if (!p) return;
  const cls = toolClass(sdkName);
  if (cls === "other" && !p) return;
  resolveInsideCwd(cwd, p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : p);
}

export function denyIfEscapes(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
): { behavior: "deny"; message: string } | null {
  try {
    assertToolPathInsideCwd(cwd, sdkName, input);
    return null;
  } catch (err) {
    const rel = err instanceof PathEscapeError ? err.relPath : String(err);
    return {
      behavior: "deny",
      message: `Path outside workspace: ${rel}`,
    };
  }
}
```

Para absolutos, `resolveInsideCwd` ya cubre el caso. Llamar siempre con el string tal cual viene del SDK.

- [ ] Crear `cli/src/llm/tool-names.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canonicalToolName, isToolStatus, toolClass } from "./tool-names";

describe("canonicalToolName", () => {
  test("maps SDK names", () => {
    expect(canonicalToolName("Read")).toBe("read");
    expect(canonicalToolName("Write")).toBe("write");
    expect(canonicalToolName("Edit")).toBe("edit");
    expect(canonicalToolName("NotebookEdit")).toBe("edit");
    expect(canonicalToolName("Grep")).toBe("grep");
    expect(canonicalToolName("Glob")).toBe("glob");
    expect(canonicalToolName("LS")).toBe("glob");
    expect(canonicalToolName("Bash")).toBe("bash");
  });

  test("unknown tools keep lowercase", () => {
    expect(canonicalToolName("TodoWrite")).toBe("todowrite");
  });
});

describe("toolClass", () => {
  test("reads vs writes", () => {
    expect(toolClass("Read")).toBe("read");
    expect(toolClass("Grep")).toBe("read");
    expect(toolClass("Write")).toBe("write");
    expect(toolClass("Bash")).toBe("write");
    expect(toolClass("TodoWrite")).toBe("other");
  });
});

describe("isToolStatus", () => {
  test("four statuses", () => {
    expect(isToolStatus("running")).toBe(true);
    expect(isToolStatus("awaiting_approval")).toBe(true);
    expect(isToolStatus("done")).toBe(true);
    expect(isToolStatus("error")).toBe(true);
    expect(isToolStatus("queued")).toBe(false);
  });
});
```

- [ ] Crear `cli/src/llm/tool-display.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_MAX_CHARS,
  redactSecrets,
  sanitizeToolInput,
  stringifyToolOutput,
  summarizeToolInput,
  toolHeadline,
  truncateToolText,
} from "./tool-display";

describe("truncateToolText", () => {
  test("leaves short text", () => {
    expect(truncateToolText("hi")).toBe("hi");
  });

  test("marks huge text", () => {
    const big = "x".repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const out = truncateToolText(big);
    expect(out.startsWith("x".repeat(TOOL_OUTPUT_MAX_CHARS))).toBe(true);
    expect(out).toContain("[truncated: showing");
    expect(out).toContain(`${TOOL_OUTPUT_MAX_CHARS + 50}`);
    expect(out.length).toBeLessThan(big.length);
  });
});

describe("sanitizeToolInput", () => {
  test("redacts secret keys and token patterns", () => {
    const s = sanitizeToolInput({
      file_path: "/repo/a.ts",
      api_key: "sk-ant-secretvalue",
      command: "curl -H ghp_abc1234567890 files",
    }) as Record<string, unknown>;
    expect(s.api_key).toBe("***");
    expect(s.file_path).toBe("/repo/a.ts");
    expect(String(s.command)).not.toContain("ghp_");
    expect(String(s.command)).toContain("***");
  });
});

describe("summarizeToolInput", () => {
  test("read path + range", () => {
    expect(
      summarizeToolInput("Read", { file_path: "src/auth.ts", offset: 10, limit: 40 }),
    ).toBe("src/auth.ts offset=10 limit=40");
  });

  test("grep query", () => {
    expect(summarizeToolInput("Grep", { pattern: "device code", path: "src" })).toBe(
      "device code in src",
    );
  });

  test("bash command redacted", () => {
    expect(summarizeToolInput("Bash", { command: "echo sk-ant-abc" })).toBe(
      "echo ***",
    );
  });

  test("edit shows path not full file", () => {
    const s = summarizeToolInput("Edit", {
      file_path: "src/a.ts",
      old_string: "function X() {}",
      new_string: "function Y() {}",
    });
    expect(s.startsWith("src/a.ts")).toBe(true);
    expect(s).not.toContain("function X");
  });
});

describe("stringifyToolOutput", () => {
  test("truncates", () => {
    const out = stringifyToolOutput("y".repeat(TOOL_OUTPUT_MAX_CHARS + 1));
    expect(out).toContain("[truncated:");
  });
});

describe("toolHeadline", () => {
  test("running read", () => {
    expect(toolHeadline("Read", "running", { file_path: "README.md" })).toBe(
      "tool · read · running  README.md",
    );
  });
});

describe("redactSecrets", () => {
  test("does not eat normal text", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});
```

- [ ] Crear `cli/src/llm/tool-sandbox.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyIfEscapes, extractToolPath } from "./tool-sandbox";

describe("extractToolPath", () => {
  test("file_path wins", () => {
    expect(extractToolPath({ file_path: "a.ts", path: "b" })).toBe("a.ts");
  });
});

describe("denyIfEscapes", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-tool-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "ok");

  test("allows relative inside", () => {
    expect(denyIfEscapes(cwd, "Read", { file_path: "src/a.ts" })).toBeNull();
  });

  test("allows absolute inside", () => {
    expect(denyIfEscapes(cwd, "Write", { file_path: join(cwd, "src", "a.ts") })).toBeNull();
  });

  test("denies parent escape", () => {
    const d = denyIfEscapes(cwd, "Read", { file_path: "../../.ssh/id_rsa" });
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toContain("Path outside workspace:");
  });

  test("denies absolute outside", () => {
    const d = denyIfEscapes(cwd, "Write", { file_path: "/etc/passwd" });
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toContain("Path outside workspace:");
  });

  test("bash without path is not denied here", () => {
    expect(denyIfEscapes(cwd, "Bash", { command: "ls" })).toBeNull();
  });
});
```

- [ ] Si creaste `workspace-path.ts` aquí, añadir `cli/src/llm/workspace-path.test.ts` idéntico al de attach-files (relativo ok, `../` throw, absoluto fuera throw, missing in-workspace lexical).

- [ ] Correr:

```bash
cd cli && bun test src/llm/tool-names.test.ts src/llm/tool-display.test.ts src/llm/tool-sandbox.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/tool-names.ts cli/src/llm/tool-display.ts \
  cli/src/llm/tool-sandbox.ts cli/src/llm/tool-names.test.ts \
  cli/src/llm/tool-display.test.ts cli/src/llm/tool-sandbox.test.ts \
  cli/src/llm/workspace-path.ts cli/src/llm/workspace-path.test.ts \
  cli/package.json
git commit -m "feat(tools): canonical names, truncated display, path sandbox"
```

Si `workspace-path.ts` ya venía de attach, no lo incluyas en el commit.

---

## Task 2: API — `chat.tool.update`, truncado, fail in-flight, busy, OpenAPI

**Files:**

- Create: `api/src/ws/tool-protocol.ts`
- Test: `api/src/ws/tool-protocol.test.ts`
- Modify: `api/src/ws/hub.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API no ejecuta tools. Sí garantiza: persistencia estable, output acotado, tools huérfanas a `error` si el stream muere, y rechazo visible del segundo turn.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` (dejar el resto).

- [ ] Crear `api/src/ws/tool-protocol.ts`:

```ts
export const TOOL_OUTPUT_MAX_CHARS = 8000;
export const TOOL_STATUSES = [
  "running",
  "awaiting_approval",
  "done",
  "error",
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";

export function isToolStatus(v: unknown): v is ToolStatus {
  return TOOL_STATUSES.includes(v as ToolStatus);
}

export function truncateToolText(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export type ToolMeta = {
  toolCallId?: unknown;
  toolName?: unknown;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  streamId?: unknown;
  sdkName?: unknown;
  truncated?: unknown;
};

export function asToolMeta(v: unknown): ToolMeta {
  return v && typeof v === "object" ? (v as ToolMeta) : {};
}

export function isRunningToolMeta(meta: ToolMeta, streamId?: string): boolean {
  const st = meta.status;
  if (st !== "running" && st !== "awaiting_approval") return false;
  if (streamId && meta.streamId && String(meta.streamId) !== streamId) return false;
  return true;
}

export function applyToolResult(
  prev: ToolMeta,
  patch: {
    status?: string;
    output?: string;
    input?: unknown;
    toolName?: string;
  },
): ToolMeta {
  const output =
    patch.output != null ? truncateToolText(patch.output) : prev.output;
  const truncated =
    typeof patch.output === "string" && patch.output.length > TOOL_OUTPUT_MAX_CHARS;
  return {
    ...prev,
    status: isToolStatus(patch.status) ? patch.status : (prev.status as string) || "done",
    output,
    input: patch.input !== undefined ? patch.input : prev.input,
    toolName: patch.toolName || prev.toolName,
    truncated: truncated || prev.truncated || false,
  };
}

export function failToolMeta(prev: ToolMeta, reason: string): ToolMeta {
  return {
    ...prev,
    status: "error",
    output: truncateToolText(String(prev.output || reason)),
  };
}
```

- [ ] Crear `api/src/ws/tool-protocol.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_MAX_CHARS,
  applyToolResult,
  failToolMeta,
  isRunningToolMeta,
  truncateToolText,
} from "./tool-protocol";

describe("truncateToolText", () => {
  test("marks overflow", () => {
    const out = truncateToolText("z".repeat(TOOL_OUTPUT_MAX_CHARS + 3));
    expect(out).toContain("[truncated:");
  });
});

describe("applyToolResult", () => {
  test("keeps input, sets done", () => {
    const next = applyToolResult(
      { toolCallId: "t1", toolName: "read", status: "running", input: { file_path: "a.ts" } },
      { status: "done", output: "hello" },
    );
    expect(next.status).toBe("done");
    expect(next.output).toBe("hello");
    expect(next.input).toEqual({ file_path: "a.ts" });
  });

  test("truncates huge output", () => {
    const next = applyToolResult({}, { status: "done", output: "q".repeat(TOOL_OUTPUT_MAX_CHARS + 1) });
    expect(String(next.output)).toContain("[truncated:");
    expect(next.truncated).toBe(true);
  });
});

describe("isRunningToolMeta", () => {
  test("matches streamId", () => {
    expect(isRunningToolMeta({ status: "running", streamId: "s1" }, "s1")).toBe(true);
    expect(isRunningToolMeta({ status: "running", streamId: "s1" }, "s2")).toBe(false);
    expect(isRunningToolMeta({ status: "done", streamId: "s1" }, "s1")).toBe(false);
    expect(isRunningToolMeta({ status: "awaiting_approval" })).toBe(true);
  });
});

describe("failToolMeta", () => {
  test("error status", () => {
    expect(failToolMeta({ status: "running" }, "stream aborted").status).toBe("error");
  });
});
```

- [ ] En `api/src/ws/hub.ts`, ampliar `HubConnection`:

```ts
export type HubConnection = {
  connectionId: string;
  userId: string;
  workspaceId: string | null;
  path: string | null;
  clientKind: ClientKind;
  connectedAt: string;
  ws: WSContext;
  turnBusy: boolean;
  turnChatId: string | null;
};
```

En `add()`, default `turnBusy: false`, `turnChatId: null`.

Añadir métodos:

```ts
setTurnBusy(connectionId: string, busy: boolean, chatId: string | null = null) {
  const c = connections.get(connectionId);
  if (!c) return;
  c.turnBusy = busy;
  c.turnChatId = busy ? chatId : null;
},
isDaemonBusy(userId: string, workspaceId: string): boolean {
  const d = this.findDaemon(userId, workspaceId);
  return Boolean(d?.turnBusy);
},
```

`remove()` ya borra la conexión: un daemon que se cae libera el busy.

- [ ] En `api/src/ws/protocol.ts`, no hace falta un tipo nuevo: `ClientMessage` ya tiene `toolCallId`, `toolName`, `status`, `metadata`, `streamId`. Dejarlo.

- [ ] En `api/src/ws/handlers.ts`:

  1. Importar `NO_DAEMON_ERROR`, `TURN_BUSY_ERROR`, `applyToolResult`, `asToolMeta`, `failToolMeta`, `isRunningToolMeta`, `isToolStatus`, `truncateToolText` desde `./tool-protocol`.

  2. Extraer helper local (mismo archivo):

```ts
async function failRunningTools(
  userId: string,
  chatId: string,
  streamId: string | undefined,
  reason: string,
) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId));
  for (const row of rows) {
    if (row.role !== "tool") continue;
    const prev = asToolMeta(row.metadata);
    if (!isRunningToolMeta(prev, streamId)) continue;
    const metadata = failToolMeta(prev, reason);
    const content = String(metadata.output || reason);
    await db
      .update(chatMessages)
      .set({ metadata, content })
      .where(eq(chatMessages.id, row.id));
    const message = { ...row, metadata, content };
    broadcast(userId, "chat.tool.result", { message, chatId, updated: true });
    broadcast(userId, "message.appended", { message, chatId, updated: true });
  }
}
```

  3. `chat.tool.start`: persistir también `streamId` y `sdkName` si vienen en `msg.metadata` / `msg.streamId`. `status` inicial `"running"` salvo que `msg.status` sea un `ToolStatus` válido. `content` = `msg.content?.trim() || msg.toolName` (el daemon mandará el headline canónico).

```ts
metadata: {
  toolCallId: msg.toolCallId,
  toolName: msg.toolName,
  sdkName: msg.metadata?.sdkName ?? msg.toolName,
  status: isToolStatus(msg.status) ? msg.status : "running",
  input: msg.metadata?.input ?? null,
  streamId: msg.streamId ?? msg.metadata?.streamId ?? null,
},
```

  4. `chat.tool.result`: usar `applyToolResult`. `content` persistido = output truncado (o el content previo si output vacío).

  5. Nuevo case `chat.tool.update`:

```ts
case "chat.tool.update": {
  if (!msg.chatId || !msg.toolCallId) {
    return fail(type, id, "chatId and toolCallId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const existing = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, msg.chatId))
    .orderBy(desc(chatMessages.createdAt));
  const toolRow = existing.find((m) => {
    const meta = asToolMeta(m.metadata);
    return m.role === "tool" && meta.toolCallId === msg.toolCallId;
  });
  if (!toolRow) return fail(type, id, "Tool call not found");
  const prev = asToolMeta(toolRow.metadata);
  const metadata = {
    ...prev,
    status: isToolStatus(msg.status) ? msg.status : prev.status,
    input: msg.metadata?.input !== undefined ? msg.metadata.input : prev.input,
    output:
      msg.content != null && msg.content !== ""
        ? truncateToolText(msg.content)
        : prev.output,
  };
  await db
    .update(chatMessages)
    .set({ metadata })
    .where(eq(chatMessages.id, toolRow.id));
  const message = { ...toolRow, metadata };
  broadcast(userId, "chat.tool.update", { message, chatId: msg.chatId });
  broadcast(userId, "message.appended", {
    message,
    chatId: msg.chatId,
    updated: true,
  });
  return ok(type, id, { message });
}
```

  6. `chat.stream.error`: **después** de armar `payload`, llamar `await failRunningTools(userId, msg.chatId, msg.streamId, payload.error)` y luego `broadcast` del stream error. Así las tools no quedan `running` para siempre.

  7. `agent.turn.request`: sustituir el string inline de no-daemon por `NO_DAEMON_ERROR`. Tras `findDaemon`:

```ts
if (hub.isDaemonBusy(userId, ctx.workspaceId)) {
  return fail(type, id, TURN_BUSY_ERROR);
}
```

Tras `sendTo` ok:

```ts
hub.setTurnBusy(daemon.connectionId, true, msg.chatId);
```

Si `!sent`, no marcar busy.

  8. Nuevos cases:

```ts
case "agent.turn.started": {
  hub.setTurnBusy(connectionId, true, msg.chatId ?? null);
  broadcast(userId, "agent.turn.started", {
    chatId: msg.chatId,
    connectionId,
  });
  return ok(type, id, { busy: true });
}
case "agent.turn.ended": {
  hub.setTurnBusy(connectionId, false, null);
  broadcast(userId, "agent.turn.ended", {
    chatId: msg.chatId,
    connectionId,
  });
  return ok(type, id, { busy: false });
}
case "agent.tool.approve":
case "agent.tool.deny": {
  if (!msg.chatId || !msg.toolCallId) {
    return fail(type, id, "chatId and toolCallId are required");
  }
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent(type, {
      chatId: msg.chatId,
      toolCallId: msg.toolCallId,
      requesterConnectionId: connectionId,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return ok(type, id, { forwarded: true });
}
```

  `chat.append` **no** cambia: no dispara tools.

- [ ] En `api/openapi/openapi.yaml`:

  - Descripción de `/ws`: añadir `chat.tool.update`, `agent.turn.started`, `agent.turn.ended`, `agent.tool.approve`, `agent.tool.deny`.
  - Schema `ChatMessage.role` enum: `user | assistant | system | tool`. Añadir `metadata` object.
  - `WsClientChatStreamReserved.type` enum: añadir `chat.tool.update`.

- [ ] Correr:

```bash
cd api && bun test src/ws/tool-protocol.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/ws/tool-protocol.ts api/src/ws/tool-protocol.test.ts \
  api/src/ws/hub.ts api/src/ws/handlers.ts api/openapi/openapi.yaml api/package.json
git commit -m "feat(tools): persist tool updates, truncate, fail in-flight, busy lock"
```

---

## Task 3: Runner Claude — tools por defecto, sandbox, eventos, in-flight

**Files:**

- Create: `cli/src/llm/sdk-tool-events.ts`
- Test: `cli/src/llm/sdk-tool-events.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`

El SDK ejecuta las 6 tools en el `cwd` del daemon. `canUseTool` deniega path escape y **permite** el resto (esta fase = auto). `permissionMode` pasa de `bypassPermissions` a `default` para que `canUseTool` corra.

- [ ] Crear `cli/src/llm/sdk-tool-events.ts`:

```ts
import type { AgentTurnEvent } from "./claude-runner";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function outputOf(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === "string") return c;
  try {
    return JSON.stringify(c ?? "");
  } catch {
    return String(c ?? "");
  }
}

/** Map one SDK assistant/user content list into harness events. */
export function eventsFromBlocks(blocks: unknown): AgentTurnEvent[] {
  if (!Array.isArray(blocks)) return [];
  const out: AgentTurnEvent[] = [];
  for (const block of blocks) {
    const b = asRecord(block);
    if (!b) continue;
    const type = String(b.type || "");
    if (type === "text" && typeof b.text === "string" && b.text) {
      out.push({ kind: "stream_delta", text: b.text });
    }
    if (type === "tool_use") {
      out.push({
        kind: "tool_start",
        toolCallId: String(b.id || crypto.randomUUID()),
        toolName: String(b.name || "tool"),
        input: b.input,
      });
    }
    if (type === "tool_result") {
      out.push({
        kind: "tool_result",
        toolCallId: String(b.tool_use_id || b.id || crypto.randomUUID()),
        output: outputOf(b),
        status: b.is_error ? "error" : "done",
      });
    }
  }
  return out;
}

export function eventsFromSdkMessage(msg: Record<string, unknown>): AgentTurnEvent[] {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  const out: AgentTurnEvent[] = [];

  if (type === "assistant" || type === "user") {
    const messageObj = asRecord(msg.message);
    out.push(...eventsFromBlocks(messageObj?.content ?? msg.content));
  }

  if (type === "stream_event") {
    const event = asRecord(msg.event);
    const delta = asRecord(event?.delta);
    if (delta && typeof delta.text === "string" && delta.text) {
      out.push({ kind: "stream_delta", text: delta.text });
    }
    if (event && String(event.type || "") === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block && String(block.type || "") === "tool_use") {
        out.push({
          kind: "tool_start",
          toolCallId: String(block.id || crypto.randomUUID()),
          toolName: String(block.name || "tool"),
          input: block.input,
        });
      }
    }
  }

  if (type === "result" && subtype === "success" && typeof msg.result === "string") {
    out.push({ kind: "result", text: msg.result });
  }

  return out;
}

export function sdkResultError(msg: Record<string, unknown>): string | null {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  if (type === "result" && subtype && subtype !== "success") {
    return String(msg.error || msg.result || `Claude turn failed (${subtype})`);
  }
  return null;
}
```

Mover el type `AgentTurnEvent` a este archivo **o** dejarlo en `claude-runner.ts` e importar. Preferir: el type sigue en `claude-runner.ts` y `sdk-tool-events.ts` importa el type. Para no circular, extraer el type a `cli/src/llm/agent-events.ts`:

```ts
export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | { kind: "tool_start"; toolCallId: string; toolName: string; input?: unknown }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      output: string;
      status?: string;
    }
  | { kind: "result"; text: string };
```

`claude-runner.ts` re-exporta `export type { AgentTurnEvent } from "./agent-events"` para no romper imports actuales.

- [ ] Crear `cli/src/llm/sdk-tool-events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { eventsFromSdkMessage, sdkResultError } from "./sdk-tool-events";

describe("eventsFromSdkMessage", () => {
  test("tool_use then tool_result", () => {
    const start = eventsFromSdkMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    });
    expect(start).toEqual([
      {
        kind: "tool_start",
        toolCallId: "tu1",
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
    const result = eventsFromSdkMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "# hello", is_error: false },
        ],
      },
    });
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      toolCallId: "tu1",
      status: "done",
      output: "# hello",
    });
  });

  test("failed bash is error, not crash", () => {
    const result = eventsFromSdkMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "b1",
            content: "exit 1\nfail",
            is_error: true,
          },
        ],
      },
    });
    expect(result[0]?.kind === "tool_result" && result[0].status).toBe("error");
  });

  test("stream delta", () => {
    const ev = eventsFromSdkMessage({
      type: "stream_event",
      event: { delta: { text: "Hola" } },
    });
    expect(ev).toEqual([{ kind: "stream_delta", text: "Hola" }]);
  });
});

describe("sdkResultError", () => {
  test("error subtype", () => {
    expect(sdkResultError({ type: "result", subtype: "error", error: "boom" })).toBe(
      "boom",
    );
    expect(sdkResultError({ type: "result", subtype: "success", result: "ok" })).toBeNull();
  });
});
```

- [ ] Reescribir el loop de `cli/src/llm/claude-runner.ts`:

  - Importar `DEFAULT_CLAUDE_TOOLS` y `denyIfEscapes`.
  - Importar `eventsFromSdkMessage`, `sdkResultError`.
  - Quitar `permissionMode: "bypassPermissions"`.
  - Options:

```ts
const options: Record<string, unknown> = {
  model: input.model,
  cwd: input.cwd,
  env: cleanEnv,
  settingSources: [],
  tools: [...DEFAULT_CLAUDE_TOOLS],
  allowedTools: [...DEFAULT_CLAUDE_TOOLS],
  permissionMode: "default",
  permissionPrompts: "host",
  canUseTool: async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => {
    const denied = denyIfEscapes(input.cwd, toolName, toolInput);
    if (denied) return denied;
    return { behavior: "allow" as const };
  },
};
```

  - Deduplicar `tool_start` por `toolCallId` (stream_event + assistant message pueden repetir).
  - Si `sdkResultError(msg)` no es null, `throw new Error(...)`.
  - Si el loop termina sin `finalResult`, throw igual que ahora.
  - **No** capturar el throw: `publish-turn` lo convierte en stream error.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Importar `canonicalToolName`, `stringifyToolOutput`, `summarizeToolInput`, `sanitizeToolInput`, `toolHeadline` y `DEFAULT_CLAUDE_TOOLS` no hace falta aquí.

  2. Track in-flight:

```ts
const inFlight = new Map<
  string,
  { toolName: string; input?: unknown }
>();
```

  3. Al inicio del try, **antes** de `runClaudeTurn`:

```ts
await client.request({ type: "agent.turn.started", chatId });
```

  4. En `onEvent`:

```ts
if (ev.kind === "tool_start") {
  if (inFlight.has(ev.toolCallId)) return;
  inFlight.set(ev.toolCallId, { toolName: ev.toolName, input: ev.input });
  const sdkName = ev.toolName;
  const name = canonicalToolName(sdkName);
  await client.request({
    type: "chat.tool.start",
    chatId,
    streamId,
    toolCallId: ev.toolCallId,
    toolName: name,
    content: toolHeadline(sdkName, "running", ev.input),
    metadata: {
      sdkName,
      input: sanitizeToolInput(ev.input),
      summary: summarizeToolInput(sdkName, ev.input),
      streamId,
    },
  });
}
if (ev.kind === "tool_result") {
  inFlight.delete(ev.toolCallId);
  const sdkName = ev.toolName || "tool";
  const output = stringifyToolOutput(ev.output);
  await client.request({
    type: "chat.tool.result",
    chatId,
    streamId,
    toolCallId: ev.toolCallId,
    toolName: canonicalToolName(sdkName),
    content: output,
    status: ev.status === "error" ? "error" : "done",
  });
}
```

  5. `finally` **siempre** (éxito o catch):

```ts
try {
  await client.request({ type: "agent.turn.ended", chatId });
} catch {
  // connection already dead
}
```

  Poner el `ended` en un `finally` que envuelva el try/catch actual del stream. Orden en catch:

  a. Para cada id en `inFlight`, `chat.tool.result` con `status: "error"` y `content` = mensaje del error (truncado).
  b. `chat.stream.error`.
  c. rethrow.
  d. `finally` → `agent.turn.ended`.

  6. El error de provider no ejecutable y Claude unlinked se lanzan **antes** de `stream.start` y **antes** de `agent.turn.started` (como ahora, justo tras el append del user). Así no queda stream huérfano ni tool. Mantener los strings actuales.

  7. `runClaudeTurn` sigue recibiendo `cwd` del caller (daemon path). Nunca `process.cwd()` del API.

- [ ] Correr:

```bash
cd cli && bun test src/llm/sdk-tool-events.test.ts src/llm/tool-sandbox.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/agent-events.ts cli/src/llm/sdk-tool-events.ts \
  cli/src/llm/sdk-tool-events.test.ts cli/src/llm/claude-runner.ts \
  cli/src/llm/publish-turn.ts
git commit -m "feat(tools): default Claude FS/shell tools with path sandbox"
```

Si no extraes `agent-events.ts` y dejas el type en `claude-runner.ts`, ajusta el `git add`.

---

## Task 4: Daemon y TUI — lock visible, dispatch, sin tools huérfanas

**Files:**

- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`

Hoy, si `turnBusy`, el daemon **ignora** el dispatch (log local, el requester ya recibió `accepted: true`). Tras Task 2 el API rechaza el segundo request. Esta task cubre: el daemon que aún recibe un dispatch stale, y el turn local de la TUI que no pasa por `agent.turn.request`.

- [ ] En `cli/src/ws/daemon.ts`, el flag `turnBusy` local se queda como cinturón. Si llega `agent.turn.dispatch` con `turnBusy === true`:

```ts
if (turnBusy) {
  log("turn already running — rejecting dispatch");
  try {
    await client.request({
      type: "chat.stream.error",
      chatId: data.chatId,
      streamId: crypto.randomUUID(),
      content: "Turn already running on this daemon",
    });
  } catch {
    // ignore
  }
  return;
}
```

No llamar `publishAgentTurn`. No crear mensajes tool.

En el `onPush`, también escuchar:

```ts
if (msg.type === "agent.tool.approve" || msg.type === "agent.tool.deny") {
  log(`${msg.type} ignored — execution-modes plan not active`);
  return;
}
```

(`publishAgentTurn` ya emite `started`/`ended`. El API marca busy en el request **y** en started: idempotente.)

- [ ] En `tui/src/App.tsx`, el handler de `agent.turn.dispatch` ya usa `turnBusyRef`. Si está busy, además de `setLog("Turn remoto ignorado — ya hay uno en curso")`, emitir el mismo `chat.stream.error` que el daemon (un request, no un throw):

```ts
if (turnBusyRef.current) {
  setLog("Turn already running on this daemon");
  void client.request({
    type: "chat.stream.error",
    chatId: data.chatId,
    streamId: crypto.randomUUID(),
    content: "Turn already running on this daemon",
  });
  return;
}
```

`sendWithLlm` ya bloquea con `turnBusyRef` + `setLog("Ya hay un turn en curso")`. Dejarlo. `publishAgentTurn` marcará busy en el API para que Web no cuele un segundo turn.

El branch Cursor (`provider !== "claude"`) **sigue** sin llamar al runner: append user + log `"Cursor LLM aún no implementado — solo se guardó el mensaje user"`. No inventar tools.

Si Claude no está linked, el log existente se mantiene; `publishAgentTurn` no se llama.

- [ ] Commit:

```bash
git add cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(tools): reject concurrent turns visibly on daemon and TUI"
```

---

## Task 5: CLI `chat watch` — tools y deltas en orden, acotados

**Files:**

- Create: `cli/src/llm/watch-format.ts`
- Test: `cli/src/llm/watch-format.test.ts`
- Modify: `cli/src/commands/headless.ts`

Gherkin: start/result de tools en orden, y deltas de texto del assistant, sin congelar con megabytes.

- [ ] Crear `cli/src/llm/watch-format.ts`:

```ts
import { canonicalToolName } from "./tool-names";
import { TOOL_OUTPUT_MAX_CHARS, toolHeadline, truncateToolText } from "./tool-display";

export type WatchPush = {
  type: string;
  data?: unknown;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function toolFromPayload(data: Record<string, unknown>): {
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
} {
  const message = rec(data.message);
  const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
  const sdkName = String(meta.sdkName || meta.toolName || data.toolName || "tool");
  return {
    name: canonicalToolName(sdkName),
    status: String(meta.status || data.status || "running"),
    input: meta.input,
    output: meta.output ?? message?.content,
  };
}

/** One compact stdout line. Never dumps more than TOOL_OUTPUT_MAX_CHARS. */
export function formatWatchLine(msg: WatchPush): string | null {
  const data = rec(msg.data) ?? {};
  if (msg.type === "chat.tool.start") {
    const t = toolFromPayload(data);
    return toolHeadline(t.name, t.status || "running", t.input);
  }
  if (msg.type === "chat.tool.result" || msg.type === "chat.tool.update") {
    const t = toolFromPayload(data);
    const head = `tool · ${t.name} · ${t.status}`;
    if (t.status === "error" && t.output != null) {
      return `${head}\n${truncateToolText(String(t.output), 500)}`;
    }
    if (t.output != null && t.status === "done") {
      const body = truncateToolText(String(t.output), 500);
      return `${head}\n${body}`;
    }
    return head;
  }
  if (msg.type === "chat.stream.delta") {
    const delta = String(data.delta ?? data.content ?? "");
    if (!delta) return null;
    return `assistant Δ ${truncateToolText(delta, 400)}`;
  }
  if (msg.type === "chat.stream.start") return "stream start";
  if (msg.type === "chat.stream.end") return "stream end";
  if (msg.type === "chat.stream.error") {
    return `stream error  ${String(data.error ?? data.content ?? "")}`;
  }
  if (msg.type === "message.appended") {
    const message = rec(data.message);
    if (!message) return null;
    if (data.updated) return null;
    const role = String(message.role || "");
    if (role === "tool") return null;
    const content = truncateToolText(String(message.content || ""), 400);
    return `${role}: ${content}`;
  }
  if (msg.type === "agent.turn.started") return "turn started";
  if (msg.type === "agent.turn.ended") return "turn ended";
  return null;
}

export { TOOL_OUTPUT_MAX_CHARS };
```

- [ ] Crear `cli/src/llm/watch-format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";

describe("formatWatchLine", () => {
  test("tool start then result in order", () => {
    const start = formatWatchLine({
      type: "chat.tool.start",
      data: {
        message: {
          role: "tool",
          metadata: {
            sdkName: "Read",
            toolName: "read",
            status: "running",
            input: { file_path: "src/auth.ts" },
          },
        },
      },
    });
    expect(start).toBe("tool · read · running  src/auth.ts");
    const done = formatWatchLine({
      type: "chat.tool.result",
      data: {
        message: {
          role: "tool",
          content: "export function login() {}",
          metadata: { sdkName: "Read", toolName: "read", status: "done", output: "export function login() {}" },
        },
      },
    });
    expect(done).toContain("tool · read · done");
    expect(done).toContain("export function login");
  });

  test("delta", () => {
    expect(
      formatWatchLine({ type: "chat.stream.delta", data: { delta: "Hola" } }),
    ).toBe("assistant Δ Hola");
  });

  test("huge output is truncated", () => {
    const line = formatWatchLine({
      type: "chat.tool.result",
      data: {
        message: {
          metadata: { toolName: "grep", status: "done", output: "m".repeat(20_000) },
        },
      },
    });
    expect(line).toContain("[truncated:");
    expect(String(line).length).toBeLessThan(5000);
  });

  test("skips duplicate updated append", () => {
    expect(
      formatWatchLine({
        type: "message.appended",
        data: { updated: true, message: { role: "tool", content: "x" } },
      }),
    ).toBeNull();
  });
});
```

- [ ] En `cli/src/commands/headless.ts`, el `onPush` de `watch` pasa a:

```ts
import { formatWatchLine } from "../llm/watch-format";

watchClient.onPush((msg) => {
  const data = msg.data as { chatId?: string } | undefined;
  if (data?.chatId && data.chatId !== chatId) return;
  const line = formatWatchLine({ type: msg.type, data: msg.data });
  if (line) console.log(line);
});
```

Ya no se imprime el JSON completo (congelaba con grep masivo).

`chat ask` no cambia: dispara `agent.turn.request` y apunta a `watch`. `chat append` sigue siendo solo `chat.append`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  cli/src/commands/headless.ts
git commit -m "feat(tools): compact CLI watch lines for tool start/result and deltas"
```

---

## Task 6: TUI — timeline user / assistant / tool, update in-place

**Files:**

- Modify: `tui/src/App.tsx`

Gherkin: la lista distingue roles; un tool `running` pasa in-place a `done`/`error`; el compositor está busy de forma explícita.

- [ ] Ampliar el type `Message`:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

- [ ] Importar `canonicalToolName` y `toolHeadline` / `summarizeToolInput` desde `../../cli/src/llm/tool-names` y `../../cli/src/llm/tool-display`.

- [ ] Helper en el mismo archivo:

```ts
function upsertMessage(prev: Message[], incoming: Message): Message[] {
  const i = prev.findIndex((m) => m.id === incoming.id);
  if (i >= 0) {
    const next = prev.slice();
    next[i] = incoming;
    return next;
  }
  return [...prev, incoming];
}

function formatTuiMessage(m: Message): { color: string; text: string } {
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const sdkName = String(meta.sdkName || meta.toolName || "tool");
    const status = String(meta.status || "running");
    const color =
      status === "error"
        ? "red"
        : status === "done"
          ? "cyan"
          : status === "awaiting_approval"
            ? "magenta"
            : "yellow";
    const text = toolHeadline(sdkName, status, meta.input);
    return { color, text };
  }
  return {
    color: m.role === "assistant" ? "green" : "magenta",
    text: `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 100)}`,
  };
}
```

- [ ] En el `onPush` (el efecto que ya escucha `chat.tool.*` / `message.appended`):

  - Si `msg.data.message` existe y `data.chatId === activeChatIdRef.current`, `setMessages((prev) => upsertMessage(prev, message))` **en vez de** (o **antes de**) `loadChat`. Así running → done no espera el round-trip.
  - Seguir llamando `loadChat` en `chat.stream.end` / `chat.stream.error` para el assistant final.
  - Si `msg.type === "chat.stream.error"` y el error es el de busy / no-runner / provider, `setLog` con ese string.

- [ ] Render de messages: sustituir el bloque actual `messages.slice(-8).map` por:

```tsx
<Box marginTop={1} flexDirection="column" height={12}>
  <Text bold>Messages</Text>
  {messages.slice(-10).map((m) => {
    const { color, text } = formatTuiMessage(m);
    return (
      <Text key={m.id} wrap="truncate-end" color={color}>
        {text}
      </Text>
    );
  })}
</Box>
```

- [ ] Banner busy: dejar `… generando respuesta`. Añadir, si hay algún tool `status === "running"` o `"awaiting_approval"`:

```tsx
{messages.some((m) => {
  const st = String((m.metadata as Record<string, unknown> | null)?.status || "");
  return m.role === "tool" && (st === "running" || st === "awaiting_approval");
}) ? (
  <Text color="yellow">tool running — compose bloqueado hasta que termine el turn</Text>
) : null}
```

El compose ya hace `if (busy) return`. No quitar esa guarda. Navegación (Tab/flechas) sigue permitida mientras busy.

- [ ] `loadChat` debe conservar `metadata`: el API ya lo envía; TypeScript ahora lo tipa.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(tools): TUI timeline distinguishes tools and updates in-place"
```

---

## Task 7: Web — ToolCard, preview honesto, persistencia al recargar

**Files:**

- Create: `web/src/lib/tool-display.ts`
- Test: `web/src/lib/tool-display.test.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/package.json`

Web no ejecuta tools. Pinta el contrato. Un reload de `/chats/:id` relee `chat.get` (metadata intacta). El overview no muestra un assistant vacío si lo último fue una tool.

- [ ] Añadir `"test": "bun test"` en `web/package.json` scripts.

- [ ] Crear `web/src/lib/tool-display.ts` — **copia** de las funciones públicas de `cli/src/llm/tool-names.ts` + `cli/src/llm/tool-display.ts` que la UI necesita: `canonicalToolName`, `truncateToolText`, `summarizeToolInput`, `toolHeadline`, `TOOL_OUTPUT_MAX_CHARS`, `sanitizeToolInput`. Mantener los mismos números y el mismo summary. No importar `cli/`.

- [ ] Crear `web/src/lib/tool-display.test.ts` con los mismos casos de `summarizeToolInput` / `truncateToolText` / `toolHeadline` que Task 1 (al menos read path, grep query, truncado, headline running).

- [ ] En `web/src/styles/global.css`, junto a `.badge.err`:

```css
.badge.warn {
  color: #f0c36d;
  border-color: color-mix(in srgb, #f0c36d 40%, var(--border));
}
.badge.run {
  color: #8ec8ff;
  border-color: color-mix(in srgb, #8ec8ff 40%, var(--border));
}
.tool-card pre {
  max-height: 12rem;
  overflow: auto;
}
```

- [ ] En `web/src/lib/ws-hooks.ts`, añadir:

```ts
export function useWsToolResolve() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      toolCallId: string;
      decision: "approve" | "deny";
    }) =>
      ws.request({
        type:
          input.decision === "approve"
            ? "agent.tool.approve"
            : "agent.tool.deny",
        chatId: input.chatId,
        toolCallId: input.toolCallId,
      }),
  });
}
```

`web/src/lib/ws-client.ts` `WsRequest` ya tiene `toolCallId`. El `request()` del context en `ws-context.tsx` **no** pasa `toolCallId` en su tipo parcial. Ampliar ese tipo:

```ts
request: (partial: {
  type: string;
  path?: string;
  title?: string;
  sessionId?: string;
  chatId?: string;
  role?: string;
  content?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
  toolCallId?: string;
  status?: string;
}) => Promise<WsResponse>;
```

- [ ] Reemplazar `ToolCard` en `web/src/components/ChatDetailPanel.tsx`:

```tsx
import {
  summarizeToolInput,
  toolHeadline,
  truncateToolText,
} from "../lib/tool-display";
import { useWsToolResolve } from "../lib/ws-hooks";

function badgeClass(status: string): string {
  if (status === "done") return "ok";
  if (status === "error") return "err";
  if (status === "awaiting_approval") return "warn";
  if (status === "running") return "run";
  return "";
}

function ToolCard({ m, chatId }: { m: ChatMessage; chatId: string }) {
  const resolve = useWsToolResolve();
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const sdkName = String(meta.sdkName || meta.toolName || m.content || "tool");
  const status = String(meta.status || "running");
  const summary = summarizeToolInput(sdkName, meta.input);
  const output =
    meta.output != null
      ? truncateToolText(
          typeof meta.output === "string"
            ? meta.output
            : JSON.stringify(meta.output, null, 2),
        )
      : null;
  const toolCallId = String(meta.toolCallId || "");
  return (
    <div className="panel tool-card" style={{ marginBottom: "0.5rem" }}>
      <span className={`badge ${badgeClass(status)}`}>
        {toolHeadline(sdkName, status, meta.input)}
      </span>
      {summary && (
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
          in: {summary}
        </pre>
      )}
      {output != null && status !== "running" && status !== "awaiting_approval" && (
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
          out: {output}
        </pre>
      )}
      {status === "awaiting_approval" && toolCallId && (
        <p style={{ margin: "0.5rem 0 0" }}>
          <button
            type="button"
            disabled={resolve.isPending}
            onClick={() =>
              void resolve.mutateAsync({ chatId, toolCallId, decision: "approve" })
            }
          >
            Aprobar
          </button>{" "}
          <button
            type="button"
            className="secondary"
            disabled={resolve.isPending}
            onClick={() =>
              void resolve.mutateAsync({ chatId, toolCallId, decision: "deny" })
            }
          >
            Rechazar
          </button>
        </p>
      )}
    </div>
  );
}
```

Pasar `chatId` en el map: `<ToolCard key={m.id} m={m} chatId={chatId} />`.

- [ ] In-place: en el `onPush` de `ChatDetailInner`, cuando `message.appended` o `chat.tool.*` trae `data.message`:

```ts
const incoming = data.message;
if (incoming) {
  qc.setQueryData(
    queryKeys.chat(chatId),
    (prev: { chat: unknown; messages: ChatMessage[] } | undefined) => {
      if (!prev) return prev;
      const idx = prev.messages.findIndex((x) => x.id === incoming.id);
      if (idx >= 0) {
        const messages = prev.messages.slice();
        messages[idx] = incoming;
        return { ...prev, messages };
      }
      return { ...prev, messages: [...prev.messages, incoming] };
    },
  );
}
```

Seguir invalidando en `chat.stream.end` / error. **No** borrar las ToolCards al terminar el stream (el array `messages` de DB las conserva; `streamText` es un panel aparte `assistant · live`).

- [ ] El formulario append **no** incluye `role=tool` en el `<select>` (ya no lo tiene). Dejarlo así: append manual = user/assistant/system, nunca dispara tools.

- [ ] Errores de `agent.turn.request` (no daemon / busy / provider) ya caen en `formatQueryError`. Verificar que el `<p className="error">` los muestra. No crear un mensaje tool en el cache local si el mutate falla.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx`, `previewLabel`:

```ts
function previewLabel(m: ChatMessage): string {
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const sdkName = String(meta.sdkName || meta.toolName || m.content || "tool");
    const status = String(meta.status || "done");
    return toolHeadline(sdkName, status, meta.input);
  }
  const t = (m.content || "").replace(/\s+/g, " ").trim();
  if (!t) return m.role === "assistant" ? "assistant (vacío)" : m.role;
  return t.length <= 120 ? t : `${t.slice(0, 120)}…`;
}
```

El click ya es `<a href={/chats/${ch.id}}>`. Si `recentMessages` termina en tool, se ve `tool · write · done  NOTES.md`, no un assistant en blanco. Importar `toolHeadline` desde `../lib/tool-display`.

- [ ] Correr:

```bash
cd web && bun test src/lib/tool-display.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add web/src/lib/tool-display.ts web/src/lib/tool-display.test.ts \
  web/src/components/ChatDetailPanel.tsx web/src/components/WorkspaceDetailPanel.tsx \
  web/src/styles/global.css web/src/lib/ws-hooks.ts web/src/lib/ws-context.tsx \
  web/src/lib/ws-client.ts web/package.json
git commit -m "feat(tools): Web tool cards, in-place status, honest workspace preview"
```

---

## Task 8: Smokes de integración — persistencia, sync, guardas, append

**Files:**

- Create: `cli/scripts/tools-sync-smoke.ts`
- Modify: `cli/scripts/tui-sync-smoke.ts` (solo si el assert de dispatch sigue válido; no cambiar el happy path)

Sin LLM. El daemon de test **publica** `chat.tool.*` como lo haría `publishAgentTurn`, y un segundo cliente observa. Cubre Gherkin de visualización/persistencia/paridad de eventos y las guardas que no necesitan al modelo.

- [ ] Crear `cli/scripts/tools-sync-smoke.ts`:

```ts
/**
 * Smoke: tool start/result persist + fan-out; no-daemon; busy; append does not emit tools.
 * Requires API + token (CHAVEZ_ACCESS_TOKEN or ~/.chavez/config.json).
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import { formatWatchLine } from "../src/llm/watch-format";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const path = cwdPath();
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
await daemon.connect();
await web.connect();

const db = await daemon.bind(path, "daemon");
const wb = await web.bind(path, "client");
if (!db.ok || !wb.ok) throw new Error(`bind fail ${db.error} ${wb.error}`);

const session = await web.request({ type: "session.create", title: "tools-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "tools-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seen: string[] = [];
const gotThree = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout seen=${seen.join(",")}`)), 8000);
  web.onPush((msg) => {
    const data = msg.data as { chatId?: string; message?: { role?: string } };
    if (data?.chatId && data.chatId !== chatId) return;
    const line = formatWatchLine({ type: msg.type, data: msg.data });
    if (line) seen.push(line.split("\n")[0]!);
    if (
      seen.some((l) => l.includes("tool · read · running")) &&
      seen.some((l) => l.includes("tool · read · done")) &&
      seen.some((l) => l.startsWith("assistant:"))
    ) {
      clearTimeout(t);
      resolve();
    }
  });
});

const toolCallId = crypto.randomUUID();
const streamId = crypto.randomUUID();

const start = await daemon.request({
  type: "chat.tool.start",
  chatId,
  streamId,
  toolCallId,
  toolName: "read",
  content: "tool · read · running  README.md",
  metadata: {
    sdkName: "Read",
    input: { file_path: "README.md" },
    streamId,
  },
});
if (!start.ok) throw new Error(start.error);

const result = await daemon.request({
  type: "chat.tool.result",
  chatId,
  streamId,
  toolCallId,
  toolName: "read",
  status: "done",
  content: "# hello from workspace file",
});
if (!result.ok) throw new Error(result.error);

const end = await daemon.request({
  type: "chat.stream.start",
  chatId,
  streamId,
});
if (!end.ok) throw new Error(end.error);
await daemon.request({
  type: "chat.stream.end",
  chatId,
  streamId,
  content: "El README presenta el repo.",
});

await gotThree;

const got = await web.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const messages = (got.data as { messages: Array<{ role: string; metadata?: Record<string, unknown> | null; content: string }> }).messages;
const tools = messages.filter((m) => m.role === "tool");
if (tools.length !== 1) throw new Error(`expected 1 tool row, got ${tools.length}`);
if (tools[0]!.metadata?.status !== "done") throw new Error("tool not done after reload payload");
if (tools[0]!.metadata?.toolName !== "read") throw new Error("canonical name missing");
if (!String(tools[0]!.metadata?.output || tools[0]!.content).includes("hello from workspace")) {
  throw new Error("tool output missing");
}
const last = messages[messages.length - 1]!;
if (last.role !== "assistant") throw new Error("assistant should follow tools");
console.log("persist sequence OK", messages.map((m) => m.role).join(" → "));

const awaitingId = crypto.randomUUID();
const updStart = await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId: awaitingId,
  toolName: "write",
  content: "tool · write · running  NOTES.md",
  metadata: { sdkName: "Write", input: { file_path: "NOTES.md" } },
});
if (!updStart.ok) throw new Error(updStart.error);
const upd = await daemon.request({
  type: "chat.tool.update",
  chatId,
  toolCallId: awaitingId,
  status: "awaiting_approval",
});
if (!upd.ok) throw new Error(upd.error);
const mid = await web.request({ type: "chat.get", chatId });
const awaiting = (mid.data as { messages: Array<{ metadata?: Record<string, unknown> | null }> }).messages.find(
  (m) => m.metadata?.toolCallId === awaitingId,
);
if (awaiting?.metadata?.status !== "awaiting_approval") {
  throw new Error("awaiting_approval not persisted");
}
console.log("awaiting_approval OK");

const huge = "H".repeat(20_000);
const grepId = crypto.randomUUID();
await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId: grepId,
  toolName: "grep",
  metadata: { sdkName: "Grep", input: { pattern: "device code" } },
});
await daemon.request({
  type: "chat.tool.result",
  chatId,
  toolCallId: grepId,
  toolName: "grep",
  status: "done",
  content: huge,
});
const afterHuge = await web.request({ type: "chat.get", chatId });
const grepRow = (afterHuge.data as { messages: Array<{ metadata?: Record<string, unknown> | null; content: string }> }).messages.find(
  (m) => m.metadata?.toolCallId === grepId,
);
if (!grepRow) throw new Error("grep row missing");
if (grepRow.content.length >= 20_000) throw new Error("output was not truncated at API");
if (!grepRow.content.includes("[truncated:")) throw new Error("truncation marker missing");
console.log("truncate OK", grepRow.content.length);

const append = await web.request({
  type: "chat.append",
  chatId,
  role: "user",
  content: "nota humana, no tools",
});
if (!append.ok) throw new Error(append.error);
const afterAppend = await web.request({ type: "chat.get", chatId });
const roles = (afterAppend.data as { messages: Array<{ role: string; content: string }> }).messages;
const lastMsg = roles[roles.length - 1]!;
if (lastMsg.role !== "user" || lastMsg.content !== "nota humana, no tools") {
  throw new Error("append should be user, not a tool");
}
console.log("append does not emit tools OK");

const failId = crypto.randomUUID();
const failStream = crypto.randomUUID();
await daemon.request({
  type: "chat.tool.start",
  chatId,
  streamId: failStream,
  toolCallId: failId,
  toolName: "bash",
  metadata: { sdkName: "Bash", input: { command: "false" }, streamId: failStream },
});
await daemon.request({
  type: "chat.stream.error",
  chatId,
  streamId: failStream,
  content: "provider cut",
});
const afterFail = await web.request({ type: "chat.get", chatId });
const failed = (afterFail.data as { messages: Array<{ metadata?: Record<string, unknown> | null }> }).messages.find(
  (m) => m.metadata?.toolCallId === failId,
);
if (failed?.metadata?.status !== "error") {
  throw new Error("running tool should fail when stream errors");
}
console.log("fail in-flight OK");

daemon.close();
web.close();

const orphan = new ChavezWsClient(token);
await orphan.connect();
await orphan.bind(path, "client");
const noDaemon = await orphan.request({
  type: "agent.turn.request",
  chatId,
  prompt: "lee el README",
});
if (noDaemon.ok) throw new Error("expected no-daemon fail");
if (noDaemon.error !== "No daemon bound for this workspace. Run: chavez headless workspace open") {
  throw new Error(`unexpected no-daemon error: ${noDaemon.error}`);
}
const afterNo = await orphan.request({ type: "chat.get", chatId });
const extraTools = (afterNo.data as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === "tool");
if (extraTools.length !== 3) {
  throw new Error(`no-daemon must not create tool rows, got ${extraTools.length}`);
}
orphan.close();
console.log("no daemon OK");

console.log("TOOLS SMOKE PASS");
```

El conteo `extraTools.length !== 3` asume las tres tools del script (read, write awaiting, grep). El bash in-flight también es tool (4). Ajustar a **4** (read, write, grep, bash failed). Usar `4` en el assert.

- [ ] Correr con API arriba y sesión CLI:

```bash
cd cli && bun run scripts/tools-sync-smoke.ts
```

Esperado: imprime `TOOLS SMOKE PASS`. Si no hay token, el script sale 1 con `Need login` — no fingir éxito.

- [ ] Unit suite completa de esta fase:

```bash
cd cli && bun test src/llm
cd api && bun test src/ws/tool-protocol.test.ts
cd web && bun test src/lib/tool-display.test.ts
```

Esperado: 0 fallos.

- [ ] Commit:

```bash
git add cli/scripts/tools-sync-smoke.ts
git commit -m "test(tools): persist, truncate, fail in-flight, no-daemon, append smoke"
```

---

## Orden de ejecución

1. Task 1 (módulos puros) — no depende de API.
2. Task 2 (API) — no depende del runner.
3. Task 3 (runner) — depende de Task 1.
4. Task 4 (daemon/TUI busy) — depende de Task 2–3.
5. Task 5 (watch) — depende de Task 1; se puede paralelizar con 3.
6. Task 6 (TUI UI) — depende de Task 1 y 3.
7. Task 7 (Web) — depende de Task 2.
8. Task 8 (smoke) — después de 2 y 3 como mínimo; idealmente al final.

Tasks 5, 6 y 7 son paralelizables entre sí una vez 1–3 están mergeadas.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Usuario no configura tools | Task 3 `tools`/`allowedTools` fijos |
| Read / grep / write / edit / glob / bash | Task 3 SDK + Task 1 names; write/edit/bash corren (auto) |
| Varias tools en orden + assistant después | Task 2 persistencia + Task 8 smoke secuencia |
| `@` y tools conviven | Attach (plan 1) hidrata antes de `runClaudeTurn`; este plan no quita tools |
| Inicio running + input sin secretos | Task 1 redact + Task 3 start metadata + Task 5/6/7 |
| Resultado done, no desaparece | Task 2 update in-place + Task 6/7 no borran al `stream.end` |
| `awaiting_approval` visible, approve/deny | Task 2 `chat.tool.update` + `agent.tool.approve/deny`; Task 7 botones; waiter = plan 3 |
| Tool error, el chat sigue | Task 3 `is_error` → `error`; Task 2 fail-in-flight; Task 8 |
| CLI watch orden + deltas | Task 5 |
| TUI distingue roles, in-place, busy | Task 6 |
| Web tarjeta + badge + reload | Task 7 + Task 8 `chat.get` |
| Preview workspace no miente | Task 7 `previewLabel` |
| Persistencia 3 tools + assistant | Task 8 |
| Ejecutor = daemon, no API | Task 3 `cwd` + Constraint 1 |
| Path traversal | Task 1 sandbox + Task 3 `canUseTool` deny |
| Turn concurrente visible | Task 2 `TURN_BUSY_ERROR` + Task 4 |
| Sin daemon | Task 2 `NO_DAEMON_ERROR` + Task 8 (0 tools nuevas) |
| Provider no ejecutable | Task 3 error existente, no tools |
| Fallo a mitad de stream | Task 2 `failRunningTools` + Task 3 inFlight + Task 8 |
| Output enorme | Task 1/2 truncado + Task 5/7 cap de render + Task 8 |
| Turn TUI / Web / CLI ask misma semántica | Mismo `publishAgentTurn` + mismo broadcast |
| Append no dispara tools | Task 2 `chat.append` intacto + Task 8 |

## Fuera de este plan (no implementar)

- Modo `plan` / `auto` / `ask` persistido y gating write/edit/bash → [execution-modes](../execution-modes/plan.md).
- Timeout, headless que espera, “ya resuelto” → [approvals](../approvals/plan.md).
- Cursor ejecutable + mismos eventos de tool → [cursor-provider](../cursor-provider/plan.md).
- Cola en vez de fail busy → [turn-queue](../turn-queue/plan.md).
- Bash sin red / FS bash estricto → [sandbox-network](../sandbox-network/plan.md).
- Grep que salta secrets/ignore → [ignore-secrets](../ignore-secrets/plan.md).
- Diff por turn → [diffs-review](../diffs-review/plan.md).
