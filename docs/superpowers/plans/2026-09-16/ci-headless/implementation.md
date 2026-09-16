# CI Headless Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement GitHub Action, JSON schema de resultado, Cursor cloud, voz, extensión IDE, upload desde el navegador, PTY (plan 27), cola eterna (plan 29: reutilizar `--no-queue` si ya existe), sandbox de red (plan 26), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Depende del dispatch `agent.turn.request` → daemon (`cli/src/ws/daemon.ts` / TUI), de modos ([`execution-modes`](../execution-modes/implementation.md)), tools ([`agent-tools`](../agent-tools/implementation.md)), aprobaciones ([`approvals`](../approvals/implementation.md): **no** auto-aprobar), verification ([`verification-loop`](../verification-loop/implementation.md): `metadata.verification.status` ∈ `failed`|`timeout` → exit ≠ 0) y redacción ([`invariants`](../invariants/implementation.md) / [`ignore-secrets`](../ignore-secrets/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** Un pipeline corre un turn **no interactivo** y termina con **exit 0 o ≠ 0** más un **log de texto** (tools + assistant). Sin TTY no se abre la TUI ni se piden secrets por `prompt()`. Modo `ask` no espera un humano: sale ≠ 0 con `ask no válido en no-interactivo`, salvo que el invocador pase `--mode auto` (o las prefs ya sean `auto`/`plan`). El log **no** contiene vault ni API keys. No hay JSON schema ni GitHub Action.

**Architecture:** El filesystem y el LLM viven en el proceso que hace de daemon: o bien un daemon ya bound al cwd (`chavez headless workspace open` / TUI), o el **runner de CI in-process** (`chavez ci`) que se bindea `clientKind: "daemon"`, corre **un** turn y se cierra. La API **no** ejecuta el agente: persiste, hace fan-out, y si `metadata.ci === true` y el modo persistido es `ask`, rechaza el request **antes** de despachar. El CLI narra el mismo contrato de tools/stream que `chat watch` (texto, no JSON). Web y TUI, si están abiertas, ven el mismo chat en vivo.

```
CI=true | CHAVEZ_CI=1 | stdout.isTTY===false | --ci
        |
        v
chavez ci --mode auto "<prompt>"
  |  sin token (env ~/.chavez o CHAVEZ_ACCESS_TOKEN) → exit 1 NO_SESSION_CI
  |  provider link / login / tui                     → bloqueados (no prompt, no Ink)
  |  modo ask (flag o prefs)                         → exit 2 ASK_CI_INVALID
        |
        +-- daemon vivo en cwd (otro pid) --> bind client + agent.turn.request
        |                                     wait chat.stream.end|error|turn.ended
        |
        +-- si no --> bind daemon in-process (cwd = process.cwd())
                      session/chat efímeros (salvo --chat)
                      publishAgentTurn  (1 turn; no detached)
        |
        v
  stdout  tool · <name> · <status>
          assistant: …
          ci ok
  stderr  ci fail: <motivo>   (redactado)
        |
        v
  0  stream.end + verification no failed/timeout + sin provider/stream error
  2  ASK_CI_INVALID
  1  cualquier otro fallo (incluye tests pactados en rojo)
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/commands/headless.ts` `chat ask` manda `agent.turn.request` (timeout RPC 30s), imprime `JSON.stringify(res.data)` y **sale 0** con `"Turn aceptado por el daemon. Usa chat watch…"`. **No** espera `stream.end`. **No** hay `--ci` ni `--mode` en el árbol actual (el plan 3 añade `--mode`; si ya está, **extenderlo**).
- `cli/src/ws/daemon.ts` es un proceso **detached** (`proc.unref()`, `stdin: "ignore"`). El CI **no** debe dejar un daemon huérfano: el runner in-process se cierra en `finally`.
- `cli/src/index.ts` `chavez tui` hace `Bun.spawn` de Ink **siempre**, sin mirar TTY. `tui/src/index.tsx` es `render(<App />)` a ciegas.
- `cli/src/commands/provider.ts` `promptSecret` usa `prompt()`. `login.ts` abre browser + poll de device-code (cuelga en CI hasta `expires_in`).
- `cli/src/config.ts` ya lee `CHAVEZ_ACCESS_TOKEN` / `CHAVEZ_API_URL`. Ese es el auth de CI. **No** hay `isTTY` en el repo.
- `cli/src/llm/publish-turn.ts` corre Claude, emite stream/tools, **no** estampa `metadata.ci`, **no** calcula exit code. El secret de `GET /providers/claude/credentials` solo debe ir al SDK.
- `api/src/ws/handlers.ts` `agent.turn.request` exige daemon (`NO_DAEMON_ERROR`) y despacha. **No** mira modo ni `metadata.ci`.
- `user_preferences.activeExecutionMode` lo añade el plan 3. Si **no** existe, `null` **no** se trata como `ask` en la API (evita bloquear CI antes de plan 3). El CLI exige `--mode auto` cuando las prefs son `ask`.
- `cli/src/llm/watch-format.ts` (`formatWatchLine`) lo crea el plan 2. Si existe, el log de CI lo reusa; si no, Task 2 trae un formatter mínimo.
- `cli/src/llm/redact.ts` / `api/src/lib/redact.ts` los crea el plan 5. Si existen, Task 2 los importa; si no, `cli/src/ci/redact-log.ts` trae los mismos `PATTERNS` (keep-in-sync).
- `cli/src/queue/admission.ts` `isNonInteractive` lo crea el plan 29. Si existe, Task 1 **reexporta** (mismos `CI` / `CHAVEZ_CI` / `isTTY`); no inventar otra semántica.
- Cursor `runnable: false` hasta el plan 4. Un CI con provider Cursor activo falla con el error existente de `publish-turn` (`Provider activo "cursor" no ejecuta…`) → exit 1, log con el motivo. **No** simular un turn Cursor.
- `cli/package.json`, `api/package.json`, `tui/package.json`, `web/package.json` **no** tienen `"test": "bun test"` (añadirlo si falta).

**Tech Stack:** Bun (`process.stdout.isTTY`, `Bun.spawn` solo para el TUI que **no** se lanza), Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva, **sin** migración), Claude Agent SDK vía `publishAgentTurn` existente, Ink TUI (guard **antes** de `render`), Astro/React web (copy). Tests: `bun test`. Web y API **no** importan CLI: duplicar `ASK_CI_INVALID` (comentario keep-in-sync). TUI importa `cli/src/ci/detect.ts`.

**Global Constraints:**

1. El filesystem real vive en el daemon / runner de CI (cwd del workspace). API y browser no leen disco ni ejecutan el turn.
2. Un turn solo corre si hay daemon bound. `chavez ci` **es** ese daemon cuando no hay otro pid vivo. Sin token y sin daemon y sin runner: error claro, exit ≠ 0. No queda un proceso detached.
3. Web, CLI `watch` y TUI ven el **mismo** chat (el runner publica `chat.append` / `chat.stream.*` / `chat.tool.*` por WS). El log de CI es texto; `watch` puede seguir volcando JSON — el path CI **no**.
4. Provider, modelo, esfuerzo y **modo** se leen de preferencias. `--mode auto|plan` hace PUT **antes** del turn (si el endpoint del plan 3 existe). El daemon no usa un default local distinto.
5. Claude es el ejecutable. Cursor vinculado no ejecuta; el fallo es el string existente, exit 1.
6. Tools por defecto corren en `auto` sobre el cwd. Lecturas no piden confirmación. En CI **no** hay aprobaciones: `ask` se rechaza **antes** de `canUseTool`.
7. Aprobaciones una a una (plan 13): el runner **nunca** llama `resolveApproval(..., "approve")`. `HEADLESS_WAITING` no aplica porque el turn ni arranca en `ask`.
8. 1 turn por daemon. CI no abre un segundo turn. Si el daemon está busy: reutilizar `QUEUE_CI_BUSY` / `--no-queue` si el plan 29 existe; si no, el fail existente `"Turn already running on this daemon"` o el log `"turn already running — ignoring dispatch"` → exit 1 `CI_BUSY`. **No** encolar para siempre.
9. Un usuario = su vault. Auth de CI = Bearer ya emitido (`CHAVEZ_ACCESS_TOKEN` o `~/.chavez/config.json`). Sin org.
10. Verification (plan 20): `metadata.verification.status` ∈ `failed` | `timeout` → exit 1 aunque haya `stream.end` y texto del assistant. `skipped` / ausente **no** falla el proceso.
11. Un `tool · bash · error` **no** es exit 1 por sí solo (el modelo puede recuperarse). Fatal = `chat.stream.error`, throw de provider, timeout del turn, o verification failed/timeout.
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, GitHub Action (cero archivos en `.github/workflows` por esta fase), JSON schema del log, PTY, notificaciones OS/email.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `ASK_CI_INVALID` | `"ask no válido en no-interactivo"` |
| `TUI_NO_TTY` | `"No TTY: TUI no se abre en no-interactivo. Usa: chavez ci --mode auto \"<prompt>\""` |
| `NO_SECRET_PROMPT` | `"No se piden secrets por prompt en no-interactivo. Usa un vault ya linked o CHAVEZ_ACCESS_TOKEN."` |
| `NO_LOGIN_PROMPT` | `"No hay sesión. En no-interactivo usa CHAVEZ_ACCESS_TOKEN (vault ya linked). No se pide login por prompt."` |
| `NO_SESSION_CI` | `"No hay sesión. En no-interactivo usa CHAVEZ_ACCESS_TOKEN (vault ya linked). No se pide login por prompt."` |
| `CI_OK_LINE` | `"ci ok"` |
| `CI_FAIL_PREFIX` | `"ci fail: "` |
| `CI_TIMEOUT` | `"CI turn timed out"` |
| `CI_BUSY` | `"Daemon busy — not queued (CI / --no-queue). Retry or pass --wait-timeout"` |
| `CI_SESSION_TITLE` | `"CI"` |
| `CI_TURN_TIMEOUT_MS` | `600_000` |
| `CI_TURN_TIMEOUT_MAX_MS` | `1_800_000` |
| `CI_EXIT_OK` | `0` |
| `CI_EXIT_FAIL` | `1` |
| `CI_EXIT_ASK` | `2` |
| `CI_SOURCE` | `"ci"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` (reusar literal; `chavez ci` no lo dispara porque él mismo se bindea) |
| `REDACT_REPLACEMENT` | `"***"` |
| `CI_HUB_HINT` | `"CI: CHAVEZ_ACCESS_TOKEN=… chavez ci --mode auto \"<prompt>\"  → exit 0/≠0, log texto. Sin GitHub Action."` |
| `CI_USAGE` | `"Uso: chavez ci [--mode auto|plan] [--chat <chatId>] [--timeout <ms>] [--ci] <prompt…>"` |

Si `QUEUE_CI_BUSY` ya existe en el plan 29, **usar esa** y `CI_BUSY = QUEUE_CI_BUSY`. No cambiar el string.

Si `NO_DAEMON_ERROR` ya existe, importarla; no duplicar un literal distinto.

Tipos (congelados):

```ts
export type CiExitCode = 0 | 1 | 2;

export type CiTurnOutcome = {
  finished: boolean;
  streamEnd: boolean;
  streamError: string | null;
  providerError: string | null;
  timedOut: boolean;
  busy: boolean;
  askRejected: boolean;
  verificationStatus: "failed" | "timeout" | "passed" | "skipped" | null;
  assistantText: string;
};

export type CiEvent =
  | { kind: "tool"; name: string; status: string; output?: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "stream_end"; content?: string; verificationStatus?: CiTurnOutcome["verificationStatus"] }
  | { kind: "stream_error"; error: string }
  | { kind: "turn_ended"; status?: string }
  | { kind: "provider_error"; error: string }
  | { kind: "busy" }
  | { kind: "timeout" };
```

Nombres de events WS (ninguno nuevo de protocolo; `metadata.ci` viaja en el request existente):

| Tipo | Dirección | Semántica extra en esta fase |
|---|---|---|
| `agent.turn.request` | CLI → API | `metadata.ci: true` en no-interactivo. Si prefs `activeExecutionMode === "ask"` → fail `ASK_CI_INVALID` **sin** dispatch. |
| `agent.turn.dispatch` | API → daemon | Igual que hoy. El runner in-process también puede **saltar** el request y llamar `publishAgentTurn` (sigue emitiendo stream/tools). |
| `chat.stream.end` | daemon → API → broadcast | Turn ok a nivel stream. CI mira `metadata.verification`. |
| `chat.stream.error` | daemon → API → broadcast | Exit 1. Motivo al log (redactado). |
| `agent.turn.ended` | daemon → API → broadcast | Cierra el waiter de CI si el plan 2 ya lo emite; si no, basta `stream.end`/`error`. |

HTTP: ninguno nuevo. Cero `.github/workflows`. Cero schema JSON del log.

---

## Task 1: Módulos puros — detect, args, outcome, exit

**Files:**

- Create: `cli/src/ci/constants.ts`
- Create: `cli/src/ci/types.ts`
- Create: `cli/src/ci/detect.ts`
- Create: `cli/src/ci/args.ts`
- Create: `cli/src/ci/outcome.ts`
- Create: `cli/src/ci/errors.ts`
- Test: `cli/src/ci/detect.test.ts`
- Test: `cli/src/ci/args.test.ts`
- Test: `cli/src/ci/outcome.test.ts`
- Create: `api/src/ci/constants.ts`
- Test: `api/src/ci/constants.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`

Sin I/O de red ni disco. TUI importa `detect.ts`. API **no** importa CLI: duplicar constantes (keep-in-sync en la primera línea).

- [ ] Añadir `"test": "bun test"` en `cli/package.json` y `api/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`db:*`/`test:e2e` intactos):

```json
"test": "bun test"
```

- [ ] Crear `cli/src/ci/constants.ts`:

```ts
/** keep-in-sync: api/src/ci/constants.ts */

export const ASK_CI_INVALID = "ask no válido en no-interactivo";
export const TUI_NO_TTY =
  'No TTY: TUI no se abre en no-interactivo. Usa: chavez ci --mode auto "<prompt>"';
export const NO_SECRET_PROMPT =
  "No se piden secrets por prompt en no-interactivo. Usa un vault ya linked o CHAVEZ_ACCESS_TOKEN.";
export const NO_LOGIN_PROMPT =
  "No hay sesión. En no-interactivo usa CHAVEZ_ACCESS_TOKEN (vault ya linked). No se pide login por prompt.";
export const NO_SESSION_CI = NO_LOGIN_PROMPT;
export const CI_OK_LINE = "ci ok";
export const CI_FAIL_PREFIX = "ci fail: ";
export const CI_TIMEOUT = "CI turn timed out";
export const CI_BUSY =
  "Daemon busy — not queued (CI / --no-queue). Retry or pass --wait-timeout";
export const CI_SESSION_TITLE = "CI";
export const CI_TURN_TIMEOUT_MS = 600_000;
export const CI_TURN_TIMEOUT_MAX_MS = 1_800_000;
export const CI_EXIT_OK = 0;
export const CI_EXIT_FAIL = 1;
export const CI_EXIT_ASK = 2;
export const CI_SOURCE = "ci";
export const CI_HUB_HINT =
  'CI: CHAVEZ_ACCESS_TOKEN=… chavez ci --mode auto "<prompt>"  → exit 0/≠0, log texto. Sin GitHub Action.';
export const CI_USAGE =
  "Uso: chavez ci [--mode auto|plan] [--chat <chatId>] [--timeout <ms>] [--ci] <prompt…>";
```

Si `cli/src/queue/constants.ts` (plan 29) ya exporta `QUEUE_CI_BUSY` con el **mismo** literal, `CI_BUSY` reexporta esa constante. No cambiar el texto.

- [ ] Crear `api/src/ci/constants.ts` con **solo** lo que la API necesita:

```ts
/** keep-in-sync: cli/src/ci/constants.ts */

export const ASK_CI_INVALID = "ask no válido en no-interactivo";
export const CI_SOURCE = "ci";
```

Test: ambos archivos exportan el mismo string `ASK_CI_INVALID`.

- [ ] Crear `cli/src/ci/errors.ts`:

```ts
import { ASK_CI_INVALID, CI_EXIT_ASK, CI_EXIT_FAIL } from "./constants";

export class CiCliError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2 = CI_EXIT_FAIL) {
    super(message);
    this.name = "CiCliError";
    this.exitCode = exitCode;
  }
}

export function askCiError(): CiCliError {
  return new CiCliError(ASK_CI_INVALID, CI_EXIT_ASK);
}
```

- [ ] Crear `cli/src/ci/detect.ts`. Si `cli/src/queue/admission.ts` ya exporta `isNonInteractive` con la misma semántica, reexportarla y **añadir** `flagCi` / `stdin` solo en wrappers locales (no cambiar la función del plan 29). Si no existe, definirla aquí:

```ts
export function isNonInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  const ci = env.CI;
  if (ci === "1" || ci === "true" || env.CHAVEZ_CI === "1") return true;
  return stdout.isTTY === false;
}

export function isSecretPromptForbidden(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  if (isNonInteractive(env, stdout)) return true;
  return stdin.isTTY === false;
}

export function isTuiForbidden(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  if (isNonInteractive(env, stdout)) return true;
  return stdin.isTTY === false || stdout.isTTY === false;
}
```

- [ ] Crear `cli/src/ci/args.ts`:

```ts
import { CI_TURN_TIMEOUT_MAX_MS, CI_TURN_TIMEOUT_MS, CI_USAGE } from "./constants";
import { CiCliError } from "./errors";

export type ParsedCiArgs = {
  prompt: string;
  chatId: string | null;
  sessionId: string | null;
  modeFlag: "auto" | "plan" | "ask" | undefined;
  timeoutMs: number;
  forceCi: boolean;
  readStdin: boolean;
};

function capTimeout(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return CI_TURN_TIMEOUT_MS;
  return Math.min(raw, CI_TURN_TIMEOUT_MAX_MS);
}

export function parseCiArgs(argv: string[]): ParsedCiArgs {
  let chatId: string | null = null;
  let sessionId: string | null = null;
  let modeFlag: ParsedCiArgs["modeFlag"];
  let timeoutMs = CI_TURN_TIMEOUT_MS;
  let forceCi = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ci") {
      forceCi = true;
      continue;
    }
    if (a === "--mode") {
      const v = argv[++i];
      if (v !== "auto" && v !== "plan" && v !== "ask") {
        throw new CiCliError("executionMode must be plan, auto, or ask");
      }
      modeFlag = v;
      continue;
    }
    if (a.startsWith("--mode=")) {
      const v = a.slice("--mode=".length);
      if (v !== "auto" && v !== "plan" && v !== "ask") {
        throw new CiCliError("executionMode must be plan, auto, or ask");
      }
      modeFlag = v;
      continue;
    }
    if (a === "--chat") {
      chatId = argv[++i] || null;
      continue;
    }
    if (a.startsWith("--chat=")) {
      chatId = a.slice("--chat=".length) || null;
      continue;
    }
    if (a === "--session") {
      sessionId = argv[++i] || null;
      continue;
    }
    if (a.startsWith("--session=")) {
      sessionId = a.slice("--session=".length) || null;
      continue;
    }
    if (a === "--timeout") {
      timeoutMs = capTimeout(Number(argv[++i]));
      continue;
    }
    if (a.startsWith("--timeout=")) {
      timeoutMs = capTimeout(Number(a.slice("--timeout=".length)));
      continue;
    }
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    positional.push(a);
  }

  const joined = positional.join(" ").trim();
  const readStdin = joined === "-" || joined === "";
  return {
    prompt: joined === "-" ? "" : joined,
    chatId,
    sessionId,
    modeFlag,
    timeoutMs,
    forceCi,
    readStdin: joined === "-" || (joined === "" && positional.length === 0),
  };
}

export function assertCiUsage(args: ParsedCiArgs, prompt: string): void {
  if (!prompt.trim()) throw new CiCliError(CI_USAGE);
}
```

Si el plan 3 ya exporta `INVALID_MODE_ERROR` (`"executionMode must be plan, auto, or ask"`), **usar esa** constante en el throw de `--mode` inválido.

- [ ] En el mismo archivo `cli/src/ci/args.ts`, añadir `resolveCiMode` (importar `ASK_CI_INVALID` arriba):

```ts
import { ASK_CI_INVALID } from "./constants";

export type CiResolvedMode =
  | { ok: true; mode: "auto" | "plan"; putPrefs: boolean }
  | { ok: false; error: typeof ASK_CI_INVALID };

function asMode(v: unknown): "auto" | "plan" | "ask" | "unset" {
  if (v === "auto" || v === "plan" || v === "ask") return v;
  return "unset";
}

export function resolveCiMode(input: {
  flag?: "auto" | "plan" | "ask";
  envMode?: string;
  prefsMode?: unknown;
}): CiResolvedMode {
  if (input.flag === "ask") return { ok: false, error: ASK_CI_INVALID };
  if (input.flag === "auto" || input.flag === "plan") {
    return { ok: true, mode: input.flag, putPrefs: true };
  }
  const envMode = asMode(input.envMode);
  if (envMode === "ask") return { ok: false, error: ASK_CI_INVALID };
  if (envMode === "auto" || envMode === "plan") {
    return { ok: true, mode: envMode, putPrefs: true };
  }
  const prefs = asMode(input.prefsMode);
  if (prefs === "ask") return { ok: false, error: ASK_CI_INVALID };
  if (prefs === "auto" || prefs === "plan") {
    return { ok: true, mode: prefs, putPrefs: false };
  }
  // plan 3 no aterrizó: tools hoy = bypass ≈ auto. No tratar null como ask.
  return { ok: true, mode: "auto", putPrefs: false };
}
```

`envMode` se lee de `process.env.CHAVEZ_EXECUTION_MODE` en el caller, no dentro de la función pura (el test pasa el string).

- [ ] Crear `cli/src/ci/types.ts` con los tipos congelados del header (`CiTurnOutcome`, `CiEvent`, `CiExitCode`).

- [ ] Crear `cli/src/ci/outcome.ts`:

```ts
import {
  ASK_CI_INVALID,
  CI_BUSY,
  CI_EXIT_ASK,
  CI_EXIT_FAIL,
  CI_EXIT_OK,
  CI_TIMEOUT,
} from "./constants";
import type { CiEvent, CiExitCode, CiTurnOutcome } from "./types";

export type { CiEvent, CiExitCode, CiTurnOutcome };

export function emptyOutcome(): CiTurnOutcome {
  return {
    finished: false,
    streamEnd: false,
    streamError: null,
    providerError: null,
    timedOut: false,
    busy: false,
    askRejected: false,
    verificationStatus: null,
    assistantText: "",
  };
}

export function foldCiEvents(
  events: CiEvent[],
  base: CiTurnOutcome = emptyOutcome(),
): CiTurnOutcome {
  const out: CiTurnOutcome = { ...base, assistantText: base.assistantText };
  for (const ev of events) {
    if (ev.kind === "assistant_delta") out.assistantText += ev.text;
    if (ev.kind === "stream_end") {
      out.streamEnd = true;
      out.finished = true;
      if (ev.content) out.assistantText = out.assistantText || ev.content;
      if (ev.verificationStatus) out.verificationStatus = ev.verificationStatus;
    }
    if (ev.kind === "stream_error") {
      out.streamError = ev.error;
      out.finished = true;
    }
    if (ev.kind === "turn_ended") {
      out.finished = true;
    }
    if (ev.kind === "provider_error") {
      out.providerError = ev.error;
      out.finished = true;
    }
    if (ev.kind === "busy") out.busy = true;
    if (ev.kind === "timeout") {
      out.timedOut = true;
      out.finished = true;
    }
  }
  return out;
}

export function ciExitCode(outcome: CiTurnOutcome): CiExitCode {
  if (outcome.askRejected) return CI_EXIT_ASK;
  if (outcome.timedOut) return CI_EXIT_FAIL;
  if (outcome.busy && !outcome.streamEnd) return CI_EXIT_FAIL;
  if (outcome.providerError) return CI_EXIT_FAIL;
  if (outcome.streamError) return CI_EXIT_FAIL;
  if (
    outcome.verificationStatus === "failed" ||
    outcome.verificationStatus === "timeout"
  ) {
    return CI_EXIT_FAIL;
  }
  if (outcome.streamEnd) return CI_EXIT_OK;
  return CI_EXIT_FAIL;
}

export function ciFailReason(outcome: CiTurnOutcome): string {
  if (outcome.askRejected) return ASK_CI_INVALID;
  if (outcome.timedOut) return CI_TIMEOUT;
  if (outcome.busy && !outcome.streamEnd) return CI_BUSY;
  if (outcome.providerError) return outcome.providerError;
  if (outcome.streamError) return outcome.streamError;
  if (outcome.verificationStatus === "failed") {
    return "verification failed";
  }
  if (outcome.verificationStatus === "timeout") {
    return "verification timed out";
  }
  if (!outcome.finished || !outcome.streamEnd) {
    return "turn did not finish";
  }
  return "";
}
```

`outcome.ts` reexporta los tipos desde `./types`.

- [ ] Tests `cli/src/ci/detect.test.ts`:

  1. `{ CI: "true" }` → `isNonInteractive` true aunque `stdout.isTTY === true`.
  2. `{ CI: "1" }` → true.
  3. `{ CHAVEZ_CI: "1" }` → true.
  4. env vacío + `stdout.isTTY === false` → true.
  5. env vacío + `stdout.isTTY === true` → false.
  6. `isTuiForbidden` true si `stdin.isTTY === false` aunque stdout sea TTY.
  7. `isSecretPromptForbidden` true con `CI=true`.

- [ ] Tests `cli/src/ci/args.test.ts`:

  1. `["--mode", "auto", "fix tests"]` → `modeFlag: "auto"`, prompt `"fix tests"`.
  2. `["--mode=plan", "--chat", "c1", "hello"]` → chat `c1`, mode `plan`.
  3. `["--mode", "ask", "x"]` parsea (el reject es `resolveCiMode`, no el parser).
  4. `["--timeout", "5000", "p"]` → `timeoutMs: 5000`.
  5. `["--timeout", "999999999", "p"]` → cap `CI_TURN_TIMEOUT_MAX_MS`.
  6. `["--ci", "-"]` → `forceCi: true`, `readStdin: true`.
  7. `resolveCiMode({ flag: "ask" }).ok === false` y `error === ASK_CI_INVALID`.
  8. `resolveCiMode({ flag: "auto" })` → `{ mode: "auto", putPrefs: true }`.
  9. `resolveCiMode({ prefsMode: "ask" })` → fail `ASK_CI_INVALID`.
  10. `resolveCiMode({ prefsMode: "auto" })` → `{ mode: "auto", putPrefs: false }`.
  11. `resolveCiMode({ prefsMode: null })` → `{ mode: "auto", putPrefs: false }` (plan 3 ausente).
  12. `resolveCiMode({ envMode: "auto", prefsMode: "ask" })` → auto gana (env es explícito), `putPrefs: true`.
  13. `resolveCiMode({ flag: "plan", prefsMode: "ask" })` → plan (flag gana).

- [ ] Tests `cli/src/ci/outcome.test.ts`:

  1. `stream_end` sin verification → exit 0, reason `""`.
  2. `stream_error` `{ error: "Claude no está vinculado — chavez provider link claude" }` → exit 1, reason incluye ese string.
  3. `stream_end` + `verificationStatus: "failed"` → exit 1, reason `"verification failed"`.
  4. `stream_end` + `verificationStatus: "timeout"` → exit 1.
  5. `stream_end` + `verificationStatus: "skipped"` → exit 0.
  6. tool events `status: "error"` **sin** stream_error **con** stream_end → exit 0 (no fatal).
  7. `timeout` → exit 1, `CI_TIMEOUT`.
  8. `askRejected` → exit 2, `ASK_CI_INVALID`.
  9. `provider_error` → exit 1.
  10. `busy` sin stream_end → exit 1, `CI_BUSY`.
  11. Deltas concatenados en `assistantText`.

- [ ] Test `api/src/ci/constants.test.ts`: `ASK_CI_INVALID === "ask no válido en no-interactivo"`.

- [ ] Correr:

```bash
cd cli && bun test src/ci/detect.test.ts src/ci/args.test.ts src/ci/outcome.test.ts
cd api && bun test src/ci/constants.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/ci cli/package.json api/src/ci api/package.json
git commit -m "feat(ci): detect non-interactive, parse args, freeze exit codes"
```

---

## Task 2: Log texto + redacción (sin vault, sin JSON schema)

**Files:**

- Create: `cli/src/ci/redact-log.ts`
- Create: `cli/src/ci/format.ts`
- Test: `cli/src/ci/redact-log.test.ts`
- Test: `cli/src/ci/format.test.ts`

El log de CI es **texto**. No se imprime el envelope JSON de `chat watch`. Cada línea pasa por `redactCiLog` **antes** de `stdout.write` / `stderr.write`.

- [ ] Crear `cli/src/ci/redact-log.ts`. Si `cli/src/llm/redact.ts` existe, importar `redactText` / `REDACT_REPLACEMENT`. Si no, copiar los `PATTERNS` del plan 5 (keep-in-sync en un comentario) **y** añadir extras de CI:

```ts
/** keep-in-sync PATTERNS: cli/src/llm/redact.ts, api/src/lib/redact.ts */

export const REDACT_REPLACEMENT = "***";

const KEY_NAME =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token)$/i;

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._\-]+/g,
];

function redactTextLocal(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  return out;
}

export function redactCiLog(
  input: string,
  extras: Array<string | undefined | null> = [],
): string {
  let out = redactTextLocal(input);
  for (const secret of extras) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACT_REPLACEMENT);
  }
  return out;
}

export function collectCiSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const k of [
    "CHAVEZ_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CURSOR_API_KEY",
  ]) {
    const v = env[k];
    if (v && v.length >= 8) out.push(v);
  }
  return out;
}
```

Si se importa `redactText` del plan 5, `redactCiLog` hace `redactText(input)` **y después** sustituye `extras` y `Bearer …`. No quitar patrones del sibling.

- [ ] Crear `cli/src/ci/format.ts`. Si `cli/src/llm/watch-format.ts` `formatWatchLine` existe, usarla y **después** redactar. Si no, formatter mínimo:

```ts
import { CI_FAIL_PREFIX, CI_OK_LINE } from "./constants";
import { ciExitCode, ciFailReason } from "./outcome";
import { collectCiSecrets, redactCiLog } from "./redact-log";
import type { CiTurnOutcome } from "./types";

export type CiLogLine = { stream: "stdout" | "stderr"; text: string };

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function formatCiPushRaw(msg: { type: string; data?: unknown }): string | null {
  const data = rec(msg.data) ?? {};
  if (msg.type === "chat.tool.start") {
    const message = rec(data.message);
    const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
    const name = String(meta.toolName || data.toolName || "tool").toLowerCase();
    return `tool · ${name} · ${String(meta.status || "running")}`;
  }
  if (msg.type === "chat.tool.result" || msg.type === "chat.tool.update") {
    const message = rec(data.message);
    const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
    const name = String(meta.toolName || data.toolName || "tool").toLowerCase();
    const status = String(meta.status || data.status || "done");
    const output = String(meta.output ?? message?.content ?? "");
    if (status === "error" && output) {
      return `tool · ${name} · ${status}\n${output.slice(0, 500)}`;
    }
    return `tool · ${name} · ${status}`;
  }
  if (msg.type === "chat.stream.delta") {
    const delta = String(data.delta ?? data.content ?? "");
    if (!delta) return null;
    return `assistant Δ ${delta.slice(0, 400)}`;
  }
  if (msg.type === "chat.stream.end") return "stream end";
  if (msg.type === "chat.stream.error") {
    return `stream error  ${String(data.error ?? data.content ?? "")}`;
  }
  if (msg.type === "agent.turn.started") return "turn started";
  if (msg.type === "agent.turn.ended") return "turn ended";
  return null;
}

export function formatCiPush(msg: { type: string; data?: unknown }): string | null {
  const raw = formatCiPushRaw(msg);
  if (!raw) return null;
  return redactCiLog(raw, collectCiSecrets());
}

export function formatCiOutcome(outcome: CiTurnOutcome): CiLogLine {
  const code = ciExitCode(outcome);
  if (code === 0) return { stream: "stdout", text: CI_OK_LINE };
  const reason = redactCiLog(ciFailReason(outcome), collectCiSecrets());
  return { stream: "stderr", text: `${CI_FAIL_PREFIX}${reason}` };
}

export function printCiLine(
  stream: "stdout" | "stderr",
  text: string,
  extras: string[] = collectCiSecrets(),
): void {
  const line = redactCiLog(text, extras);
  if (stream === "stderr") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}
```

Si `cli/src/llm/watch-format.ts` existe, `formatCiPushRaw` delega en `formatWatchLine` y después se redacta igual.

**Prohibido** en el path CI: `JSON.stringify(msg)` del envelope completo (puede meter `metadata.input` con tokens). El formatter solo pinta name/status/output ya recortado.

- [ ] Tests `cli/src/ci/redact-log.test.ts`:

  1. `redactCiLog("sk-ant-api03-aaaa")` → no contiene `sk-ant-`. Es `***` (o contiene `***`).
  2. `redactCiLog("Authorization: Bearer abcdefghijklmnop")` no contiene `abcdefghijklmnop`.
  3. `redactCiLog("token ghp_secretsecretsecret")` no contiene `ghp_`.
  4. `redactCiLog("hello src/auth.ts")` === `"hello src/auth.ts"`.
  5. `redactCiLog("leak "+secret, [secret])` con `secret = "tok_12345678"` no contiene `tok_12345678`.
  6. `collectCiSecrets({ CHAVEZ_ACCESS_TOKEN: "tok_12345678" })` incluye ese valor; `redactCiLog` con esos extras lo borra.
  7. Un ciphertext / `oauth_token` de 40 chars se sustituye si se pasa en extras (el runner pasará `creds.secret` si alguna vez llega a un catch).

- [ ] Tests `cli/src/ci/format.test.ts`:

  1. `chat.tool.start` → línea que incluye `tool ·` y **no** es JSON (`{` no es el primer char).
  2. `chat.stream.delta` `{ delta: "Hola" }` → incluye `assistant` y `Hola`.
  3. `chat.stream.error` con `sk-ant-api03-aaaa` en el error → la línea **no** contiene `sk-ant-`.
  4. `formatCiOutcome(streamEnd)` → `{ stream: "stdout", text: "ci ok" }`.
  5. `formatCiOutcome(askRejected)` → stderr, texto incluye `ask no válido en no-interactivo`.
  6. `formatCiOutcome(verification failed)` → stderr, empieza por `ci fail:`.
  7. Un push cuyo `data` incluye `{ api_key: "sk-ant-api03-zzzz" }` **no** deja `sk-ant-` en `formatCiPush`.

- [ ] Correr:

```bash
cd cli && bun test src/ci/redact-log.test.ts src/ci/format.test.ts
```

Esperado: todos pasan. Cero JSON schema. Cero keys crudas.

- [ ] Commit:

```bash
git add cli/src/ci/redact-log.ts cli/src/ci/redact-log.test.ts \
  cli/src/ci/format.ts cli/src/ci/format.test.ts
git commit -m "feat(ci): text log with redacted vault keys"
```

---

## Task 3: Sin TTY — no TUI, no prompt de secrets, no login interactivo

**Files:**

- Create: `cli/src/ci/guards.ts`
- Test: `cli/src/ci/guards.test.ts`
- Modify: `cli/src/commands/login.ts`
- Modify: `cli/src/commands/provider.ts`
- Modify: `cli/src/index.ts`
- Modify: `tui/src/index.tsx`
- Modify: `tui/package.json`

Gherkin: *Sin TTY → no abre TUI y no pide secrets por prompt (solo env/vault ya linked)*.

- [ ] Añadir `"test": "bun test"` en `tui/package.json` si falta.

- [ ] Crear `cli/src/ci/guards.ts`:

```ts
import {
  NO_LOGIN_PROMPT,
  NO_SECRET_PROMPT,
  TUI_NO_TTY,
} from "./constants";
import {
  isNonInteractive,
  isSecretPromptForbidden,
  isTuiForbidden,
} from "./detect";
import { CiCliError } from "./errors";

export function assertCanOpenTui(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (isTuiForbidden(env, stdin, stdout)) {
    throw new CiCliError(TUI_NO_TTY, 1);
  }
}

export function assertCanPromptSecret(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (isSecretPromptForbidden(env, stdin, stdout)) {
    throw new CiCliError(NO_SECRET_PROMPT, 1);
  }
}

export function assertCanLoginInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (isNonInteractive(env, stdout)) {
    throw new CiCliError(NO_LOGIN_PROMPT, 1);
  }
}
```

- [ ] Tests `cli/src/ci/guards.test.ts`:

  1. `assertCanOpenTui({ CI: "true" }, { isTTY: true }, { isTTY: true })` lanza `TUI_NO_TTY`.
  2. `assertCanOpenTui({}, { isTTY: false }, { isTTY: true })` lanza `TUI_NO_TTY`.
  3. `assertCanOpenTui({}, { isTTY: true }, { isTTY: true })` no lanza.
  4. `assertCanPromptSecret({ CI: "true" }, …)` lanza `NO_SECRET_PROMPT`.
  5. `assertCanLoginInteractive({ CHAVEZ_CI: "1" }, { isTTY: true })` lanza `NO_LOGIN_PROMPT`.
  6. Mensajes **exactos** (toBe), no includes vagos.

- [ ] En `cli/src/commands/login.ts`, primera línea de `loginCommand` (después de imports):

```ts
import { assertCanLoginInteractive } from "../ci/guards";

export async function loginCommand(): Promise<void> {
  assertCanLoginInteractive();
  // resto intacto (device-code, open, poll)
}
```

No abrir browser ni poll si el assert lanza.

- [ ] En `cli/src/commands/provider.ts`, al inicio de `linkClaude` y `linkCursor` (ambos caminos: `--api-key`, oauth, prompt Cursor, `--web`):

```ts
import { assertCanPromptSecret } from "../ci/guards";

async function linkClaude(args: string[]): Promise<void> {
  assertCanPromptSecret();
  // resto intacto
}

async function linkCursor(args: string[]): Promise<void> {
  assertCanPromptSecret();
  // resto intacto
}
```

`--web` también se bloquea en CI: abre browser, no es no-interactivo. `list` / `status` / `set` / `unlink` **no** se bloquean (no piden secret).

- [ ] En `cli/src/index.ts` `tuiCommand`, **antes** de `Bun.spawn`:

```ts
import { assertCanOpenTui } from "./ci/guards";
import { CiCliError } from "./ci/errors";
import { redactCiLog, collectCiSecrets } from "./ci/redact-log";

async function tuiCommand(): Promise<void> {
  assertCanOpenTui();
  const config = loadConfig();
  if (!config.accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
  // spawn Ink intacto
}
```

Y el `catch` de `main`:

```ts
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(redactCiLog(message, collectCiSecrets()));
    const code = err instanceof CiCliError ? err.exitCode : 1;
    process.exit(code);
  }
```

Así `ASK_CI_INVALID` sale **2**, TUI/login/secret salen **1**, y un `sk-ant-` en un throw no llega crudo a stderr.

- [ ] En `tui/src/index.tsx`, **antes** de `render(<App />)` (cinturón: si alguien corre `bun run tui/src/index.tsx` directo):

```tsx
import React from "react";
import { render } from "ink";
import { App } from "./App";
import { isTuiForbidden } from "../../cli/src/ci/detect";
import { TUI_NO_TTY } from "../../cli/src/ci/constants";

if (isTuiForbidden()) {
  console.error(TUI_NO_TTY);
  process.exit(1);
}

render(<App />);
```

No hay test de Ink. El guard se cubre en `detect.test.ts` + `guards.test.ts`. Opcional: `tui/src/index.test.ts` que solo importa `isTuiForbidden` (no montar Ink).

- [ ] Correr:

```bash
cd cli && bun test src/ci/guards.test.ts src/ci/detect.test.ts
```

Esperado: pases. Manual rápido (no sustituye el unitario):

```bash
CI=true bun run src/index.ts tui ; echo $status
# stderr: TUI_NO_TTY, exit 1. Ink no arranca.

CI=true bun run src/index.ts login ; echo $status
# stderr: NO_LOGIN_PROMPT, exit 1. No abre browser.

CI=true bun run src/index.ts provider link claude --api-key ; echo $status
# stderr: NO_SECRET_PROMPT, exit 1. No llama prompt().
```

(Ejecutar desde `cli/`. Si no hay bun global, `cd cli && CI=true bun src/index.ts tui`.)

- [ ] Commit:

```bash
git add cli/src/ci/guards.ts cli/src/ci/guards.test.ts \
  cli/src/commands/login.ts cli/src/commands/provider.ts \
  cli/src/index.ts tui/src/index.tsx tui/package.json
git commit -m "feat(ci): block TUI, login, and secret prompts without TTY"
```

---

## Task 4: Runner — daemon existente o in-process en el cwd

**Files:**

- Create: `cli/src/ci/run.ts`
- Create: `cli/src/ci/events.ts`
- Test: `cli/src/ci/run.test.ts`
- Test: `cli/src/ci/events.test.ts`

El runner **no** llama al LLM en los unitarios: se mockea `publishAgentTurn` / el cliente WS. Gherkin: *daemon o runner de CI en el cwd*.

- [ ] Crear `cli/src/ci/events.ts` — traduce un push WS a `CiEvent` (puro):

```ts
import type { CiEvent } from "./types";

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

type CiTurnVerification = "failed" | "timeout" | "passed" | "skipped" | null;

function readVerification(data: Record<string, unknown>): CiTurnVerification {
  const message = rec(data.message);
  const meta = rec(message?.metadata) ?? rec(data.metadata) ?? rec(data.verification);
  const status = meta && typeof meta.status === "string" ? meta.status : null;
  const nested = rec(data.verification) ?? rec(meta?.verification);
  const v = (nested && String(nested.status || "")) || status;
  if (v === "failed" || v === "timeout" || v === "passed" || v === "skipped") {
    return v;
  }
  return null;
}

export function pushToCiEvent(msg: { type: string; data?: unknown }): CiEvent | null {
  const data = rec(msg.data) ?? {};
  if (msg.type === "chat.stream.delta") {
    const text = String(data.delta ?? data.content ?? "");
    return text ? { kind: "assistant_delta", text } : null;
  }
  if (msg.type === "chat.stream.end") {
    return {
      kind: "stream_end",
      content: String(data.content ?? rec(data.message)?.content ?? ""),
      verificationStatus: readVerification(data),
    };
  }
  if (msg.type === "chat.stream.error") {
    return {
      kind: "stream_error",
      error: String(data.error ?? data.content ?? rec(data.message)?.content ?? "stream error"),
    };
  }
  if (msg.type === "agent.turn.ended") {
    return { kind: "turn_ended", status: String(data.status ?? "") };
  }
  if (msg.type === "chat.tool.start" || msg.type === "chat.tool.result" || msg.type === "chat.tool.update") {
    const message = rec(data.message);
    const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
    return {
      kind: "tool",
      name: String(meta.toolName || data.toolName || "tool"),
      status: String(meta.status || data.status || (msg.type === "chat.tool.start" ? "running" : "done")),
      output: meta.output != null ? String(meta.output) : undefined,
    };
  }
  return null;
}
```

`readVerification` mira `data.verification.status` **o** `data.message.metadata.verification.status` (plan 20 estampa ahí).

- [ ] Tests `cli/src/ci/events.test.ts`:

  1. `chat.stream.end` sin verification → `{ kind: "stream_end", verificationStatus: null }`.
  2. `chat.stream.end` con `data.verification = { status: "failed" }` → `"failed"`.
  3. `chat.stream.end` con `message.metadata.verification.status = "timeout"` → `"timeout"`.
  4. `chat.stream.error` `{ content: "boom" }` → `stream_error` `"boom"`.
  5. `chat.tool.start` → `kind: "tool"`.
  6. Tipo desconocido → `null`.

- [ ] Crear `cli/src/ci/run.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { publishAgentTurn } from "../llm/publish-turn";
import {
  clearWorkspaceState,
  cwdPath,
  isPidAlive,
  readWorkspaceState,
  writeWorkspaceState,
} from "../workspace";
import { ChavezWsClient } from "../ws/client";
import { CI_BUSY, CI_SESSION_TITLE, CI_SOURCE, CI_TIMEOUT, NO_SESSION_CI } from "./constants";
import { CiCliError, askCiError } from "./errors";
import { pushToCiEvent } from "./events";
import { formatCiPush, printCiLine } from "./format";
import { resolveCiMode } from "./args";
import { ciExitCode, foldCiEvents } from "./outcome";
import { collectCiSecrets, redactCiLog } from "./redact-log";
import type { CiEvent, CiTurnOutcome } from "./types";

export function selectRunnerMode(input: {
  existingPid?: number;
  existingAlive: boolean;
  selfPid: number;
}): "in-process" | "client-wait" {
  if (
    input.existingAlive &&
    input.existingPid != null &&
    input.existingPid !== input.selfPid
  ) {
    return "client-wait";
  }
  return "in-process";
}

export type RunCiInput = {
  prompt: string;
  chatId?: string | null;
  sessionId?: string | null;
  modeFlag?: "auto" | "plan" | "ask";
  timeoutMs: number;
  cwd?: string;
  token?: string;
  now?: () => number;
  publish?: typeof publishAgentTurn;
  fetchProviders?: () => Promise<{
    activeExecutionMode?: string | null;
    activeProvider?: string | null;
  }>;
  putMode?: (mode: "auto" | "plan") => Promise<void>;
};

async function readStdinPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function resolvePrompt(args: {
  prompt: string;
  readStdin: boolean;
}): Promise<string> {
  if (args.prompt.trim()) return args.prompt.trim();
  if (args.readStdin) return readStdinPrompt();
  return "";
}

type ProvidersSnap = {
  activeExecutionMode?: string | null;
  activeProvider?: string | null;
  providers?: Record<string, { linked?: boolean }>;
};

export async function prepareCiMode(input: RunCiInput): Promise<"auto" | "plan"> {
  const snap: ProvidersSnap = input.fetchProviders
    ? await input.fetchProviders()
    : await apiFetch("/providers");
  const resolved = resolveCiMode({
    flag: input.modeFlag,
    envMode: process.env.CHAVEZ_EXECUTION_MODE,
    prefsMode: snap.activeExecutionMode,
  });
  if (!resolved.ok) throw askCiError();
  if (resolved.putPrefs) {
    const put =
      input.putMode ??
      (async (mode: "auto" | "plan") => {
        try {
          await apiFetch("/providers/preferences", {
            method: "PUT",
            body: JSON.stringify({ activeExecutionMode: mode }),
          });
        } catch {
          // plan 3 no aterrizó: PUT puede 400/404. Seguir; bypass ≈ auto.
        }
      });
    await put(resolved.mode);
  }
  return resolved.mode;
}

export type WaitForTurn = Promise<CiTurnOutcome> & {
  fail: (error: string) => void;
};

export function waitForTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  timeoutMs: number;
  onLine?: (line: string) => void;
}): WaitForTurn {
  const events: CiEvent[] = [];
  let settled = false;
  let settle: (v: CiTurnOutcome) => void = () => {};
  const done = new Promise<CiTurnOutcome>((resolve) => {
    settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
  });
  const unsub = input.client.onPush((msg) => {
    const data = (msg.data || {}) as { chatId?: string };
    if (data.chatId && data.chatId !== input.chatId) return;
    const line = formatCiPush({ type: msg.type, data: msg.data });
    if (line) input.onLine?.(line);
    const ev = pushToCiEvent({ type: msg.type, data: msg.data });
    if (ev) events.push(ev);
    if (
      msg.type === "chat.stream.end" ||
      msg.type === "chat.stream.error" ||
      msg.type === "agent.turn.ended"
    ) {
      settle(foldCiEvents(events));
    }
  });
  const timer = setTimeout(() => {
    settle(foldCiEvents([...events, { kind: "timeout" }]));
  }, input.timeoutMs);
  const wrapped = done.finally(() => {
    clearTimeout(timer);
    unsub();
  }) as WaitForTurn;
  wrapped.fail = (error: string) => {
    const kind = error === CI_TIMEOUT ? "timeout" : "stream_error";
    settle(
      foldCiEvents([
        ...events,
        kind === "timeout" ? { kind: "timeout" } : { kind: "stream_error", error },
      ]),
    );
  };
  return wrapped;
}

async function ensureChat(
  client: ChavezWsClient,
  input: RunCiInput,
): Promise<string> {
  if (input.chatId) return input.chatId;
  let sessionId = input.sessionId;
  if (!sessionId) {
    const created = await client.request({
      type: "session.create",
      title: CI_SESSION_TITLE,
    });
    if (!created.ok) throw new CiCliError(created.error || "session.create failed");
    const session = (created.data as { session?: { id: string } })?.session;
    sessionId = session?.id;
    if (!sessionId) throw new CiCliError("session.create failed");
  }
  const title = input.prompt.trim().slice(0, 80) || CI_SESSION_TITLE;
  const chatRes = await client.request({
    type: "chat.create",
    sessionId,
    title,
  });
  if (!chatRes.ok) throw new CiCliError(chatRes.error || "chat.create failed");
  const chat = (chatRes.data as { chat?: { id: string } })?.chat;
  if (!chat?.id) throw new CiCliError("chat.create failed");
  return chat.id;
}

export async function runCiTurn(input: RunCiInput): Promise<{
  outcome: CiTurnOutcome;
  exitCode: number;
  chatId: string;
}> {
  const token = input.token ?? loadConfig().accessToken;
  if (!token) throw new CiCliError(NO_SESSION_CI, 1);
  const cwd = input.cwd ?? cwdPath();
  await prepareCiMode(input);

  const existing = readWorkspaceState(cwd);
  const mode = selectRunnerMode({
    existingPid: existing?.pid,
    existingAlive: Boolean(existing && isPidAlive(existing.pid)),
    selfPid: process.pid,
  });

  const client = new ChavezWsClient(token);
  await client.connect();
  const kind = mode === "in-process" ? "daemon" : "client";
  const bound = await client.bind(cwd, kind);
  if (!bound.ok) throw new CiCliError(bound.error || "bind failed");
  const workspace = (bound.data as { workspace?: { id: string } })?.workspace;
  const wroteState = mode === "in-process";
  if (wroteState) {
    writeWorkspaceState({
      path: cwd,
      pid: process.pid,
      openedAt: new Date().toISOString(),
      workspaceId: workspace?.id,
    });
  }

  const extras = collectCiSecrets();
  const onLine = (line: string) => printCiLine("stdout", line, extras);

  try {
    const chatId = await ensureChat(client, input);

    if (mode === "client-wait") {
      const waiting = waitForTurn({
        client,
        chatId,
        timeoutMs: input.timeoutMs,
        onLine,
      });
      const res = await client.request(
        {
          type: "agent.turn.request",
          chatId,
          prompt: input.prompt,
          metadata: { ci: true, source: CI_SOURCE },
        },
        30_000,
      );
      if (!res.ok) {
        const err = res.error || "agent.turn.request failed";
        if (err === "ask no válido en no-interactivo") throw askCiError();
        if (/Turn already running|not queued/i.test(err)) {
          waiting.fail(CI_BUSY);
          const outcome = foldCiEvents([{ kind: "busy" }]);
          return { outcome, exitCode: ciExitCode(outcome), chatId };
        }
        throw new CiCliError(err, 1);
      }
      const outcome = await waiting;
      if (outcome.timedOut) {
        await client.request({ type: "agent.turn.cancel", chatId }).catch(() => {});
      }
      return { outcome, exitCode: ciExitCode(outcome), chatId };
    }

    // in-process: this process IS the daemon. Subscribe BEFORE publish.
    const waiting = waitForTurn({
      client,
      chatId,
      timeoutMs: input.timeoutMs,
      onLine,
    });
    const publish = input.publish ?? publishAgentTurn;
    try {
      await publish({
        client,
        chatId,
        prompt: input.prompt,
        cwd,
        token,
        skipUserAppend: false,
      });
    } catch (err) {
      const message = redactCiLog(
        err instanceof Error ? err.message : String(err),
        extras,
      );
      printCiLine("stderr", message, extras);
      waiting.fail(message);
    }
    const outcome = await waiting;
    return { outcome, exitCode: ciExitCode(outcome), chatId };
  } finally {
    if (wroteState) clearWorkspaceState(cwd);
    try {
      client.close();
    } catch {
      // ignore
    }
  }
}
```

Notas de cableado (no son pasos extra; van en el mismo archivo):

- `publishAgentTurn` puede aceptar `source?: "ci"` y, si está, estampar `metadata: { source: CI_SOURCE, ci: true }` en el `chat.append` user. `handlers.ts` `chat.append` ya persiste `msg.metadata`.
- Timeout in-process: `waitForTurn` ya resuelve `{ kind: "timeout" }`. Si `runClaudeTurn` acepta `abortController` (plan 5/16), abortar al vencer. Si no, `client.close()` al salir mata el SDK.
- `agent.turn.cancel` en `client-wait` al timeout: si el handler no existe, el `.catch(() => {})` traga el fail; el CLI igual sale 1 con `CI_TIMEOUT`.
- **Nunca** loguear `creds` ni `GET /providers/claude/credentials`. El runner no llama a credentials; eso queda en `publish-turn`.
- 1 turn: no lanzar un segundo `publishAgentTurn`. `selectRunnerMode` evita un segundo daemon si ya hay pid vivo.
- Importar `CI_BUSY` desde `./constants` (el bloque de imports de `run.ts` lo añade junto a `CI_TIMEOUT`).

- [ ] Tests `cli/src/ci/run.test.ts` (sin red, sin LLM):

  1. `selectRunnerMode({ existingAlive: true, existingPid: 99, selfPid: 1 })` → `"client-wait"`.
  2. `selectRunnerMode({ existingAlive: false, selfPid: 1 })` → `"in-process"`.
  3. `selectRunnerMode({ existingAlive: true, existingPid: 7, selfPid: 7 })` → `"in-process"` (somos nosotros).
  4. `prepareCiMode({ modeFlag: "ask", timeoutMs: 1, prompt: "x", fetchProviders: async () => ({}) })` rechaza con `CiCliError` `exitCode === 2` y mensaje `ASK_CI_INVALID`.
  5. `prepareCiMode({ modeFlag: "auto", …, putMode })` llama `putMode("auto")`.
  6. `prepareCiMode({ prefsMode via fetchProviders: { activeExecutionMode: "ask" } })` sin flag → `exitCode 2`.
  7. Fake `waitForTurn`: empujar un push `chat.stream.end` con `verification: { status: "failed" }` → outcome `verificationStatus === "failed"`, `ciExitCode === 1`.
  8. Fake `waitForTurn`: `chat.stream.end` limpio → exit 0.
  9. Fake `waitForTurn`: no llega nada + timeout 20ms → `timedOut`, reason `CI_TIMEOUT`.
  10. `formatCiPush` se invoca en cada tool start (espiar `onLine`): una línea `tool ·` y **cero** `{ "type":`.

- [ ] Correr:

```bash
cd cli && bun test src/ci/run.test.ts src/ci/events.test.ts src/ci/outcome.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/ci/run.ts cli/src/ci/run.test.ts \
  cli/src/ci/events.ts cli/src/ci/events.test.ts \
  cli/src/llm/publish-turn.ts
git commit -m "feat(ci): in-process runner or wait on bound daemon"
```

---

## Task 5: CLI — `chavez ci` y `headless chat ask` no interactivo

**Files:**

- Create: `cli/src/commands/ci.ts`
- Test: `cli/src/commands/ci.test.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`

- [ ] Crear `cli/src/commands/ci.ts`:

```ts
import { parseCiArgs, assertCiUsage } from "../ci/args";
import { CI_OK_LINE, CI_USAGE } from "../ci/constants";
import { CiCliError } from "../ci/errors";
import { formatCiOutcome, printCiLine } from "../ci/format";
import { ciExitCode } from "../ci/outcome";
import { resolvePrompt, runCiTurn } from "../ci/run";
import { collectCiSecrets } from "../ci/redact-log";
import { cwdPath } from "../workspace";

export async function ciCommand(argv: string[]): Promise<void> {
  const parsed = parseCiArgs(argv);
  const prompt = await resolvePrompt(parsed);
  assertCiUsage(parsed, prompt);
  printCiLine("stderr", `ci start cwd=${cwdPath()}`, collectCiSecrets());
  const { outcome, exitCode } = await runCiTurn({
    prompt,
    chatId: parsed.chatId,
    sessionId: parsed.sessionId,
    modeFlag: parsed.modeFlag,
    timeoutMs: parsed.timeoutMs,
  });
  const line = formatCiOutcome(outcome);
  printCiLine(line.stream, line.text);
  if (exitCode === 0) {
    // formatCiOutcome already printed ci ok on stdout
    void CI_OK_LINE;
  }
  process.exit(exitCode);
}
```

`assertCiUsage` con prompt vacío tras stdin → `CI_USAGE`, exit 1.

No imprimir `chatId` junto a tokens. `ci start cwd=…` va a **stderr** para no mezclarse con el assistant.

- [ ] Tests `cli/src/commands/ci.test.ts`: no hace falta spawn del binario. Cubrir que `parseCiArgs` + `runCiTurn` se invocan con los flags (mock de `runCiTurn` inyectable). Para no complicar el command, extraer:

```ts
export async function ciCommandBody(
  argv: string[],
  deps: { run: typeof runCiTurn; exit: (code: number) => void; readPrompt?: typeof resolvePrompt },
): Promise<void>
```

`ciCommand` llama `ciCommandBody(argv, { run: runCiTurn, exit: (c) => process.exit(c) })`.

Tests:

  1. `["--mode", "auto", "go"]` llama `run` con `modeFlag: "auto"`, `prompt: "go"`.
  2. `run` resuelve `{ exitCode: 0, outcome: streamEnd }` → `deps.exit(0)` y stdout incluye `ci ok` (espiar `printCiLine` o inyectar `write`).
  3. `run` tira `CiCliError(ASK_CI_INVALID, 2)` → el caller de `index.ts` sale 2; aquí `ciCommandBody` deja throw (el catch de `main` se encarga). Test: `expect(body).toThrow` + `exitCode 2`.
  4. `[]` sin stdin mockeado (`readPrompt: async () => ""`) tira `CI_USAGE`.

- [ ] En `cli/src/index.ts`:

  1. Importar `ciCommand`.
  2. `case "ci": await ciCommand(rest); break;`
  3. Ampliar `usage()`:

```
  chavez ci [--mode auto|plan] [--chat <chatId>] [--timeout <ms>] [--ci] <prompt…>
  chavez headless chat ask [--mode plan|auto|ask] [--ci] <chatId> <prompt…>
```

  4. El `catch` de Task 3 ya mapea `CiCliError.exitCode`. Confirmar que un throw desde `ciCommand` **no** se traga con exit 1 fijo.

- [ ] En `cli/src/commands/headless.ts`, rama `chat ask`:

  1. Parsear `--ci`, `--mode`, `--timeout` **además** de los flags que el plan 3 / 29 ya añadan (`--no-queue`, `--wait-timeout`). Reutilizar `parseCiArgs` sobre `rest` **o** extender el parser existente. Congelar: `--mode` y `--ci` no se comen el `chatId`.

  Ejemplo si el plan 3 ya filtró `--mode`:

```ts
import { isNonInteractive } from "../ci/detect";
import { parseCiArgs } from "../ci/args";
import { runCiTurn } from "../ci/run";
import { formatCiOutcome, printCiLine } from "../ci/format";
import { CiCliError } from "../ci/errors";

if (action === "ask") {
  const parsed = parseCiArgs(rest);
  const chatId = parsed.chatId ?? parsed.prompt.split(/\s+/)[0];
  // parseCiArgs treats first positional as prompt. For `chat ask` the
  // first positional is chatId. Dedicated parse:
}
```

Parser dedicado `parseAskCiArgs(rest)` en `cli/src/ci/args.ts` (no reusar a ciegas `parseCiArgs`):

```ts
export type ParsedAskArgs = {
  chatId: string;
  prompt: string;
  modeFlag: "auto" | "plan" | "ask" | undefined;
  timeoutMs: number;
  forceCi: boolean;
};

export function parseAskCiArgs(rest: string[]): ParsedAskArgs {
  const base = parseCiArgs(rest);
  const parts = base.prompt.split(/\s+/).filter(Boolean);
  // When parseCiArgs already took --chat, use it. Otherwise first positional = chatId.
  if (base.chatId) {
    return {
      chatId: base.chatId,
      prompt: base.prompt,
      modeFlag: base.modeFlag,
      timeoutMs: base.timeoutMs,
      forceCi: base.forceCi,
    };
  }
  const chatId = parts[0] || "";
  const prompt = parts.slice(1).join(" ");
  return {
    chatId,
    prompt,
    modeFlag: base.modeFlag,
    timeoutMs: base.timeoutMs,
    forceCi: base.forceCi,
  };
}
```

Tests extra en `args.test.ts`:

  15. `parseAskCiArgs(["chat1", "hello", "world"])` → chatId `chat1`, prompt `hello world`.
  16. `parseAskCiArgs(["--mode", "auto", "chat1", "p"])` → mode auto, chatId `chat1`.
  17. `parseAskCiArgs(["--ci", "--chat=chat1", "p"])` → forceCi, chatId `chat1`.

  2. Cuerpo `ask`:

```ts
if (action === "ask") {
  const parsed = parseAskCiArgs(rest);
  if (!parsed.chatId || !parsed.prompt) {
    throw new Error(
      "Uso: … chat ask [--mode plan|auto|ask] [--ci] <chatId> <prompt…>",
    );
  }
  const nonInteractive = parsed.forceCi || isNonInteractive();
  if (nonInteractive) {
    const { outcome, exitCode } = await runCiTurn({
      prompt: parsed.prompt,
      chatId: parsed.chatId,
      modeFlag: parsed.modeFlag,
      timeoutMs: parsed.timeoutMs,
    });
    const line = formatCiOutcome(outcome);
    printCiLine(line.stream, line.text);
    process.exit(exitCode);
  }
  // camino interactivo existente: PUT --mode si plan 3, request, JSON accepted, aviso watch.
}
```

  3. El camino interactivo **no** cambia: sigue saliendo tras `accepted` y **no** espera el stream (eso es `watch`). Solo el no-interactivo espera.

  4. `chat watch` **no** se convierte en CI. Sigue siendo observador. En no-interactivo, `watch` puede seguir; no es el comando de exit code.

- [ ] Tests `cli/src/ci/args.test.ts` casos 15–17 (arriba). Si `headless.ts` es difícil de importar por side effects, no hace falta un test de integración aquí: Task 7 cubre el binario.

- [ ] Correr:

```bash
cd cli && bun test src/ci
```

Esperado: todos los unitarios de `src/ci` pasan, incluido `commands/ci.test.ts`.

- [ ] Commit:

```bash
git add cli/src/commands/ci.ts cli/src/commands/ci.test.ts \
  cli/src/commands/headless.ts cli/src/index.ts cli/src/ci/args.ts \
  cli/src/ci/args.test.ts
git commit -m "feat(ci): chavez ci and non-interactive chat ask wait for turn"
```

---

## Task 6: API rechaza `ask` en CI + hint en Web

**Files:**

- Modify: `api/src/ws/handlers.ts`
- Test: `api/src/ws/ci-ask.test.ts`
- Create: `web/src/lib/ci.ts`
- Test: `web/src/lib/ci.test.ts`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/package.json`

La API **no** ejecuta el turn. Cinturón: un script que mande `agent.turn.request` con `metadata.ci: true` y prefs `ask` no deja un waiter de 300s.

- [ ] Añadir `"test": "bun test"` en `web/package.json` si falta.

- [ ] Crear `web/src/lib/ci.ts`:

```ts
/** keep-in-sync: cli/src/ci/constants.ts CI_HUB_HINT */

export const CI_HUB_HINT =
  'CI: CHAVEZ_ACCESS_TOKEN=… chavez ci --mode auto "<prompt>"  → exit 0/≠0, log texto. Sin GitHub Action.';
```

- [ ] Test `web/src/lib/ci.test.ts`: `CI_HUB_HINT` incluye `chavez ci --mode auto` y **no** incluye `GitHub Action.yml` ni `.github`. Incluye la frase `Sin GitHub Action`.

- [ ] En `web/src/components/HubPanel.tsx`, sección CLI: ampliar el `<pre>` y un `<p className="muted">` con `{CI_HUB_HINT}`:

```tsx
import { CI_HUB_HINT } from "../lib/ci";
```

El `<pre>` del panel CLI queda:

```
chavez login
chavez headless workspace open
chavez tui
chavez ci --mode auto "<prompt>"
```

Debajo: `<p className="muted">{CI_HUB_HINT}</p>`.

No añadir botones de upload, no añadir un formulario de CI, no enlazar a Actions.

- [ ] En `api/src/ws/handlers.ts`, case `agent.turn.request`, **después** de resolver el chat/workspace y **antes** de `hub.sendTo` dispatch:

```ts
import { ASK_CI_INVALID } from "../ci/constants";

// dentro del case, tras const ctx = … y const daemon = …
const ci = msg.metadata?.ci === true || msg.metadata?.source === "ci";
if (ci) {
  const prefRows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const mode = prefRows[0] && "activeExecutionMode" in prefRows[0]
    ? (prefRows[0] as { activeExecutionMode?: string | null }).activeExecutionMode
    : null;
  if (mode === "ask") {
    return fail(type, id, ASK_CI_INVALID);
  }
}
```

Reglas:

- Comparación **estricta** `mode === "ask"`. `null` / columna ausente / `"auto"` / `"plan"` **no** rechazan.
- Si `user_preferences` aún no tiene `activeExecutionMode` (plan 3 no mergeado), **no** leer una columna inexistente: envolver en `if ("activeExecutionMode" in userPreferences)` usando el objeto de schema. Si el schema **no** tiene el campo, omitir el bloque `mode === "ask"` y dejar un comentario `// plan 3: reject ask when activeExecutionMode exists`. El CLI sigue cubriendo el Gherkin.
- **No** despachar si se rechaza. **No** append de user. El daemon no ve el turn.
- `NO_DAEMON_ERROR` se evalúa **igual que hoy**. Un `chavez ci` in-process se bindea **antes** del request (client-wait) o no usa request (in-process). Un request CI sin daemon sigue fallando con el string existente.

- [ ] Tests `api/src/ws/ci-ask.test.ts`. Extraer la decisión a función pura para no levantar Hono:

Crear `api/src/ci/ask-gate.ts`:

```ts
/** keep-in-sync message: cli/src/ci/constants.ts ASK_CI_INVALID */
import { ASK_CI_INVALID } from "./constants";

export function ciAskGate(input: {
  ci: boolean;
  activeExecutionMode: string | null | undefined;
}): { ok: true } | { ok: false; error: typeof ASK_CI_INVALID } {
  if (input.ci && input.activeExecutionMode === "ask") {
    return { ok: false, error: ASK_CI_INVALID };
  }
  return { ok: true };
}
```

El handler llama `ciAskGate({ ci, activeExecutionMode: mode })`.

Tests:

  1. `{ ci: true, activeExecutionMode: "ask" }` → `{ ok: false, error: "ask no válido en no-interactivo" }`.
  2. `{ ci: true, activeExecutionMode: "auto" }` → ok.
  3. `{ ci: true, activeExecutionMode: "plan" }` → ok.
  4. `{ ci: true, activeExecutionMode: null }` → ok (plan 3 ausente).
  5. `{ ci: false, activeExecutionMode: "ask" }` → ok (Web/TUI interactivo).

- [ ] Correr:

```bash
cd api && bun test src/ci
cd web && bun test src/lib/ci.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/ci api/src/ws/handlers.ts api/src/ws/ci-ask.test.ts \
  web/src/lib/ci.ts web/src/lib/ci.test.ts \
  web/src/components/HubPanel.tsx web/package.json
git commit -m "feat(ci): API rejects ask in CI; hub shows text-log command"
```

---

## Task 7: Smoke Gherkin — auto ok, fallo, ask, TTY, vault

**Files:**

- Create: `cli/scripts/ci-headless-smoke.ts`
- Modify: `cli/src/ci/redact-log.test.ts` (si hace falta un caso más de vault)
- Test: `cli/src/ci/gherkin.test.ts`

Los unitarios de Tasks 1–6 ya cubren la lógica. Este task cierra los **cinco** escenarios con un archivo de aceptación y un smoke opcional (API + token). El smoke **no** finge éxito si no hay login.

- [ ] Crear `cli/src/ci/gherkin.test.ts` — tabla escenario → asserts sobre funciones puras (sin LLM):

```ts
import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID, CI_OK_LINE, TUI_NO_TTY, NO_SECRET_PROMPT } from "./constants";
import { isNonInteractive, isTuiForbidden } from "./detect";
import { resolveCiMode } from "./args";
import { foldCiEvents, ciExitCode, ciFailReason } from "./outcome";
import { formatCiOutcome, formatCiPush } from "./format";
import { redactCiLog } from "./redact-log";
import { assertCanOpenTui, assertCanPromptSecret } from "./guards";

describe("Gherkin: Chavez en CI", () => {
  test("Turn auto en CI: stream.end → exit 0 y log texto de tools+assistant", () => {
    const lines = [
      formatCiPush({
        type: "chat.tool.start",
        data: { toolName: "Bash", metadata: { status: "running" } },
      }),
      formatCiPush({
        type: "chat.tool.result",
        data: { toolName: "Bash", status: "done" },
      }),
      formatCiPush({
        type: "chat.stream.delta",
        data: { delta: "listo" },
      }),
    ];
    expect(lines[0]).toContain("tool ·");
    expect(lines[0]).not.toMatch(/^\s*\{/);
    expect(lines[2]).toContain("listo");
    const outcome = foldCiEvents([{ kind: "stream_end", content: "listo" }]);
    expect(ciExitCode(outcome)).toBe(0);
    expect(formatCiOutcome(outcome)).toEqual({ stream: "stdout", text: CI_OK_LINE });
  });

  test("Fallo: provider error / stream.error / verification failed → exit != 0 + motivo", () => {
    const provider = foldCiEvents([
      { kind: "stream_error", error: "Claude no está vinculado — chavez provider link claude" },
    ]);
    expect(ciExitCode(provider)).not.toBe(0);
    expect(ciFailReason(provider)).toContain("Claude no está vinculado");

    const fatal = foldCiEvents([{ kind: "stream_error", error: "tool exploded" }]);
    expect(ciExitCode(fatal)).not.toBe(0);
    expect(ciFailReason(fatal)).toContain("tool exploded");

    const red = foldCiEvents([
      { kind: "stream_end", content: "tests failed", verificationStatus: "failed" },
    ]);
    expect(ciExitCode(red)).not.toBe(0);
    expect(formatCiOutcome(red).text).toMatch(/^ci fail:/);
  });

  test("Modo ask en CI: no espera humano; exit 2; ASK_CI_INVALID", () => {
    const r = resolveCiMode({ flag: "ask" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ASK_CI_INVALID);
    const prefs = resolveCiMode({ prefsMode: "ask" });
    expect(prefs.ok).toBe(false);
    const explicit = resolveCiMode({ flag: "auto", prefsMode: "ask" });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.mode).toBe("auto");
  });

  test("Sin TTY: no TUI, no prompt de secrets", () => {
    expect(isTuiForbidden({ CI: "true" }, { isTTY: true }, { isTTY: true })).toBe(true);
    expect(isNonInteractive({ CI: "true" }, { isTTY: true })).toBe(true);
    expect(() =>
      assertCanOpenTui({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toThrow(TUI_NO_TTY);
    expect(() =>
      assertCanPromptSecret({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toThrow(NO_SECRET_PROMPT);
  });

  test("Log no contiene vault: keys redactadas", () => {
    const raw = formatCiPush({
      type: "chat.stream.error",
      data: { error: "auth sk-ant-api03-LEAKEDSECRET999" },
    });
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toContain("LEAKEDSECRET999");
    const token = "tok_LIVE_abcdef123456";
    const out = redactCiLog(
      `CHAVEZ_ACCESS_TOKEN=${token} Bearer ${token}`,
      [token],
    );
    expect(out).not.toContain(token);
    expect(out).not.toContain("tok_LIVE_");
  });
});
```

Ajustar `formatCiPush` de tool start si el payload de test no coincide con el parser (usar el mismo shape que `watch-format` si ese módulo existe: `{ data: { message: { metadata: { toolName, status } } } }`). Lo importante: el test falla si el log es JSON crudo o si una key sobrevive.

- [ ] Crear `cli/scripts/ci-headless-smoke.ts`:

```ts
/**
 * Live smoke for plan 25. Needs API + CHAVEZ_ACCESS_TOKEN (or ~/.chavez/config.json).
 * Does NOT call the LLM if --dry. Default: --dry (guards + mode + redact).
 * Pass --live to run one auto turn against the cwd (requires linked Claude).
 */
import { ASK_CI_INVALID, TUI_NO_TTY, NO_SECRET_PROMPT } from "../src/ci/constants";
import { isTuiForbidden } from "../src/ci/detect";
import { resolveCiMode } from "../src/ci/args";
import { redactCiLog } from "../src/ci/redact-log";
import { runCiTurn } from "../src/ci/run";
import { loadConfig } from "../src/config";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(isTuiForbidden({ CI: "true" }, { isTTY: true }, { isTTY: true }), "CI forbids TUI");
assert(resolveCiMode({ flag: "ask" }).ok === false, "ask flag rejected");
const ask = resolveCiMode({ flag: "ask" });
assert(!ask.ok && ask.error === ASK_CI_INVALID, ASK_CI_INVALID);
assert(
  redactCiLog("sk-ant-api03-aaaa").includes("***") ||
    !redactCiLog("sk-ant-api03-aaaa").includes("sk-ant-"),
  "keys redacted",
);
console.log("A) dry guards ok", TUI_NO_TTY.slice(0, 7), NO_SECRET_PROMPT.slice(0, 7));

const live = process.argv.includes("--live");
if (!live) {
  console.log("ci-headless-smoke dry ok");
  process.exit(0);
}

const token = process.env.CHAVEZ_ACCESS_TOKEN || loadConfig().accessToken;
if (!token) {
  console.error("Need login / CHAVEZ_ACCESS_TOKEN");
  process.exit(1);
}

const { exitCode, outcome } = await runCiTurn({
  prompt: "Reply with exactly: pong",
  modeFlag: "auto",
  timeoutMs: 120_000,
});
if (exitCode !== 0) {
  throw new Error(
    `live ci expected 0, got ${exitCode} verification=${outcome.verificationStatus} error=${outcome.streamError ?? outcome.providerError ?? ""}`,
  );
}
console.log("B) live auto turn ok");
console.log("ci-headless-smoke live ok");
```

El `throw` solo incluye `exitCode` / `verificationStatus` / `streamError` ya redactados por el runner. No volcar el outcome entero.

- [ ] Correr:

```bash
cd cli && bun test src/ci
cd api && bun test src/ci
cd web && bun test src/lib/ci.test.ts
cd cli && bun run scripts/ci-headless-smoke.ts
```

Esperado: unitarios verdes; smoke dry sale 0. `--live` solo si hay token + Claude linked + API; si falta token, sale 1 con `"Need login / CHAVEZ_ACCESS_TOKEN"` — **no** marcar el smoke como ok.

- [ ] Grep de control (el implementador lo corre; cero matches en producto):

```bash
rg -n "GitHub Action" api/src cli/src tui/src web/src
rg -n "application/vnd.chavez.ci" api/src cli/src
ls .github/workflows 2>/dev/null || true
```

Cero workflows nuevos. Cero content-type JSON de CI. `CI_HUB_HINT` puede contener la frase `Sin GitHub Action`; el grep de `"GitHub Action"` en `web/src/lib/ci.ts` es el hint, no un workflow.

- [ ] Commit:

```bash
git add cli/src/ci/gherkin.test.ts cli/scripts/ci-headless-smoke.ts
git commit -m "test(ci): Gherkin paths for auto, fail, ask, TTY, redaction"
```

---

## Mapa escenario → task

| Escenario Gherkin | Tasks |
|---|---|
| Turn auto en CI (log texto tools+assistant, exit 0 si finished ok) | 1, 2, 4, 5, 7 |
| Fallo (provider, tool fatal, tests pactados en rojo) → exit ≠ 0 + motivo | 1, 2, 4, 7 |
| Modo ask en CI: no espera humano; exit ≠ 0 con `ask no válido en no-interactivo`; o `--mode auto` explícito | 1, 4, 5, 6, 7 |
| Sin TTY: no abre TUI; no pide secrets por prompt (env/vault ya linked) | 3, 7 |
| Log no contiene vault: keys redactadas | 2, 4, 7 |

## Fuera de alcance (no implementar en esta fase)

- GitHub Action, composite action, `action.yml`, badge de CI en el README.
- JSON schema / `--json` / `application/vnd.chavez.ci+json` del resultado.
- Cursor cloud, Cursor ejecutable (plan 4): el fail existente basta.
- PTY (plan 27): en CI no está; no crear un PTY “headless”.
- Auto-aprobar tools en `ask`. Sin lote, sin “siempre permitir”.
- Cola eterna (plan 29): default no-interactivo **no** encola; reutilizar `--wait-timeout` si ya existe.
- Sandbox de red (plan 26), worktrees paralelos, notificaciones OS/email.
- Upload desde el navegador, voz, extensión IDE, org/roles.
- Cambiar `NO_DAEMON_ERROR`, `DEFAULT_EXECUTION_MODE` (`ask` en interactivo se mantiene).
