# PTY Terminal Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, JSON schema de CI, GitHub Action, cola de turns (plan 29), worktrees paralelos, ni “siempre permitir”. Spec: [`plan.md`](./plan.md). Bash one-shot sigue siendo el default ([`agent-tools`](../agent-tools/implementation.md)). PTY es **opt-in**. Depende de modos ([`execution-modes`](../execution-modes/implementation.md)), aprobaciones ([`approvals`](../approvals/implementation.md)), CI ([`ci-headless`](../ci-headless/implementation.md)), redacción ([`ignore-secrets`](../ignore-secrets/implementation.md) / [`invariants`](../invariants/implementation.md)) y hostname del daemon ([`attach-files`](../attach-files/implementation.md) / [`daemon-reconnect`](../daemon-reconnect/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario abre un terminal interactivo en TUI o Web que corre en el **cwd del daemon** (hostname · path visibles). El agente **no** secuestra ese PTY: un turn sigue usando Bash one-shot. Si el modelo pide un PTY, en `ask` se aprueba **una a una**; en `auto` se rechaza (no hay humano para el pager); en CI el PTY **no está**. Al cerrar Web/TUI el proceso termina: **cero huérfanos** sin política.

**Architecture:** El PTY vive **solo** en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** abre `/dev/ptmx`, no spawnea `bash -i` y no retiene file descriptors: reenvía `pty.open` / `pty.input` / `pty.resize` / `pty.close` al daemon bound, hace fan-out de `pty.data` **solo al owner**, y en `onClose` pide `pty.kill`. El browser pinta xterm; no lee el disco. CLI `watch` ve el tool `pty` del agente (snapshot redactado), **no** cada tecla del terminal de usuario.

```
TUI tecla t | Web botón Terminal
        |
        v
  pty.open  --WS-->  API hub.findDaemon
        |                 | no daemon → NO_DAEMON_ERROR
        |                 | CI / non-interactive → PTY_DENIED_CI
        v                 v
  daemon PtyManager.open({ kind: "user", cwd: effectiveCwd, ownerConnectionId })
        |  posix_openpt + bash -i  (TERM=xterm-256color; env sin vault)
        |  hostname · cwd en el header
        v
  pty.data  (base64, solo owner)  →  xterm | TUI raw
  pty.input / pty.resize          →  master fd
        |
        +-- owner onClose | unmount | ctrl+x | idle 30min
        |     PtyManager.kill(pgid SIGTERM → SIGKILL)
        |     transcript redact+truncate → persist si hay chatId
        v
Turn (otro camino, nunca el fd del user PTY)
  query({ tools: DEFAULT_CLAUDE_TOOLS = Bash one-shot })
  Bash  → spawn sin TTY, stdout capturado
  mcp__chavez-pty__pty
        auto → deny PTY_DENIED_AUTO   (no spawn)
        plan → deny PTY_DENIED_PLAN
        CI   → tool ausente + deny PTY_DENIED_CI
        ask  → awaiting_approval { kind: "pty", command }
               approve → PTY kind:"agent" + panel attach
               deny    → no spawn
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y `permissionMode: "bypassPermissions"` **hoy**. Planes 2–3 lo pasan a `"default"` + `canUseTool`. **No** volver a `bypassPermissions`. **No** hay tool Pty. El Bash del SDK es one-shot (sin TTY).
- `cli/src/ws/daemon.ts` solo atiende `agent.turn.dispatch`. Spawn del daemon: `stdin: "ignore"`, `proc.unref()` en `workspaceOpen` — el **hijo PTY no puede unref**. Shutdown SIGINT/SIGTERM cierra el WS y `process.exit(0)` **sin** matar un process group de PTY (esta fase lo añade).
- `tui/src/App.tsx` es daemon (`bind(..., "daemon")`). Header `cwd: {cwd}`. Tecla `t` no existe. Escape/`q` cierran la TUI. `useInput` se come stdin: un PTY local exige modo `"pty"` que **deja de interceptar** teclas y las escribe al master.
- `api/src/ws/handlers.ts` despacha `agent.turn.request`. **No** hay `pty.*`. `api/src/index.ts` `onClose` solo `hub.remove(connectionId)` — nadie mata un PTY al cerrar Web.
- `api/src/ws/hub.ts`: `findDaemon` por `clientKind === "daemon"`. Hostname lo añaden attach-files / daemon-reconnect; si ya está, reusar. Esta fase **añade** el registro `ptyId → ownerConnectionId` (módulo nuevo; no inflar `HubConnection` con fds).
- Web `ChatDetailPanel.tsx` / `WorkspaceDetailPanel.tsx`: sin terminal. `web/package.json` no tiene xterm. Esta fase añade `@xterm/xterm` + `@xterm/addon-fit` **solo en web** (un TTY real no se pinta con `<pre>`).
- `cli/package.json` **no** añade `node-pty` (node-gyp vs bun). Backend = `bun:ffi` a libc (`posix_openpt`) + `node:child_process.spawn` con stdio = slave fd.
- Persistencia: `chat_messages.metadata` jsonb **ya existe**. **Sin** tabla `pty_sessions`. **Sin** migración. El PTY en vuelo es memoria del daemon.
- CI (plan 25): `chavez ci` / `isNonInteractive`. Esta fase **no** abre PTY ahí: tool ausente + RPC `pty.open` → `PTY_DENIED_CI`.
- Cursor `runnable: false` hasta plan 4. No mapear Cursor Shell a PTY. Si el runner del plan 4 existe, el mismo `gatePty` deniega en auto/plan/CI; no simular un TTY Cursor.
- Ignore/secrets (plan 8) y redact (plan 5) aplican a **lo persistido** (cierre / tool result). El TTY en vivo es el shell del usuario en su máquina: no se bloquea `cat .env` en el terminal propio; **sí** se redacta si se guarda.

**Tech Stack:** Bun (`bun:ffi` libc, `node:child_process.spawn`, **no** `unref` del hijo PTY), Hono WebSocket hub, `createPendingMap` (`api/src/ws/pending.ts` de attach-files; crearlo si falta), Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva), Claude Agent SDK `query` + `createSdkMcpServer` + `tool` (`permissionMode: "default"`, `canUseTool`, `permissionPrompts: "host"`), Ink TUI (modo `"pty"`), Astro/React web + `@xterm/xterm` + `@xterm/addon-fit`. Tests: `bun test`. Web y API **no** importan CLI: duplicar constantes (comentario keep-in-sync). TUI importa `cli/src/pty/…`.

**Global Constraints:**

1. El filesystem y el PTY viven **solo** en el daemon (cwd efectivo del workspace). API y browser no abren `/dev/ptmx`, no `spawn` bash, no leen slave fds. Cero `fs.openSync("/dev/ptmx")` en `api/` y `web/`.
2. Sin daemon bound, `pty.open` / `pty.input` / `pty.resize` / `pty.close` / `agent.turn.request` fallan con **el mismo** `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Bash one-shot **sigue** siendo el default. `DEFAULT_CLAUDE_TOOLS` **no** sustituye `Bash` por `Pty`. Un turn **nunca** escribe en el master fd de un PTY `kind: "user"`.
4. PTY de usuario es **opt-in** (TUI `t`, Web botón). Máximo `PTY_MAX_SESSIONS` (4) por daemon. Un owner = sus sesiones; `pty.data` **no** se hace broadcast a todos los sockets del user (el transcript crudo no va a `chat watch`).
5. Si el modelo pide PTY (`mcp__chavez-pty__pty`): `ask` → `awaiting_approval` una a una; `auto` → `PTY_DENIED_AUTO` **sin spawn**; `plan` → `PTY_DENIED_PLAN` **sin spawn**; CI → tool **no** está en `mcpServers` y cualquier llamada residual deniega `PTY_DENIED_CI`.
6. Aprobaciones **una a una**. Sin lote, sin “siempre permitir”. El pager necesita un humano: por eso auto no corre PTY.
7. Cerrar el owner (Web unmount / `beforeunload` / WS `onClose`; TUI `ctrl+x` o salir de la app) **mata** el process group (`SIGTERM` + `SIGKILL` a los `PTY_KILL_GRACE_MS`). Idle `PTY_IDLE_MS`. Shutdown del daemon llama `killAll`. `detached: false`. Nunca `unref()` el hijo. Política de huérfanos: **kill on owner gone**.
8. Hostname · path (cwd efectivo si el plan 28 ya existe, si no el bind path) se muestran en TUI y Web **antes** de escribir. Multi-host: no adjuntar el TTY del daemon equivocado.
9. Lo **persistido** (snapshot al cerrar, tool result del agente) pasa por redact/ignore (`redactSecrets` / `redactText` / `sanitizeToolOutput` si existen) y se trunca a `PTY_TRANSCRIPT_MAX_CHARS`. Vault (`CHAVEZ_ACCESS_TOKEN`, OAuth, API keys) **no** entra en el env del PTY (`PTY_STRIP_ENV`).
10. 1 turn por daemon. Un PTY de usuario **no** marca `turnBusy`. Un PTY de agente corre **dentro** del turn ya busy. User PTY y Bash one-shot coexisten.
11. Lecturas (Read/Grep/Glob) no piden PTY ni confirmación. Write/edit/bash one-shot siguen el modo. PTY es clase **write** para el gate.
12. Claude es el ejecutable. Cursor vinculado no gana un TTY en esta fase.
13. Web, TUI y `chat watch` ven el mismo **tool · pty · status** del agente. El stream de teclas del user PTY es owner-only.
14. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, multiplexor tmux de producto, PTY en Windows (fail `PTY_UNSUPPORTED`), share del TTY entre dos browsers.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` (reusar literal) |
| `PTY_DENIED_AUTO` | `"PTY denied in auto mode: no human for the pager. Switch to ask."` |
| `PTY_DENIED_PLAN` | `"Plan mode: PTY is disabled. Switch to ask to run interactive commands."` |
| `PTY_DENIED_CI` | `"PTY is not available in CI / non-interactive mode."` |
| `PTY_DENIED_ASK` | `"User denied this PTY"` |
| `PTY_UNSUPPORTED` | `"PTY is not supported on this platform."` |
| `PTY_BUSY` | `"Too many PTY sessions on this daemon"` |
| `PTY_NOT_FOUND` | `"PTY session not found"` |
| `PTY_OWNER_GONE` | `"PTY closed: owner disconnected"` |
| `PTY_IDLE_CLOSED` | `"PTY closed: idle timeout"` |
| `PTY_MAX_SESSIONS` | `4` |
| `PTY_IDLE_MS` | `1_800_000` |
| `PTY_IDLE_SWEEP_MS` | `30_000` |
| `PTY_KILL_GRACE_MS` | `1_500` |
| `PTY_CHUNK_MAX_BYTES` | `32_768` |
| `PTY_TRANSCRIPT_MAX_CHARS` | `8000` (igual que `TOOL_OUTPUT_MAX_CHARS` si existe; no subir) |
| `PTY_AGENT_TIMEOUT_MS` | `600_000` |
| `PTY_OPEN_TIMEOUT_MS` | `10_000` |
| `PTY_DEFAULT_COLS` | `80` |
| `PTY_DEFAULT_ROWS` | `24` |
| `PTY_MCP_SERVER` | `"chavez-pty"` |
| `PTY_MCP_TOOL` | `"pty"` |
| `PTY_CANONICAL` | `"pty"` |
| `PTY_TUI_CLOSE_HINT` | `"ctrl+x cierra el PTY (no q: q va al shell)"` |
| `PTY_PREAMBLE` | `"Prefer the Bash tool for one-shot commands (no TTY). Use Pty only when a command requires an interactive TTY (pagers, REPLs, editors). Pty is denied in auto and in CI."` |
| `ASK_DENIED` | reusar plan 3 si existe; deny de PTY en ask usa `PTY_DENIED_ASK` |
| `PLAN_MUTATION_DENIED` | reusar plan 3 para write/bash; PTY en plan usa `PTY_DENIED_PLAN` (mensaje específico del pager) |

Tipos (congelados):

```ts
export type PtyKind = "user" | "agent";
export type PtyStatus = "starting" | "open" | "exited" | "killed";

export type PtyOpenInput = {
  kind: PtyKind;
  ownerConnectionId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  command?: string; // agent: bash -lc command; user: omit → $SHELL -i
  chatId?: string;
  toolCallId?: string;
  workspaceId?: string;
};

export type PtyOpenResult = {
  ptyId: string;
  pid: number;
  hostname: string;
  cwd: string;
  cols: number;
  rows: number;
  kind: PtyKind;
  shell: string;
};

export type PtyGateDecision =
  | { action: "allow" }
  | { action: "deny"; message: string }
  | { action: "ask" };
```

Nombres WS (nuevos; ninguno reutiliza `chat.stream.*`):

| Tipo | Dirección | Semántica |
|---|---|---|
| `pty.open` | client → API | Abre user PTY. Pending correlacionado. |
| `pty.open.dispatch` | API → daemon | `{ requestId, ownerConnectionId, cols, rows, chatId, cwd }` |
| `pty.open.result` | daemon → API | Completa el pending. `{ ptyId, hostname, cwd, pid, cols, rows }` |
| `pty.input` | client → API → daemon | `{ ptyId, chunk }` base64. Solo owner. |
| `pty.resize` | client → API → daemon | `{ ptyId, cols, rows }` |
| `pty.close` | client → API → daemon | Owner pide kill. |
| `pty.kill.dispatch` | API → daemon | Owner gone / idle pedido por hub. |
| `pty.data` | daemon → API → **owner** | `{ ptyId, chunk, encoding: "base64" }` — `hub.sendTo(owner)`, no `broadcastToUser` |
| `pty.exit` | daemon → API → owner | `{ ptyId, exitCode, reason }` + persist snapshot si `chatId` |
| `pty.attach` | API → owner (agent) | Tras approve: el panel Web/TUI se engancha a ese `ptyId` |

HTTP: ninguno nuevo. Cero migración.

---

## Task 1: Módulos puros — constantes, gate, redact, env strip

**Files:**

- Create: `cli/src/pty/constants.ts`
- Create: `cli/src/pty/types.ts`
- Create: `cli/src/pty/gate.ts`
- Create: `cli/src/pty/redact.ts`
- Create: `cli/src/pty/env.ts`
- Test: `cli/src/pty/gate.test.ts`
- Test: `cli/src/pty/redact.test.ts`
- Test: `cli/src/pty/env.test.ts`
- Create: `api/src/pty/constants.ts`
- Test: `api/src/pty/constants.test.ts`
- Create: `web/src/lib/pty-constants.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`

Sin I/O de PTY, sin spawn. TUI importa `cli/src/pty/…`. Web y API **no** importan CLI.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` y `api/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`db:*`/`test:e2e` intactos).

- [ ] Crear `cli/src/pty/constants.ts`:

```ts
/** keep-in-sync: api/src/pty/constants.ts web/src/lib/pty-constants.ts */

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const PTY_DENIED_AUTO =
  "PTY denied in auto mode: no human for the pager. Switch to ask.";
export const PTY_DENIED_PLAN =
  "Plan mode: PTY is disabled. Switch to ask to run interactive commands.";
export const PTY_DENIED_CI =
  "PTY is not available in CI / non-interactive mode.";
export const PTY_DENIED_ASK = "User denied this PTY";
export const PTY_UNSUPPORTED = "PTY is not supported on this platform.";
export const PTY_BUSY = "Too many PTY sessions on this daemon";
export const PTY_NOT_FOUND = "PTY session not found";
export const PTY_OWNER_GONE = "PTY closed: owner disconnected";
export const PTY_IDLE_CLOSED = "PTY closed: idle timeout";

export const PTY_MAX_SESSIONS = 4;
export const PTY_IDLE_MS = 1_800_000;
export const PTY_IDLE_SWEEP_MS = 30_000;
export const PTY_KILL_GRACE_MS = 1_500;
export const PTY_CHUNK_MAX_BYTES = 32_768;
export const PTY_TRANSCRIPT_MAX_CHARS = 8000;
export const PTY_AGENT_TIMEOUT_MS = 600_000;
export const PTY_OPEN_TIMEOUT_MS = 10_000;
export const PTY_DEFAULT_COLS = 80;
export const PTY_DEFAULT_ROWS = 24;

export const PTY_MCP_SERVER = "chavez-pty";
export const PTY_MCP_TOOL = "pty";
export const PTY_CANONICAL = "pty";
export const PTY_MCP_FULL = `mcp__${PTY_MCP_SERVER}__${PTY_MCP_TOOL}`;

export const PTY_PREAMBLE =
  "Prefer the Bash tool for one-shot commands (no TTY). Use Pty only when a command requires an interactive TTY (pagers, REPLs, editors). Pty is denied in auto and in CI.";

export const PTY_TUI_CLOSE_HINT =
  "ctrl+x cierra el PTY (no q: q va al shell)";

export const PTY_STRIP_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY",
  "CHAVEZ_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;
```

Si `NO_DAEMON_ERROR` ya vive en `cli/src/ws/presence-constants.ts` / `cli/src/llm/tool-names.ts`, **reexportar** ese literal; no duplicar un string distinto.

- [ ] Crear `api/src/pty/constants.ts` con el mismo `keep-in-sync` y **solo** lo que la API necesita: `NO_DAEMON_ERROR`, `PTY_DENIED_CI`, `PTY_NOT_FOUND`, `PTY_BUSY`, `PTY_OPEN_TIMEOUT_MS`, `PTY_CANONICAL`.

- [ ] Crear `web/src/lib/pty-constants.ts` con `PTY_CANONICAL`, `PTY_DEFAULT_COLS`, `PTY_DEFAULT_ROWS`, `PTY_TUI_CLOSE_HINT` (el hint Web: `"Cerrar terminal mata el proceso en el daemon"`), `NO_DAEMON_ERROR`.

- [ ] Test `api/src/pty/constants.test.ts`: el string `PTY_DENIED_CI` coincide con el de CLI (importar ambos y `expect(api).toBe(cli)` **no** — API no importa CLI). Duplicar el literal esperado:

```ts
import { describe, expect, test } from "bun:test";
import { PTY_DENIED_CI, NO_DAEMON_ERROR } from "./constants";

describe("pty api constants", () => {
  test("frozen strings", () => {
    expect(PTY_DENIED_CI).toBe(
      "PTY is not available in CI / non-interactive mode.",
    );
    expect(NO_DAEMON_ERROR).toMatch(/No daemon bound/);
  });
});
```

- [ ] Crear `cli/src/pty/types.ts` con los tipos de la sección Constantes (`PtyKind`, `PtyStatus`, `PtyOpenInput`, `PtyOpenResult`, `PtyGateDecision`).

- [ ] Crear `cli/src/pty/gate.ts`:

```ts
import type { ExecutionMode } from "../llm/execution-mode";
import {
  PTY_DENIED_AUTO,
  PTY_DENIED_CI,
  PTY_DENIED_PLAN,
  PTY_MCP_FULL,
} from "./constants";
import type { PtyGateDecision } from "./types";

export const PTY_SDK_TOOLS = new Set([
  "Pty",
  "pty",
  PTY_MCP_FULL,
  "mcp__chavez-pty__pty",
]);

export function isPtyTool(sdkName: string): boolean {
  return PTY_SDK_TOOLS.has(sdkName) || sdkName.toLowerCase().endsWith("__pty");
}

/** Bash one-shot is never a PTY. */
export function isBashOneShot(sdkName: string): boolean {
  return sdkName === "Bash" || sdkName === "bash" || sdkName === "Shell" || sdkName === "shell";
}

export function gatePty(input: {
  mode: ExecutionMode | string | null | undefined;
  ci?: boolean;
}): PtyGateDecision {
  if (input.ci) return { action: "deny", message: PTY_DENIED_CI };
  const mode = input.mode || "ask";
  if (mode === "auto") return { action: "deny", message: PTY_DENIED_AUTO };
  if (mode === "plan") return { action: "deny", message: PTY_DENIED_PLAN };
  if (mode === "ask") return { action: "ask" };
  return { action: "deny", message: PTY_DENIED_AUTO };
}
```

Si `cli/src/llm/execution-mode.ts` **no** existe todavía, declarar localmente `type ExecutionMode = "plan" | "auto" | "ask"` en `gate.ts` y no inventar un cuarto modo.

- [ ] Crear `cli/src/pty/gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PTY_DENIED_AUTO, PTY_DENIED_CI, PTY_DENIED_PLAN } from "./constants";
import { gatePty, isBashOneShot, isPtyTool } from "./gate";

describe("gatePty", () => {
  test("auto denies without spawn", () => {
    expect(gatePty({ mode: "auto" })).toEqual({
      action: "deny",
      message: PTY_DENIED_AUTO,
    });
  });
  test("plan denies", () => {
    expect(gatePty({ mode: "plan" }).message).toBe(PTY_DENIED_PLAN);
  });
  test("ask asks", () => {
    expect(gatePty({ mode: "ask" })).toEqual({ action: "ask" });
  });
  test("CI denies even in ask", () => {
    expect(gatePty({ mode: "ask", ci: true })).toEqual({
      action: "deny",
      message: PTY_DENIED_CI,
    });
  });
});

describe("tool class", () => {
  test("Bash is one-shot, not pty", () => {
    expect(isBashOneShot("Bash")).toBe(true);
    expect(isPtyTool("Bash")).toBe(false);
    expect(isPtyTool("mcp__chavez-pty__pty")).toBe(true);
  });
});
```

- [ ] Crear `cli/src/pty/redact.ts`. Si `cli/src/llm/tool-display.ts` exporta `redactSecrets` y `truncateToolText`, **delegar**. Si `cli/src/llm/redact.ts` exporta `redactText`, usarlo **después**. Si no existen, implementar el mínimo (mismos patrones `sk-ant-`, `ghp_`, `xox`, keys `api_key`/`token`/`password`):

```ts
import { PTY_TRANSCRIPT_MAX_CHARS } from "./constants";

const SECRET_VALUE_RE =
  /sk-ant-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|CHAVEZ_ACCESS_TOKEN=.+/g;

export function persistPtyTranscript(raw: string, max = PTY_TRANSCRIPT_MAX_CHARS): string {
  let text = raw.replace(SECRET_VALUE_RE, "***");
  try {
    const display = require("../llm/tool-display") as {
      redactSecrets?: (s: string) => string;
      truncateToolText?: (s: string, n?: number) => string;
    };
    if (typeof display.redactSecrets === "function") text = display.redactSecrets(text);
    if (typeof display.truncateToolText === "function") {
      return display.truncateToolText(text, max);
    }
  } catch {
    // tool-display not present yet
  }
  try {
    const inv = require("../llm/redact") as { redactText?: (s: string) => string };
    if (typeof inv.redactText === "function") text = inv.redactText(text);
  } catch {
    // optional
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}
```

No usar `require` dinámico si los módulos **ya** existen: en ese caso, `import { redactSecrets, truncateToolText } from "../llm/tool-display"` directo. El `try/require` es **solo** el fallback cuando este plan aterriza antes que agent-tools/invariants.

Preferir imports estáticos:

```ts
import { redactSecrets, truncateToolText } from "../llm/tool-display";
```

Si el archivo no existe, **crear** un `redactSecrets` local de 10 líneas (patrones de arriba) y un `truncatePtyText`. No dejar el persist sin redacción.

- [ ] Test `cli/src/pty/redact.test.ts`: `sk-ant-abc` y `ghp_abc` salen `***`; un dump de 9000 chars queda ≤ `PTY_TRANSCRIPT_MAX_CHARS` + marca `[truncated:`.

- [ ] Crear `cli/src/pty/env.ts`:

```ts
import { PTY_STRIP_ENV } from "./constants";

export function sanitizePtyEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = new Set(PTY_STRIP_ENV.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (strip.has(k.toLowerCase())) continue;
    if (/^(api[_-]?key|secret|password|authorization)$/i.test(k)) continue;
    out[k] = v;
  }
  out.TERM = out.TERM || "xterm-256color";
  out.COLORTERM = out.COLORTERM || "truecolor";
  return out;
}
```

- [ ] Test `cli/src/pty/env.test.ts`: `CHAVEZ_ACCESS_TOKEN` y `ANTHROPIC_API_KEY` **no** están en el resultado; `PATH` y `HOME` sí; `TERM` es `xterm-256color` si faltaba.

- [ ] Correr:

```bash
cd cli && bun test src/pty/gate.test.ts src/pty/redact.test.ts src/pty/env.test.ts
cd api && bun test src/pty/constants.test.ts
```

- [ ] Commit:

```bash
git add cli/src/pty/constants.ts cli/src/pty/types.ts cli/src/pty/gate.ts \
  cli/src/pty/redact.ts cli/src/pty/env.ts \
  cli/src/pty/gate.test.ts cli/src/pty/redact.test.ts cli/src/pty/env.test.ts \
  api/src/pty/constants.ts api/src/pty/constants.test.ts \
  web/src/lib/pty-constants.ts cli/package.json api/package.json
git commit -m "feat(pty): constants, mode/CI gate, persist redact, env strip"
```

---

## Task 2: Backend nativo — openpty, spawn, resize, kill process group

**Files:**

- Create: `cli/src/pty/backend.ts`
- Create: `cli/src/pty/native.ts`
- Create: `cli/src/pty/fake-backend.ts`
- Test: `cli/src/pty/native.test.ts`
- Test: `cli/src/pty/fake-backend.test.ts`

Sin WS. El backend real usa libc; los tests de política usan `FakePtyBackend`. Windows → throw `PTY_UNSUPPORTED` al `spawn`.

- [ ] Crear `cli/src/pty/backend.ts`:

```ts
export type PtyChild = {
  pid: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onExit(cb: (info: { exitCode: number | null; signal: string | null }) => void): () => void;
};

export type PtyBackend = {
  spawn(input: {
    cwd: string;
    env: Record<string, string>;
    file: string;
    args: string[];
    cols: number;
    rows: number;
  }): PtyChild;
};
```

Contrato: `kill` envía la señal al **process group** (`-pid`), no solo al pid. `spawn` **no** llama `unref()`. `detached: false`.

- [ ] Crear `cli/src/pty/fake-backend.ts` para tests:

```ts
import type { PtyBackend, PtyChild } from "./backend";

export type FakePtyChild = PtyChild & {
  writes: Uint8Array[];
  killed: Array<NodeJS.Signals | undefined>;
  unrefCalled: boolean;
  emitData(s: string | Uint8Array): void;
  emitExit(exitCode: number | null, signal?: string | null): void;
};

export function createFakeBackend(): PtyBackend & { children: FakePtyChild[] } {
  const children: FakePtyChild[] = [];
  return {
    children,
    spawn(input) {
      const dataCbs: Array<(c: Uint8Array) => void> = [];
      const exitCbs: Array<(i: { exitCode: number | null; signal: string | null }) => void> = [];
      const child: FakePtyChild = {
        pid: 40000 + children.length,
        writes: [],
        killed: [],
        unrefCalled: false,
        write(data) {
          this.writes.push(data);
        },
        resize() {},
        kill(signal) {
          this.killed.push(signal);
        },
        onData(cb) {
          dataCbs.push(cb);
          return () => {};
        },
        onExit(cb) {
          exitCbs.push(cb);
          return () => {};
        },
        emitData(s) {
          const buf = typeof s === "string" ? new TextEncoder().encode(s) : s;
          for (const cb of dataCbs) cb(buf);
        },
        emitExit(exitCode, signal = null) {
          for (const cb of exitCbs) cb({ exitCode, signal });
        },
      };
      children.push(child);
      void input;
      return child;
    },
  };
}
```

- [ ] Test `cli/src/pty/fake-backend.test.ts`: `write` acumula; `emitData` llega a `onData`; `kill("SIGTERM")` queda en `killed`; `unrefCalled` es `false`.

- [ ] Crear `cli/src/pty/native.ts`. Plataforma `win32` → `spawn` throws `new Error(PTY_UNSUPPORTED)`. En linux/darwin:

  1. `bun:ffi` `dlopen` (`libc.so.6` en linux, `libSystem.B.dylib` en darwin) con `posix_openpt`, `grantpt`, `unlockpt`, `ptsname` (o `ptsname_r`), `ioctl`, `close`, `fcntl`.
  2. Master: `posix_openpt(O_RDWR | O_NOCTTY)` → `grantpt` → `unlockpt` → `ptsname`.
  3. Slave: `fs.openSync(slavePath, "r+")`.
  4. `ioctl(masterFd, TIOCSWINSZ, winsize)` — linux `TIOCSWINSZ = 0x5414`; darwin `0x80087467`. Struct: 4 × `uint16` (`ws_row`, `ws_col`, `ws_xpixel`, `ws_ypixel`).
  5. `spawn` de `node:child_process`:

```ts
import { spawn } from "node:child_process";

const child = spawn(file, args, {
  cwd: input.cwd,
  env: input.env,
  stdio: [slaveFd, slaveFd, slaveFd],
  detached: false,
  windowsHide: true,
});
```

  6. Tras spawn, `fs.closeSync(slaveFd)` en el padre (el hijo ya duplicó). Leer el master con `fs.read` en un loop (`setImmediate` / `fs.read` async) y emitir `onData`. `write` → `fs.writeSync(masterFd, data)` acotado a `PTY_CHUNK_MAX_BYTES`.
  7. `kill(signal)`:

```ts
try {
  process.kill(-child.pid, signal || "SIGTERM");
} catch {
  try {
    child.kill(signal || "SIGTERM");
  } catch {
    // already dead
  }
}
```

  8. **Prohibido** `child.unref()`. **Prohibido** `detached: true`.
  9. `child.on("exit")` cierra master fd y dispara `onExit`.

Exportar `nativePtyBackend: PtyBackend` y `isPtyPlatformSupported()` (`process.platform !== "win32"`).

- [ ] Test `cli/src/pty/native.test.ts`:

  - `win32`: stub `process.platform` no es viable de forma estable; extraer `assertPtyPlatform(platform: string)` y testear que `"win32"` tira `PTY_UNSUPPORTED`.
  - Si `existsSync("/dev/ptmx")`: spawn ` /bin/sh -c 'echo pty-ok'` en un tmp cwd, esperar `onData` que incluya `pty-ok` (timeout 5s), `onExit` code 0, y `kill` no deja el pid vivo (`process.kill(pid, 0)` tira).
  - Si no hay `/dev/ptmx`, skip con `test.skip` **solo** ese caso live; el resto corre.

- [ ] Correr:

```bash
cd cli && bun test src/pty/fake-backend.test.ts src/pty/native.test.ts
```

- [ ] Commit:

```bash
git add cli/src/pty/backend.ts cli/src/pty/native.ts cli/src/pty/fake-backend.ts \
  cli/src/pty/native.test.ts cli/src/pty/fake-backend.test.ts
git commit -m "feat(pty): native openpty spawn, resize, process-group kill"
```

---

## Task 3: PtyManager — sesiones, aislamiento bash, idle, killAll

**Files:**

- Create: `cli/src/pty/manager.ts`
- Test: `cli/src/pty/manager.test.ts`

El manager es el único que toca el backend. Bash one-shot **no** es un método del manager.

- [ ] Crear `cli/src/pty/manager.ts`:

```ts
import { hostname as osHostname } from "node:os";
import {
  PTY_BUSY,
  PTY_CHUNK_MAX_BYTES,
  PTY_DEFAULT_COLS,
  PTY_DEFAULT_ROWS,
  PTY_IDLE_CLOSED,
  PTY_IDLE_MS,
  PTY_IDLE_SWEEP_MS,
  PTY_KILL_GRACE_MS,
  PTY_MAX_SESSIONS,
  PTY_NOT_FOUND,
  PTY_OWNER_GONE,
  PTY_TRANSCRIPT_MAX_CHARS,
} from "./constants";
import type { PtyBackend, PtyChild } from "./backend";
import { sanitizePtyEnv } from "./env";
import { persistPtyTranscript } from "./redact";
import type { PtyKind, PtyOpenInput, PtyOpenResult, PtyStatus } from "./types";

export type PtySession = {
  ptyId: string;
  kind: PtyKind;
  ownerConnectionId: string;
  cwd: string;
  hostname: string;
  chatId?: string;
  toolCallId?: string;
  cols: number;
  rows: number;
  pid: number;
  status: PtyStatus;
  startedAt: number;
  lastActivityAt: number;
  transcript: string;
  child: PtyChild;
  command?: string;
};

export type PtyManagerHooks = {
  onData: (ptyId: string, chunk: Uint8Array) => void;
  onExit: (ptyId: string, info: {
    exitCode: number | null;
    reason: string;
    transcript: string;
    session: PtySession;
  }) => void;
};

export class PtyManager {
  readonly sessions = new Map<string, PtySession>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private backend: PtyBackend,
    private hooks: PtyManagerHooks,
    private now: () => number = Date.now,
  ) {}

  startSweeper() {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.reapIdle(), PTY_IDLE_SWEEP_MS);
    // do NOT unref the sweeper — we want it to keep the daemon honest
  }

  stopSweeper() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  open(input: PtyOpenInput): PtyOpenResult {
    if (this.sessions.size >= PTY_MAX_SESSIONS) throw new Error(PTY_BUSY);
    const cols = input.cols || PTY_DEFAULT_COLS;
    const rows = input.rows || PTY_DEFAULT_ROWS;
    const shell = process.env.SHELL || "/bin/bash";
    const file = input.kind === "agent" ? "/bin/bash" : shell;
    const args =
      input.kind === "agent"
        ? ["-lc", input.command || "true"]
        : ["-i"];
    const child = this.backend.spawn({
      cwd: input.cwd,
      env: sanitizePtyEnv(),
      file,
      args,
      cols,
      rows,
    });
    const ptyId = crypto.randomUUID();
    const session: PtySession = {
      ptyId,
      kind: input.kind,
      ownerConnectionId: input.ownerConnectionId,
      cwd: input.cwd,
      hostname: osHostname(),
      chatId: input.chatId,
      toolCallId: input.toolCallId,
      cols,
      rows,
      pid: child.pid,
      status: "open",
      startedAt: this.now(),
      lastActivityAt: this.now(),
      transcript: "",
      child,
      command: input.command,
    };
    this.sessions.set(ptyId, session);
    child.onData((chunk) => {
      session.lastActivityAt = this.now();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk);
      session.transcript = (session.transcript + text).slice(-PTY_TRANSCRIPT_MAX_CHARS * 2);
      this.hooks.onData(ptyId, chunk);
    });
    child.onExit(({ exitCode, signal }) => {
      session.status = "exited";
      const reason = signal ? `signal ${signal}` : `exit ${exitCode ?? 0}`;
      const transcript = persistPtyTranscript(session.transcript);
      this.sessions.delete(ptyId);
      this.hooks.onExit(ptyId, { exitCode, reason, transcript, session });
    });
    return {
      ptyId,
      pid: child.pid,
      hostname: session.hostname,
      cwd: session.cwd,
      cols,
      rows,
      kind: input.kind,
      shell: file,
    };
  }

  write(ptyId: string, ownerConnectionId: string, data: Uint8Array) {
    const s = this.requireOwner(ptyId, ownerConnectionId);
    const slice = data.byteLength > PTY_CHUNK_MAX_BYTES ? data.slice(0, PTY_CHUNK_MAX_BYTES) : data;
    s.lastActivityAt = this.now();
    s.child.write(slice);
  }

  resize(ptyId: string, ownerConnectionId: string, cols: number, rows: number) {
    const s = this.requireOwner(ptyId, ownerConnectionId);
    s.cols = cols;
    s.rows = rows;
    s.child.resize(cols, rows);
  }

  async close(ptyId: string, reason = "close") {
    const s = this.sessions.get(ptyId);
    if (!s) throw new Error(PTY_NOT_FOUND);
    await this.killSession(s, reason);
  }

  async ownerGone(ownerConnectionId: string) {
    const mine = [...this.sessions.values()].filter(
      (s) => s.ownerConnectionId === ownerConnectionId,
    );
    for (const s of mine) await this.killSession(s, PTY_OWNER_GONE);
  }

  async killAll(reason = "daemon shutdown") {
    for (const s of [...this.sessions.values()]) await this.killSession(s, reason);
  }

  reapIdle() {
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      if (t - s.lastActivityAt >= PTY_IDLE_MS) {
        void this.killSession(s, PTY_IDLE_CLOSED);
      }
    }
  }

  /** Explicitly not a method: bash one-shot must never receive a session fd. */
  // bashOneShot does not exist on this class.

  private requireOwner(ptyId: string, ownerConnectionId: string): PtySession {
    const s = this.sessions.get(ptyId);
    if (!s) throw new Error(PTY_NOT_FOUND);
    if (s.ownerConnectionId !== ownerConnectionId) throw new Error(PTY_NOT_FOUND);
    return s;
  }

  private async killSession(s: PtySession, reason: string) {
    if (s.status === "killed" || s.status === "exited") return;
    s.status = "killed";
    s.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, PTY_KILL_GRACE_MS));
    if (this.sessions.has(s.ptyId)) {
      s.child.kill("SIGKILL");
    }
    if (this.sessions.has(s.ptyId)) {
      const transcript = persistPtyTranscript(s.transcript);
      this.sessions.delete(s.ptyId);
      this.hooks.onExit(s.ptyId, {
        exitCode: null,
        reason,
        transcript,
        session: s,
      });
    }
  }
}
```

En tests, inyectar `now` y un `PTY_KILL_GRACE_MS` efectivo: para no esperar 1500ms, el fake `kill("SIGTERM")` llama `emitExit` de inmediato, así el grace path no bloquea. Añadir un test que, si el child **no** sale en TERM, se llama `kill("SIGKILL")`. Para ese test, no emitir exit en TERM.

Para no hardcodear 1500ms en tests, extraer `killSession` grace como parámetro del constructor `graceMs = PTY_KILL_GRACE_MS` y en test pasar `5`.

- [ ] Añadir al constructor `private graceMs = PTY_KILL_GRACE_MS` y usarlo en `setTimeout`.

- [ ] Crear `cli/src/pty/manager.test.ts` cubriendo:

  1. `open` user usa `["-i"]`; `open` agent usa `["-lc", command]`.
  2. `PTY_MAX_SESSIONS + 1` tira `PTY_BUSY`.
  3. `write` de un `ownerConnectionId` distinto tira `PTY_NOT_FOUND` y **no** acumula `writes` en el child.
  4. `ownerGone` llama `kill("SIGTERM")` (y SIGKILL si no sale).
  5. `reapIdle` con `now` avanzado `PTY_IDLE_MS + 1` cierra con `PTY_IDLE_CLOSED`.
  6. `killAll` vacía `sessions`.
  7. Los `writes` de un user PTY **no** incluyen output de un segundo spawn: abrir user, abrir agent, `emitData` en agent **no** cambia `user.transcript` ni dispara `onData` del user id.
  8. `PtyManager` **no** tiene método `bash` / `bashOneShot` (`"bashOneShot" in manager` es false).
  9. Fake child `unrefCalled` sigue `false` tras `open`.

- [ ] Correr:

```bash
cd cli && bun test src/pty/manager.test.ts
```

- [ ] Commit:

```bash
git add cli/src/pty/manager.ts cli/src/pty/manager.test.ts
git commit -m "feat(pty): session manager with idle, owner-gone, bash isolation"
```

---

## Task 4: Protocolo WS — pending open, owner-only data, onClose kill

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Create: `api/src/ws/pty-registry.ts`
- Test: `api/src/ws/pty-registry.test.ts`
- Modify: `api/src/ws/pending.ts` (crear idéntico a attach-files Task 3 si no existe)
- Test: `api/src/ws/pending.test.ts` (solo si se crea)
- Modify: `api/src/index.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `api/package.json`

La API no spawnea. `pty.data` usa `hub.sendTo(ownerConnectionId)`, **nunca** `broadcastToUser`.

- [ ] Si `api/src/ws/pending.ts` no existe, crearlo **idéntico** al de attach-files (`createPendingMap(timeoutMs)` cuyo timeout resuelve `fail(..., NO_DAEMON_ERROR)`). Reutilizar el módulo. En handlers:

```ts
const ptyPending = createPendingMap(PTY_OPEN_TIMEOUT_MS);
```

No reusar el mapa de `fs.complete` (timeout 5s vs 10s).

- [ ] Crear `api/src/ws/pty-registry.ts`:

```ts
import type { PtyKind } from "../../cli/src/pty/types";
```

**No.** API no importa CLI. Duplicar `type PtyKind = "user" | "agent"`.

```ts
export type PtyHubSession = {
  ptyId: string;
  ownerConnectionId: string;
  daemonConnectionId: string;
  workspaceId: string;
  kind: "user" | "agent";
  chatId: string | null;
};

const byId = new Map<string, PtyHubSession>();

export const ptyRegistry = {
  add(s: PtyHubSession) {
    byId.set(s.ptyId, s);
  },
  get(ptyId: string) {
    return byId.get(ptyId) ?? null;
  },
  remove(ptyId: string) {
    byId.delete(ptyId);
  },
  listByOwner(ownerConnectionId: string) {
    return [...byId.values()].filter((s) => s.ownerConnectionId === ownerConnectionId);
  },
  listByDaemon(daemonConnectionId: string) {
    return [...byId.values()].filter((s) => s.daemonConnectionId === daemonConnectionId);
  },
  clear() {
    byId.clear();
  },
};
```

- [ ] Test `api/src/ws/pty-registry.test.ts`: add/get/listByOwner/remove.

- [ ] En `api/src/ws/protocol.ts`, extender `ClientMessage` (dejar el resto):

```ts
  ptyId?: string;
  cols?: number;
  rows?: number;
  chunk?: string;
  encoding?: string;
  requestId?: string;
  hostname?: string;
  ownerConnectionId?: string;
  reason?: string;
  exitCode?: number | null;
```

- [ ] En `api/src/ws/handlers.ts`, cases nuevos **antes** de `default`. Importar `PTY_DENIED_CI`, `NO_DAEMON_ERROR`, `PTY_NOT_FOUND` desde `api/src/pty/constants.ts`. Helper `isCiMeta(msg)`: `msg.metadata?.ci === true` o `msg.metadata?.source === "ci"`.

  `pty.open`:
  1. `workspaceId` vía `msg.chatId` → `workspaceIdForChat` **o**, si no hay chatId, `requireWorkspace(connectionId)` (Web bound al workspace).
  2. Si `isCiMeta(msg)` → `fail(type, id, PTY_DENIED_CI)`.
  3. `hub.findDaemon`; si no → `fail` `NO_DAEMON_ERROR`.
  4. `hub.sendTo(daemon, push "pty.open.dispatch", { requestId: id, ownerConnectionId: connectionId, cols: msg.cols, rows: msg.rows, chatId: msg.chatId, path: workspace?.path || daemon.path, kind: "user" })`.
  5. Si `!sent` → `fail` `"Daemon connection unavailable"`.
  6. `return await ptyPending.wait(id, type)`.

  `pty.open.result`:
  1. Requiere `msg.requestId` y `msg.ptyId`.
  2. `ptyRegistry.add({ ptyId, ownerConnectionId: msg.ownerConnectionId || "", daemonConnectionId: connectionId, workspaceId: hub.get(connectionId)?.workspaceId || "", kind: "user", chatId: msg.chatId || null })`.
  3. `ptyPending.complete(msg.requestId, ok("pty.open", msg.requestId, { ptyId: msg.ptyId, hostname: msg.hostname, cwd: msg.path, cols: msg.cols, rows: msg.rows, pid: msg.metadata?.pid }))`.
  4. `ok` al daemon `{ forwarded: true }`.

  `pty.input` / `pty.resize` / `pty.close`:
  1. `ptyRegistry.get(msg.ptyId)`; si no → `PTY_NOT_FOUND`.
  2. Si `session.ownerConnectionId !== connectionId` → `PTY_NOT_FOUND` (no filtrar existencia a un extraño).
  3. Forward `pty.input.dispatch` / `pty.resize.dispatch` / `pty.close.dispatch` al `daemonConnectionId` con `{ ptyId, chunk, cols, rows, ownerConnectionId }`.
  4. Responder `ok` inmediato (I/O no espera pending).

  `pty.data` (daemon → API, request RPC):
  1. `hub.sendTo(owner, push "pty.data", { ptyId, chunk, encoding: "base64" })`.
  2. **No** `broadcastToUser`.
  3. `ok` `{ forwarded }`.

  `pty.exit` (daemon → API):
  1. `sendTo(owner, push "pty.exit", { ptyId, exitCode, reason, hostname, cwd })`.
  2. Si `chatId` y `transcript` en metadata: insertar `chat_messages` `role=tool` con `metadata.toolName: "pty"`, `status: "done"|"error"`, `output: transcript` (ya redactado por el daemon), `source: kind`. Broadcast `chat.tool.result` + `message.appended` **solo** ese snapshot, no el stream.
  3. `ptyRegistry.remove(ptyId)`.

- [ ] En `api/src/index.ts` `onClose`:

```ts
onClose() {
  const owned = ptyRegistry.listByOwner(connectionId);
  const conn = hub.get(connectionId);
  for (const s of owned) {
    hub.sendTo(
      s.daemonConnectionId,
      hub.pushEvent("pty.kill.dispatch", {
        ptyId: s.ptyId,
        ownerConnectionId: connectionId,
        reason: "PTY closed: owner disconnected",
      }),
    );
    ptyRegistry.remove(s.ptyId);
  }
  if (conn?.clientKind === "daemon") {
    for (const s of ptyRegistry.listByDaemon(connectionId)) {
      ptyRegistry.remove(s.ptyId);
    }
  }
  hub.remove(connectionId);
}
```

Si el plan 17 ya envuelve `onClose`, **insertar** el bloque PTY **antes** de `hub.remove`. No borrar heartbeat/presence.

- [ ] Extender `WsRequest` en `cli/src/ws/client.ts` y `web/src/lib/ws-client.ts` con `ptyId?`, `cols?`, `rows?`, `chunk?`, `encoding?`, `requestId?`, `ownerConnectionId?`.

- [ ] Correr:

```bash
cd api && bun test src/ws/pty-registry.test.ts src/ws/pending.test.ts
```

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/handlers.ts api/src/ws/pty-registry.ts \
  api/src/ws/pty-registry.test.ts api/src/ws/pending.ts api/src/ws/pending.test.ts \
  api/src/index.ts cli/src/ws/client.ts web/src/lib/ws-client.ts api/package.json
git commit -m "feat(pty): WS open/input/data/exit, owner-only fan-out, kill on close"
```

---

## Task 5: Daemon + TUI — handlers, cwd, shutdown sin huérfanos

**Files:**

- Create: `cli/src/pty/daemon-handlers.ts`
- Test: `cli/src/pty/daemon-handlers.test.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `tui/src/App.tsx`

`getCwd()` = `getEffectiveCwd()` si el plan 28 ya exporta esa función; si no, el bind path (`argv[2]` / `env.public.chavezCwd`). **Nunca** `process.chdir`. **Nunca** el path del proceso API.

- [ ] Crear `cli/src/pty/daemon-handlers.ts`:

```ts
import { hostname } from "node:os";
import type { ChavezWsClient, WsPushMessage } from "../ws/client";
import { nativePtyBackend } from "./native";
import { PtyManager } from "./manager";
import { persistPtyTranscript } from "./redact";
import { PTY_CHUNK_MAX_BYTES } from "./constants";

function b64(u8: Uint8Array): string {
  return Buffer.from(u8).toString("base64");
}

export function createDaemonPty(input: {
  client: ChavezWsClient;
  getCwd: () => string;
  backend?: ConstructorParameters<typeof PtyManager>[0];
}): PtyManager {
  const manager = new PtyManager(input.backend ?? nativePtyBackend, {
    onData(ptyId, chunk) {
      const slice = chunk.byteLength > PTY_CHUNK_MAX_BYTES ? chunk.slice(0, PTY_CHUNK_MAX_BYTES) : chunk;
      void input.client.request({
        type: "pty.data",
        ptyId,
        chunk: b64(slice),
        encoding: "base64",
      });
    },
    onExit(ptyId, info) {
      void input.client.request({
        type: "pty.exit",
        ptyId,
        chatId: info.session.chatId,
        path: info.session.cwd,
        hostname: info.session.hostname,
        metadata: {
          exitCode: info.exitCode,
          reason: info.reason,
          transcript: persistPtyTranscript(info.transcript),
          kind: info.session.kind,
          command: info.session.command,
          pid: info.session.pid,
        },
      });
    },
  });
  manager.startSweeper();
  return manager;
}

export async function handlePtyPush(
  manager: PtyManager,
  client: ChavezWsClient,
  msg: WsPushMessage,
  getCwd: () => string,
): Promise<boolean> {
  const data = (msg.data || {}) as Record<string, unknown>;
  if (msg.type === "pty.open.dispatch") {
    const requestId = String(data.requestId || "");
    if (!requestId) return true;
    try {
      const opened = manager.open({
        kind: (data.kind as "user" | "agent") || "user",
        ownerConnectionId: String(data.ownerConnectionId || ""),
        cwd: String(data.path || getCwd()),
        cols: typeof data.cols === "number" ? data.cols : undefined,
        rows: typeof data.rows === "number" ? data.rows : undefined,
        chatId: typeof data.chatId === "string" ? data.chatId : undefined,
        command: typeof data.command === "string" ? data.command : undefined,
        toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : undefined,
      });
      await client.request({
        type: "pty.open.result",
        requestId,
        ptyId: opened.ptyId,
        hostname: opened.hostname || hostname(),
        path: opened.cwd,
        cols: opened.cols,
        rows: opened.rows,
        ownerConnectionId: String(data.ownerConnectionId || ""),
        chatId: typeof data.chatId === "string" ? data.chatId : undefined,
        metadata: { pid: opened.pid, kind: opened.kind },
      });
    } catch (err) {
      await client.request({
        type: "pty.open.result",
        requestId,
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    return true;
  }
  if (msg.type === "pty.input.dispatch") {
    const raw = Buffer.from(String(data.chunk || ""), "base64");
    manager.write(String(data.ptyId), String(data.ownerConnectionId || ""), new Uint8Array(raw));
    return true;
  }
  if (msg.type === "pty.resize.dispatch") {
    manager.resize(
      String(data.ptyId),
      String(data.ownerConnectionId || ""),
      Number(data.cols) || 80,
      Number(data.rows) || 24,
    );
    return true;
  }
  if (msg.type === "pty.close.dispatch" || msg.type === "pty.kill.dispatch") {
    await manager.close(String(data.ptyId), String(data.reason || "close"));
    return true;
  }
  return false;
}
```

Si `pty.open.result` con `metadata.error`, el handler API debe `ptyPending.complete(..., fail("pty.open", requestId, error))` en vez de `ok`. Añadir esa rama en Task 4 si no quedó: `if (msg.metadata?.error) complete fail`.

- [ ] Test `cli/src/pty/daemon-handlers.test.ts` con fake backend + fake client (`requests: []`):

  - `pty.open.dispatch` emite `pty.open.result` con `hostname` y `cwd` = `getCwd()` (`/tmp/ws-a`, no `/api`).
  - `pty.input.dispatch` escribe bytes en el child del owner.
  - Un `agent.turn.dispatch` **no** es handled (`handlePtyPush` retorna false) y el child user no recibe writes.

- [ ] En `cli/src/ws/daemon.ts`:

  1. Importar `createDaemonPty`, `handlePtyPush`.
  2. `const getCwd = () => { try { return require("../llm/effective-cwd").getEffectiveCwd(); } catch { return path; } };` — si `cli/src/llm/effective-cwd.ts` existe, import estático `getEffectiveCwd`.
  3. `const ptyManager = createDaemonPty({ client, getCwd });`
  4. Al inicio de `onPush`: `if (await handlePtyPush(ptyManager, client, msg, getCwd)) return;`
  5. `agent.turn.dispatch` **no** toca `ptyManager`. `turnBusy` **no** se setea por `pty.open`.
  6. `shutdown`:

```ts
const shutdown = async () => {
  try {
    await ptyManager.killAll("daemon shutdown");
    ptyManager.stopSweeper();
  } catch {
    // still exit
  }
  try {
    client.close();
  } catch {
    // ignore
  }
  process.exit(0);
};
```

SIGTERM/SIGINT usan este `shutdown`. El `setInterval` ping existente se queda.

- [ ] En `tui/src/App.tsx`:

  1. Tras `setClient(c)` / bind daemon, `const ptyManagerRef = useRef<PtyManager | null>(null)` — crear `createDaemonPty({ client: c, getCwd: () => cwd })` una vez.
  2. En el `onPush` existente, **antes** de `agent.turn.dispatch`: `void handlePtyPush(ptyManagerRef.current, client, msg, () => cwd)`.
  3. Cleanup del `useEffect` de conexión: `void ptyManagerRef.current?.killAll("tui close"); ptyManagerRef.current?.stopSweeper(); c.close();`
  4. `agent.turn.dispatch` sigue llamando `publishAgentTurn` — **no** pasa el `ptyId` del usuario.

La UI del modo `"pty"` es Task 7; aquí solo el manager vive.

- [ ] Commit:

```bash
git add cli/src/pty/daemon-handlers.ts cli/src/pty/daemon-handlers.test.ts \
  cli/src/ws/daemon.ts tui/src/App.tsx
git commit -m "feat(pty): daemon/TUI handlers, cwd of daemon, killAll on shutdown"
```

---

## Task 6: Tool del agente — MCP Pty, canUseTool, Bash intacto

**Files:**

- Create: `cli/src/pty/mcp.ts`
- Test: `cli/src/pty/mcp.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/can-use-tool.ts` (crear con el mínimo de `decideCanUseTool` si el plan 3 no lo creó; si existe, **extender**)
- Modify: `cli/src/llm/tool-names.ts` (si existe)
- Modify: `cli/src/llm/execution-gate.ts` (si existe)
- Modify: `cli/src/llm/approval-prompt.ts` (si existe)
- Test: `cli/src/llm/can-use-tool.pty.test.ts`
- Modify: `cli/src/ci/runner.ts` o el punto donde `chavez ci` arma `query` (si el plan 25 existe; si no, el guard vive en `publish-turn` vía `metadata.ci`)

Bash **no** se convierte en PTY. Pty es MCP opt-in gated.

- [ ] Si `cli/src/llm/tool-names.ts` existe, añadir mapeo `Pty` / `mcp__chavez-pty__pty` → `"pty"`. **No** meter `Pty` en `DEFAULT_CLAUDE_TOOLS` (sigue siendo las 6). `toolClass("Pty")` → `"write"`.

- [ ] Si `cli/src/llm/execution-gate.ts` existe, tratar `isPtyTool(sdkName)` como write **antes** de Bash: en `auto` **no** allow — el gate de PTY es más estricto. Orden congelado dentro de `decideCanUseTool`:

  1. `denyIfEscapes` (file tools).
  2. `denyIfIgnored` si existe.
  3. `denyIfBashEscapes` si Bash.
  4. Si `isPtyTool(name)` → `gatePty({ mode, ci })`:
     - deny → `{ behavior: "deny", message }`
     - ask → waiter (plan 3/13)
     - allow no ocurre nunca para Pty salvo tests: `gatePty` no tiene allow (user PTY no pasa por aquí).
  5. `gateMutation` para write/bash no-PTY.
  6. `gateNetwork` si plan 26 existe.

En `auto`, `gatePty` deniega **antes** de que `gateMutation` pudiera allow Bash-like. Cubrir con test: `decideCanUseTool({ name: "mcp__chavez-pty__pty", mode: "auto" })` → deny `PTY_DENIED_AUTO`.

Si `can-use-tool.ts` no existe, crearlo con esa función mínima + los denies de PTY; el resto de tools `allow` (el plan 3 lo endurecerá).

- [ ] Crear `cli/src/pty/mcp.ts`:

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PTY_MCP_SERVER, PTY_MCP_TOOL, PTY_PREAMBLE } from "./constants";
import type { PtyManager } from "./manager";

export function createPtyMcpServer(input: {
  manager: PtyManager;
  getCwd: () => string;
  ownerConnectionId: string;
  chatId: string;
}): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: PTY_MCP_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        PTY_MCP_TOOL,
        "Open an interactive PTY for a command that needs a TTY (pagers, REPLs, editors). Prefer Bash for one-shot. Denied in auto and CI.",
        { command: z.string() },
        async ({ command }) => {
          const opened = input.manager.open({
            kind: "agent",
            ownerConnectionId: input.ownerConnectionId,
            cwd: input.getCwd(),
            command,
            chatId: input.chatId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `PTY started ptyId=${opened.ptyId} pid=${opened.pid} cwd=${opened.cwd} host=${opened.hostname}. Interact from Web/TUI. Command: ${command}`,
              },
            ],
          };
        },
      ),
    ],
  });
}

export { PTY_PREAMBLE };
```

El handler MCP **solo** corre si `canUseTool` ya permitió (ask + approve). En auto nunca llega.

Tras `open`, el daemon ya emite `pty.data`. Falta que Web/TUI abran el panel: en `publish-turn`, cuando `canUseTool` aprueba Pty, emitir `pty.attach` no — el API lo hace al recibir `pty.open.result` con `kind: "agent"`: `hub.sendTo(owner, push "pty.attach", { ptyId, hostname, cwd, command, kind: "agent" })`. Añadir `kind` en `pty.open.result` (ya en metadata). En handlers, si `metadata.kind === "agent"`, push `pty.attach` al owner **además** de completar pending. El pending de agent PTY lo espera el MCP en-process (no el API): el MCP llama `manager.open` **directo** en el daemon, no pasa por `pty.open` WS.

Flujo agent (congelado):

1. SDK `canUseTool` → ask → `chat.tool.update awaiting_approval` `{ prompt: { kind: "pty", command } }`.
2. Approve → MCP handler `manager.open({ kind: "agent" })`.
3. Daemon `onData` → `pty.data` al owner. Daemon también `client.request({ type: "pty.attach", ...})` **o** el manager hook `onOpen`. Añadir hook `onOpen` al manager:

```ts
onOpen?: (session: PtySession, opened: PtyOpenResult) => void;
```

En `createDaemonPty`, `onOpen` hace `client.request({ type: "pty.attach", ptyId, hostname, path: cwd, chatId, metadata: { kind, command, pid } })`.

4. API `pty.attach`: `hub.sendTo(owner)` push `pty.attach`. Si el owner es la TUI (mismo proceso que el daemon), TUI también escucha el push (loopback) **y** puede abrir el panel local por el hook — usar **solo** el push para no duplicar. TUI `onPush` `pty.attach` entra en modo pty con ese `ptyId` (Task 7).
5. Al `onExit`, tool result ya viaja como `pty.exit` persistido. El MCP handler no debe `await` el exit (el SDK se quedaría colgado si el usuario tarda): devolver el texto “PTY started…” y dejar que el modelo continúe **o** esperar con timeout `PTY_AGENT_TIMEOUT_MS`. Producto: **esperar exit** para que el pager tenga sentido (el humano interactúa; el tool result es el transcript). Implementar:

```ts
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => {
    void input.manager.close(opened.ptyId, "agent timeout");
    reject(new Error("PTY agent timeout"));
  }, PTY_AGENT_TIMEOUT_MS);
  const off = /* subscribe onExit for this ptyId */;
});
return { content: [{ type: "text", text: transcript }] };
```

Añadir `waitForExit(ptyId, ms)` al manager.

- [ ] `waitForExit` test: `emitExit(0)` resuelve; timeout llama `close`.

- [ ] En `cli/src/llm/approval-prompt.ts` (si existe) añadir:

```ts
| { kind: "pty"; command: string }
```

Headline: `pty · ${command}`. Si el archivo no existe, el `chat.tool.update` metadata `prompt` lo arma `can-use-tool` / `publish-turn` con ese shape.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. `permissionMode` permanece `"default"` (si aún es `bypassPermissions`, cambiarlo **aquí** — PTY no puede saltarse el gate).
  2. `appendSystemPrompt`: concatenar `PTY_PREAMBLE` (no borrar preambles de modos/git).
  3. `mcpServers`: `{ [PTY_MCP_SERVER]: createPtyMcpServer(...) }` **salvo** `input.ci === true` o `input.ptyAllowed === false`.
  4. `allowedTools`: `[...DEFAULT_CLAUDE_TOOLS, PTY_MCP_FULL]` cuando pty allowed; **sin** `PTY_MCP_FULL` en CI.
  5. `canUseTool` delega `decideCanUseTool` incluyendo `gatePty`.
  6. **No** pasar `pty: true` ni fds de `PtyManager` al Bash del SDK.

Extender `RunClaudeTurnInput` con `ci?: boolean`, `ptyAllowed?: boolean`, `ptyManager?: PtyManager`, `ownerConnectionId?: string`, `chatId?: string`.

- [ ] En `cli/src/llm/publish-turn.ts`: pasar `ptyManager` / `getCwd` / `ci: Boolean(metadata.ci)` desde el caller. El daemon tiene el manager; `publishAgentTurn` recibe `ptyManager` opcional. Si falta, `ptyAllowed: false` (no romper turns headless de tests).

- [ ] `cli/src/ws/daemon.ts` `publishAgentTurn({ ..., ptyManager, ptyAllowed: true, ownerConnectionId: data.requesterConnectionId || "", ci: data.ci === true })`.

- [ ] Si `cli/src/ci/` existe, el runner in-process pasa `ptyAllowed: false`, `ci: true`. Si no, `publish-turn` lee `process.env.CI` / `CHAVEZ_CI`.

- [ ] Test `cli/src/llm/can-use-tool.pty.test.ts`:

  - auto + Pty → deny `PTY_DENIED_AUTO`
  - plan + Pty → deny `PTY_DENIED_PLAN`
  - ask + Pty → `ask` (o `behavior: "ask"`)
  - ci + Pty → deny `PTY_DENIED_CI`
  - auto + Bash → **no** es `PTY_DENIED_AUTO` (Bash sigue el gate de write: allow en auto)

- [ ] Test `cli/src/pty/mcp.test.ts`: con fake manager, el tool `pty` llama `open({ kind: "agent", command })`. Un spy `bashSpawn` **no** se llama.

- [ ] Commit:

```bash
git add cli/src/pty/mcp.ts cli/src/pty/mcp.test.ts \
  cli/src/llm/claude-runner.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/can-use-tool.ts cli/src/llm/can-use-tool.pty.test.ts \
  cli/src/llm/tool-names.ts cli/src/llm/execution-gate.ts \
  cli/src/llm/approval-prompt.ts cli/src/ws/daemon.ts
git commit -m "feat(pty): agent Pty MCP gated by ask/auto/plan/CI; bash stays one-shot"
```

---

## Task 7: TUI — tecla `t`, hostname · path, ctrl+x mata el PTY

**Files:**

- Modify: `tui/src/App.tsx`
- Create: `tui/src/pty-overlay.ts`
- Test: `cli/src/pty/tui-input.test.ts`

Ink se come stdin. En modo `"pty"` el overlay escribe al master y pinta output crudo.

- [ ] Crear `tui/src/pty-overlay.ts`:

```ts
import type { PtyManager } from "../../cli/src/pty/manager";
import { PTY_TUI_CLOSE_HINT } from "../../cli/src/pty/constants";

export function formatPtyHeader(hostname: string, cwd: string): string {
  return `pty · ${hostname} · ${cwd}`;
}

export { PTY_TUI_CLOSE_HINT };
```

- [ ] Test `cli/src/pty/tui-input.test.ts` (el formatter vive en TUI; duplicar `formatPtyHeader` en `cli/src/pty/display.ts` para testearlo sin Ink):

Crear `cli/src/pty/display.ts`:

```ts
export function formatPtyHeader(hostname: string, cwd: string): string {
  return `pty · ${hostname} · ${cwd}`;
}
```

Test: `formatPtyHeader("box", "/repo") === "pty · box · /repo"`. TUI importa esa función.

- [ ] En `tui/src/App.tsx`:

  1. `mode` gana `"pty"`: `"command" | "compose" | "pty"`.
  2. Estado `ptyId: string | null`, `ptyHeader: string`.
  3. Tecla `t` en command (no busy-blocked para PTY de usuario: el Gherkin permite abrir terminal mientras hay chat): si no hay `ptyManagerRef` / client → log `NO_DAEMON_ERROR`. Si sí:

```ts
const opened = ptyManagerRef.current.open({
  kind: "user",
  ownerConnectionId: "tui-local",
  cwd,
  chatId: activeChatId ?? undefined,
});
setPtyId(opened.ptyId);
setPtyHeader(formatPtyHeader(opened.hostname, opened.cwd));
setMode("pty");
setLog(PTY_TUI_CLOSE_HINT);
```

TUI local **no** espera `pty.open` WS (es el daemon). Igual registra: `client.request({ type: "pty.open.result", ...})` no aplica. Para que el API sepa el owner si Web… no hace falta: es local. Al salir, `manager.close`.

  4. `useInput` **al inicio**: si `mode === "pty"`:
     - `key.ctrl && ch === "x"` → `void manager.close(ptyId)`; `setMode("command")`; `setPtyId(null)`; return.
     - `escape` **no** mata la TUI (iría al shell). Documentado en el hint.
     - resto: `manager.write(ptyId, "tui-local", encode(ch or key))`. Mapear enter → `"\r"`, backspace → `"\x7f"`, arrows → CSI.
     - `q` **no** hace `exit()`.
  5. `onExit` del manager (hook ya emite WS): si `ptyId` coincide, `setMode("command")`.
  6. Header visible **siempre** que `mode === "pty"`: `<Text color="cyan">{ptyHeader}</Text>` + hint.
  7. Output: suscribirse a `child.onData` en local y `process.stdout.write(chunk)` **o** acumular en `ptyLog` y pintarlo en un `<Box height={12}>`. Preferir buffer `ptyLog` (últimas 30 líneas) para no pelear con Ink. Editores fullscreen (vim) serán degradados en TUI; Web lleva xterm. El Gherkin pide adjuntarse, no un tmux perfecto. Ctrl+x sigue matando vim en el process group.
  8. Cleanup app (`q` en command, `ctrl+c` en command): `killAll` ya en el effect.
  9. `agent.turn.dispatch` durante modo pty **sigue** corriendo Bash one-shot; no redirige stdin del overlay al agente.

- [ ] Ayuda en la barra: `[t] terminal`.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/pty-overlay.ts cli/src/pty/display.ts \
  cli/src/pty/tui-input.test.ts
git commit -m "feat(pty): TUI attach in daemon cwd with hostname, ctrl+x kills"
```

---

## Task 8: Web — xterm, hostname · path, unmount mata el PTY

**Files:**

- Modify: `web/package.json`
- Create: `web/src/components/PtyTerminal.tsx`
- Create: `web/src/lib/pty-ws.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`

Única dependencia npm nueva de esta fase: `@xterm/xterm` y `@xterm/addon-fit` en **web**. No añadirlas a `cli/` ni `api/`.

- [ ] En `web/package.json` `dependencies`:

```json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

Correr `cd web && bun install`.

- [ ] Crear `web/src/lib/pty-ws.ts`:

```ts
/** keep-in-sync: cli/src/pty/display.ts */
export function formatPtyHeader(hostname: string, cwd: string): string {
  return `pty · ${hostname} · ${cwd}`;
}

export function encodePtyChunk(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export function decodePtyChunk(b64: string): string {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return atob(b64);
  }
}
```

- [ ] En `web/src/lib/ws-hooks.ts` añadir `useWsPtyOpen`:

```ts
export function useWsPtyOpen() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId?: string;
      cols?: number;
      rows?: number;
    }) =>
      ws.request({
        type: "pty.open",
        chatId: input.chatId,
        cols: input.cols,
        rows: input.rows,
      }),
  });
}
```

- [ ] Crear `web/src/components/PtyTerminal.tsx`:

  - Props: `{ chatId?: string; open: boolean; onClosed: () => void }`.
  - Al `open===true`: `pty.open` con `cols/rows` del `FitAddon`. Si fail: mostrar `error` (sin daemon → el string `NO_DAEMON_ERROR`; no listar el disco de la API).
  - Header: `formatPtyHeader(data.hostname, data.cwd)` — visible **antes** de focus. Si falta hostname, `"daemon · " + cwd`.
  - `new Terminal({ convertEol: true, cursorBlink: true, fontFamily: "var(--mono)" })` + `FitAddon`. `term.onData(data => ws.request({ type: "pty.input", ptyId, chunk: encodePtyChunk(data), encoding: "base64" }))`.
  - `ws.onPush`: `pty.data` con ese `ptyId` → `term.write(decodePtyChunk(chunk))`. `pty.exit` / `pty.attach` (si `kind===agent"` y este panel está libre, enganchar).
  - `useEffect` cleanup: `ws.request({ type: "pty.close", ptyId })`; `term.dispose()`.
  - `window.addEventListener("beforeunload", close)`.
  - Botón “Cerrar terminal” llama `pty.close` + `onClosed`.
  - Sin daemon: copy `"No hay filesystem: arranca el daemon (chavez headless workspace open o chavez tui). El terminal no corre en el servidor."` — el error RPC es `NO_DAEMON_ERROR`; el copy UI puede ser más largo **además** de pintar el error.

- [ ] CSS `.pty-wrap` en `web/src/styles/global.css`:

```css
.pty-wrap {
  min-height: 220px;
  height: 40vh;
  background: #0b1014;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.pty-header {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
  padding: 0.4rem 0.75rem;
  overflow-wrap: anywhere;
}
@media (max-width: 480px) {
  .pty-wrap { height: 30vh; min-height: 180px; }
}
```

- [ ] `ChatDetailPanel.tsx`: botón “Terminal” junto al compositor. Estado `ptyOpen`. Render `<PtyTerminal chatId={chatId} open={ptyOpen} onClosed={() => setPtyOpen(false)} />`. ToolCard: si `toolName === "pty"` o canónico `pty`, pintar `tool · pty · {status}` + hostname/cwd de metadata + output (snapshot), **igual** que Claude/Cursor. Si hay `awaiting_approval` y `prompt.kind === "pty"`, los botones approve/deny del plan 13 se reusan; no inventar un lote.

- [ ] `WorkspaceDetailPanel.tsx`: el mismo botón (chatId opcional: el primer chat de la session activa, o omitir persist).

- [ ] `pty.attach` push: si el usuario está en el chat del `chatId`, abrir el panel y `term` ya existente se reusa (`ptyId` state). No abrir dos xterms del mismo id.

- [ ] Commit:

```bash
git add web/package.json web/src/components/PtyTerminal.tsx web/src/lib/pty-ws.ts \
  web/src/lib/pty-constants.ts web/src/lib/ws-hooks.ts web/src/lib/ws-client.ts \
  web/src/components/ChatDetailPanel.tsx web/src/components/WorkspaceDetailPanel.tsx \
  web/src/styles/global.css
git commit -m "feat(pty): web xterm on daemon cwd with hostname, close kills"
```

---

## Task 9: Persistencia redactada, watch, CI, OpenAPI, Cursor no-op

**Files:**

- Modify: `cli/src/llm/watch-format.ts` (si plan 2 lo creó; si no, `cli/src/llm/tool-display.ts` `toolHeadline`)
- Modify: `cli/src/commands/headless.ts` (watch line)
- Modify: `cli/src/ci/detect.ts` / runner CI si existen
- Modify: `cli/src/index.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `cli/src/llm/cursor-runner.ts` **solo si existe** (no crear Cursor ejecutable)

- [ ] Headline canónico: `tool · pty · ${status}` + ` ${hostname} · ${cwd}` si vienen. `chat watch` JSON crudo sigue; si `formatWatchLine` existe, añadir rama `pty`.

- [ ] Persist ya ocurre en `pty.exit` (Task 4). Verificar que `output` es `persistPtyTranscript` **antes** del insert. Cinturón API: si `api/src/lib/redact.ts` `redactJson` existe, pasarlo por el metadata al insertar. Vault path `~/.chavez` no debe aparecer: el env strip + redact cubren tokens; test de persist con transcript `CHAVEZ_ACCESS_TOKEN=abc` → `***`.

- [ ] CI: si `isNonInteractive()` / `metadata.ci`, `pty.open` ya deniega en API. En `publishAgentTurn` / runner: `ptyAllowed: false` y **no** registrar MCP. Test unitario `gatePty({ ci: true, mode: "ask" })`. No abrir xterm. No añadir GitHub Action. No JSON schema.

- [ ] `cli/src/index.ts` usage: **no** añadir `chavez pty` (headless no tiene TTY de producto; TUI es el cliente). Opcional una línea en el help: `chavez tui` → tecla `t` abre PTY. No nuevo subcomando.

- [ ] En `api/openapi/openapi.yaml` descripción `/ws` **Tipos implementados**, añadir: `pty.open` (correlacionado), `pty.input`, `pty.resize`, `pty.close`, `pty.open.result`, `pty.data` (owner-only), `pty.exit`, `pty.attach`, `pty.kill.dispatch`. Nota: PTY corre en el cwd del daemon; CI no tiene PTY.

- [ ] Cursor: si `cli/src/llm/cursor-runner.ts` existe, **no** añadir un TTY Cursor. `gatePty` se reusa si Cursor emite un tool `Shell` interactivo — no reclasificar Shell como Pty. Comentario de una línea: `// PTY is Chavez MCP; Cursor Shell stays one-shot`.

- [ ] Commit:

```bash
git add cli/src/llm/watch-format.ts cli/src/commands/headless.ts \
  cli/src/ci cli/src/index.ts api/openapi/openapi.yaml cli/src/llm/cursor-runner.ts
git commit -m "feat(pty): redact persist, watch headline, CI exclusion, OpenAPI"
```

---

## Task 10: Tests Gherkin + smoke

**Files:**

- Test: `cli/src/pty/gherkin.test.ts`
- Create: `cli/scripts/pty-smoke.ts`
- Modify: `cli/package.json` (script `test` ya existe)

Fake backend + manager + gate cubren política; smoke live solo si `/dev/ptmx` existe. Cada escenario Gherkin tiene un `test()` con expect concreto.

- [ ] Crear `cli/src/pty/gherkin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createFakeBackend } from "./fake-backend";
import { PtyManager } from "./manager";
import { gatePty, isBashOneShot, isPtyTool } from "./gate";
import { persistPtyTranscript } from "./redact";
import { sanitizePtyEnv } from "./env";
import { formatPtyHeader } from "./display";
import {
  PTY_DENIED_AUTO,
  PTY_DENIED_CI,
  PTY_DENIED_PLAN,
  PTY_OWNER_GONE,
} from "./constants";

describe("Gherkin PTY", () => {
  test("Abrir PTY: cwd del daemon + hostname/path + redact persist", () => {
    const backend = createFakeBackend();
    const exits: string[] = [];
    const mgr = new PtyManager(backend, {
      onData() {},
      onExit(_id, info) {
        exits.push(info.transcript);
      },
    }, () => 1);
    const opened = mgr.open({
      kind: "user",
      ownerConnectionId: "web-1",
      cwd: "/home/me/proj",
    });
    expect(opened.cwd).toBe("/home/me/proj");
    expect(formatPtyHeader(opened.hostname, opened.cwd)).toContain("/home/me/proj");
    expect(formatPtyHeader(opened.hostname, opened.cwd)).toMatch(/^pty · /);
    backend.children[0]!.emitData("token sk-ant-secretvalue\n");
    void mgr.close(opened.ptyId);
    expect(exits[0] || persistPtyTranscript("sk-ant-secretvalue")).not.toContain("sk-ant-secretvalue");
    expect(sanitizePtyEnv({ CHAVEZ_ACCESS_TOKEN: "abc", PATH: "/bin" }).CHAVEZ_ACCESS_TOKEN).toBeUndefined();
  });

  test("El agente no toma el PTY por defecto: Bash one-shot aislado", () => {
    const backend = createFakeBackend();
    const userData: string[] = [];
    const mgr = new PtyManager(backend, {
      onData(id, chunk) {
        if (id === userId) userData.push(new TextDecoder().decode(chunk));
      },
      onExit() {},
    });
    const user = mgr.open({ kind: "user", ownerConnectionId: "tui", cwd: "/repo" });
    const userId = user.ptyId;
    expect(isBashOneShot("Bash")).toBe(true);
    expect(isPtyTool("Bash")).toBe(false);
    expect("bashOneShot" in mgr).toBe(false);
    // agent bash is NOT manager.open — simulate SDK bash as a different spawn
    const agent = mgr.open({
      kind: "agent",
      ownerConnectionId: "tui",
      cwd: "/repo",
      command: "echo hijack",
    });
    backend.children[1]!.emitData("hijack\n");
    expect(userData.join("")).not.toContain("hijack");
    expect(agent.ptyId).not.toBe(user.ptyId);
  });

  test("Comando interactivo vía tool: ask / auto / CI", () => {
    expect(gatePty({ mode: "ask" }).action).toBe("ask");
    expect(gatePty({ mode: "auto" })).toEqual({
      action: "deny",
      message: PTY_DENIED_AUTO,
    });
    expect(gatePty({ mode: "plan" }).message).toBe(PTY_DENIED_PLAN);
    expect(gatePty({ mode: "ask", ci: true }).message).toBe(PTY_DENIED_CI);
  });

  test("Cerrar: owner gone mata y no deja sesión", async () => {
    const backend = createFakeBackend();
    const mgr = new PtyManager(
      backend,
      { onData() {}, onExit() {} },
      () => 1,
    );
    const opened = mgr.open({ kind: "user", ownerConnectionId: "web-9", cwd: "/repo" });
    await mgr.ownerGone("web-9");
    expect(mgr.sessions.has(opened.ptyId)).toBe(false);
    expect(backend.children[0]!.killed.length).toBeGreaterThan(0);
    expect(backend.children[0]!.unrefCalled).toBe(false);
    expect(PTY_OWNER_GONE).toMatch(/owner disconnected/);
  });
});
```

Ajustar el test 1: `close` es async y el fake debe `emitExit` en `kill` para borrar la sesión. En `fake-backend`, `kill()` llama `emitExit(null, "SIGTERM")` por defecto para que `onExit` del manager limpie. El test de SIGKILL (Task 3) usa un flag `autoExitOnKill = false`.

- [ ] Crear `cli/scripts/pty-smoke.ts`:

```ts
/**
 * Smoke: PtyManager live if /dev/ptmx exists; always prints policy lines.
 */
import { existsSync } from "node:fs";
import { gatePty } from "../src/pty/gate";
import { formatPtyHeader } from "../src/pty/display";
import { nativePtyBackend, isPtyPlatformSupported } from "../src/pty/native";
import { PtyManager } from "../src/pty/manager";
import { PTY_DENIED_AUTO, PTY_DENIED_CI } from "../src/pty/constants";

if (gatePty({ mode: "auto" }).message !== PTY_DENIED_AUTO) process.exit(1);
if (gatePty({ mode: "ask", ci: true }).message !== PTY_DENIED_CI) process.exit(1);
console.log(formatPtyHeader("smoke-host", "/tmp/smoke"));

if (isPtyPlatformSupported() && existsSync("/dev/ptmx")) {
  const mgr = new PtyManager(nativePtyBackend, {
    onData() {},
    onExit() {},
  });
  const opened = mgr.open({
    kind: "agent",
    ownerConnectionId: "smoke",
    cwd: process.cwd(),
    command: "echo pty-smoke-ok",
  });
  await mgr.waitForExit(opened.ptyId, 8_000);
  await mgr.killAll("smoke");
  console.log("pty-terminal smoke ok", opened.hostname, opened.cwd);
} else {
  console.log("pty-terminal smoke ok (skip live ptmx)");
}
```

Añadir `waitForExit` en Task 6; si el smoke corre antes, usar `onExit` promise local en el script.

- [ ] En `cli/package.json` no hace falta script extra; documentar:

```bash
cd cli && bun test src/pty
bun run scripts/pty-smoke.ts
```

- [ ] Correr:

```bash
cd cli && bun test src/pty
cd api && bun test src/pty src/ws/pty-registry.test.ts
bun run cli/scripts/pty-smoke.ts
```

Esperado: matriz Gherkin verde; smoke imprime `pty-terminal smoke ok`.

- [ ] Commit:

```bash
git add cli/src/pty/gherkin.test.ts cli/scripts/pty-smoke.ts cli/package.json
git commit -m "test(pty): gherkin open/isolation/gate/close and smoke"
```

---

## Orden de ejecución

1. Task 1 (política pura) — no depende del SDK ni de xterm.
2. Task 2 (backend nativo + fake) — no depende de WS.
3. Task 3 (manager) — depende de 1–2.
4. Task 4 (API WS + onClose) — depende de constantes; no del native.
5. Task 5 (daemon/TUI handlers) — depende de 3–4.
6. Task 6 (MCP + canUseTool) — depende de 3 y de `decideCanUseTool` (crear mínimo si falta).
7. Task 7 (TUI UI) — depende de 5.
8. Task 8 (Web xterm) — depende de 4.
9. Task 9 (watch/CI/OpenAPI) — depende de 6.
10. Task 10 (Gherkin + smoke) — al final; Tasks 7 y 8 son paralelizables tras 5–6.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Abrir PTY en TUI o Web | Task 7 tecla `t`; Task 8 botón + `pty.open` |
| El PTY corre en el cwd del daemon | Task 5 `getCwd()` / `getEffectiveCwd()`; Task 10 header cwd |
| hostname/path se ven | Task 7/8 `formatPtyHeader`; open result `hostname` + `cwd` |
| ignore/secrets en lo persistido | Task 1 `persistPtyTranscript` + `sanitizePtyEnv`; Task 4/9 insert redactado |
| El agente no toma el PTY por defecto | Task 6 Bash sigue en `DEFAULT_CLAUDE_TOOLS`; `isPtyTool("Bash")===false`; Task 3/10 aislamiento de fds |
| Un turn usa bash one-shot | Task 6 `query` sin fds del user PTY; auto Bash no dispara `gatePty` |
| No secuestra el PTY del usuario | Task 3 dos sesiones; writes del agent no entran al user transcript |
| Modelo pide PTY → ask se aprueba | Task 6 `gatePty` ask + waiter + MCP `open({ kind: "agent" })` + `pty.attach` |
| En auto se rechaza | Task 1/6/10 `PTY_DENIED_AUTO`, cero spawn |
| En CI PTY no está | Task 6 MCP ausente; Task 4 `pty.open` → `PTY_DENIED_CI`; Task 9 runner `ptyAllowed: false` |
| Al cerrar Web/TUI el PTY termina | Task 4 `onClose` → `pty.kill.dispatch`; Task 5 `killAll`; Task 7/8 unmount/`ctrl+x` |
| No queda proceso huérfano sin política | Task 2 process group SIGTERM/SIGKILL; `detached: false`; nunca `unref`; idle; owner gone |

## Fuera de este plan (no implementar)

- Cursor cloud, voz, extensión IDE, upload desde el navegador.
- Notificaciones OS/email → [notifications](../notifications/plan.md) (in-app ya cubre tool pty si el plan 24 pinta `chat.tool.*`).
- Cola de turns → [turn-queue](../turn-queue/plan.md).
- Worktrees paralelos → [worktree-cwd](../worktree-cwd/plan.md) solo aporta `getEffectiveCwd()`; PTY no abre un segundo daemon.
- Sandbox de red del bash one-shot → [sandbox-network](../sandbox-network/plan.md). User PTY es el shell del humano (red permitida); agent PTY solo existe en ask ya aprobado.
- Multiplexor tmux, grabación asciinema, compartir TTY entre dos browsers.
- PTY en Windows (`PTY_UNSUPPORTED`).
- Slash `/pty` → si se quiere después, [slash-commands](../slash-commands/plan.md); esta fase usa tecla `t` y botón Web.
- JSON schema de CI / GitHub Action → [ci-headless](../ci-headless/plan.md) (PTY ausente).
