# Verification Loop Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, CI/headless exit code (plan 25), sandbox de red (plan 26), cola de turns (plan 29), slash `/test` (plan 11), ni un test suite inventado cuando las reglas no pactan comando. Spec: [`plan.md`](./plan.md). Depende de tools ([`agent-tools`](../agent-tools/implementation.md)), modos ([`execution-modes`](../execution-modes/implementation.md)), aprobaciones ([`approvals`](../approvals/implementation.md)), reglas ([`project-rules`](../project-rules/implementation.md)) y diffs ([`diffs-review`](../diffs-review/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** Tras edits, tests y linter se ven **como tools** en la misma timeline (Web, TUI, CLI `watch`). El stdout **acotado** es el resultado. Si el comando pactado falla, el turn **no** se vende como éxito silencioso y el assistant **explica** el fallo. En `plan` no corren tests que escriben coverage/snapshots (se propone el comando). En `ask` el bash de test pide aprobación como cualquier bash (un test no es un read). Si las reglas definen `npm test` (u otro), `auto` lo intenta tras edits; **si no hay regla, no se inventa** un suite. Un test interminable hace **timeout**, la tool queda `error` y el **turn se cierra**.

**Architecture:** Tests y linter **no** son una séptima tool del SDK. Son `Bash` (y el shell de Cursor, cuando el [plan 4](../cursor-provider/plan.md) ejecute) **clasificados** en el daemon como `kind: "verify"` | `"lint"`. El filesystem y el spawn viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** corre tests: persiste `metadata.kind` / `metadata.verification` en `chat_messages` (jsonb, **sin migración**) y hace fan-out. El comando pactado se lee de las reglas (plan 9: frontmatter `verify:` / `verifyCommand:` + líneas `Verification:`); precedencia **local > proyecto > usuario**.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API  --dispatch-->  daemon
        |
        v
  publishAgentTurn + TurnVerifyState
        |  rules bundle → pactCommand | null
        |  appendSystemPrompt += VERIFY_PREAMBLE [+ comando pactado]
        |
        |  query() / Cursor shell
        |    canUseTool:
        |      classify(command) → verify|lint|bash
        |      plan + mutating flags → PLAN_VERIFY_MUTATION_DENIED
        |      plan + resto bash     → PLAN_MUTATION_DENIED (proponer)
        |      ask  → awaiting_approval (nunca skip-as-read)
        |      auto → allow + timeout inyectado
        |
        |    tool_start  metadata.kind = verify|lint|bash
        |    watchdog VERIFY_TIMEOUT_MS
        |    tool_result stdout/stderr truncado; exit≠0 → status=error
        |
        |  after query (auto + hubo edits + pact + el modelo no lo corrió):
        |    runVerifyCommand(cwd, pact)  ← spawn en el daemon, no en la API
        |    chat.tool.start/result sintéticos
        |    fail → 1 continuación VERIFY_EXPLAIN_PROMPT
        |    timeout → stream.error + turn.ended (sin continuación)
        |
        |  chat.stream.end metadata.verification { status, command, exitCode, … }
        v
  API persist + broadcast
        v
  Web ToolCard test/lint + banner  |  TUI línea test ·  |  CLI watch
  DiffsPanel / diff ·  NO se sustituye por el linter
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` llama `query()` con `cwd` y `permissionMode: "bypassPermissions"`. Los planes 2–3 lo pasan a `default` + `canUseTool`. **No** volver a `bypassPermissions`. Hoy **no** clasifica bash, **no** inyecta timeout, **no** hay watchdog.
- `cli/src/llm/publish-turn.ts` emite `chat.tool.start` / `result`. **No** estampa `kind`, **no** corre un pacto post-edit, **no** cierra el turn por timeout de test, **no** pone `metadata.verification`.
- `cli/src/llm/tool-names.ts` / `tool-display.ts` (plan 2): `DEFAULT_CLAUDE_TOOLS` son las 6. **No** añadir `Verify`. Truncado `TOOL_OUTPUT_MAX_CHARS = 8000` se reusa.
- `cli/src/llm/execution-gate.ts` (plan 3): lecturas allow; write/edit/bash dependen del modo. Bash de test **sigue siendo write**. Este plan **no** reclasifica tests como read.
- `cli/src/llm/rules-parse.ts` / `rules-merge.ts` (plan 9): capas user/project/local. **No** hay `verifyCommand` hoy. Si los archivos no existen aún, Task 2 crea el extractor en `verify-pact.ts` y Task 2-bis lo enchufa cuando existan.
- `api/src/ws/handlers.ts` `chat.tool.start` solo persiste `input`. Task 5 hace spread de `msg.metadata` para que `kind` sobreviva un reload. `chat.stream.end` ya mergea `msg.metadata` en el assistant.
- Web `ChatDetailPanel.tsx` `ToolCard`: nombre + status + JSON. Plan 6 añade `DiffsPanel` **después** de las tools del `streamId`. Este plan pinta test/lint **en** el ToolCard y un banner de fallo; **nunca** reemplaza `DiffsPanel`.
- TUI `App.tsx`: `Message = { id, role, content }` sin metadata (el plan 2 la añade). Últimos 8 mensajes truncados.
- CLI `chat watch` vuelca JSON o `formatWatchLine` (plan 2). Añadir `test ·` / `lint ·` / `verify ·` sin tirar `diff ·`.
- Cursor `runnable: false` hasta el plan 4. El clasificador y el pacto se calculan igual; si `cli/src/llm/cursor-runner.ts` existe, se cablea el mismo `kind`. **No** simular turns de Cursor.
- Plan 25 (CI) **consume** `metadata.verification.status` ∈ `failed`|`timeout` para exit ≠ 0. Esta fase **no** implementa el comando CI.
- Plan 26 (red): en auto la red se denegará después. Un `npm test` que precise red fallará por esa política **más tarde**; aquí no se implementa.

**Tech Stack:** Bun (`Bun.spawn` + kill por timeout), Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva, **sin** migración), Claude Agent SDK `query` (`canUseTool`, `updatedInput.timeout`, `permissionMode: "default"`), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar classify + labels (comentario keep-in-sync).

**Global Constraints:**

1. El filesystem y el spawn de tests/linter viven **solo** en el daemon (cwd del workspace). API y browser no ejecutan `npm test` ni leen `package.json` del servidor.
2. Sin daemon bound, `agent.turn.request` falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. No queda un proceso de test huérfano.
3. Tests/linter son tools visuales (`kind: "verify"` | `"lint"`) sobre **Bash**. No hay séptima tool en `DEFAULT_CLAUDE_TOOLS`. Misma visualización para Claude y Cursor.
4. Lecturas (read/grep/glob) no piden confirmación. Un test **no** es lectura: en `ask` pide aprobación **como cualquier bash**. Sin skip automático.
5. `plan`: no se ejecuta bash. Tests que escribirían coverage/snapshots se deniegan con `PLAN_VERIFY_MUTATION_DENIED` (mensaje específico). El agente **puede proponer** el comando en el assistant. El disco no cambia.
6. `auto` + edits + pacto en reglas → el daemon **intenta** ese comando (el modelo o, si no lo llamó, un spawn sintético). Sin pacto: **cero** heurística `npm test` / `cargo test` / `pytest`.
7. Output se trunca a `VERIFY_OUTPUT_MAX_CHARS` (mismo 8000 que tools) **antes** de persistir, broadcast y pintar. El marcador es visible.
8. Timeout `VERIFY_TIMEOUT_MS`: la tool pasa a `status: "error"` con `VERIFY_TIMEOUT_ERROR`; `chat.stream.error`; tools in-flight fallan; `agent.turn.ended` en el `finally`. El chat **no** queda busy. Sin continuación del LLM.
9. Fallo de verificación (exit ≠ 0): tool `error`, `metadata.verification.status = "failed"`, banner en Web/TUI/watch, y el assistant **explica** (continuación única si el pacto corrió después del modelo). Nunca reescribir el `content` del assistant.
10. Linter/diagnostics son tool o bloque **aparte**. El set de diffs del turn (plan 6) **no** se sustituye ni se oculta.
11. Aprobaciones **una a una** (plan 13). Un test en `ask` no introduce lote ni “siempre permitir”. Headless **no** auto-aprueba tests.
12. 1 turn por daemon. El watchdog de verify no abre un segundo turn.
13. Claude es el provider ejecutable. Cursor vinculado no ejecuta aquí; cuando el plan 4 lo haga, reutiliza classify + pacto + timeout.
14. Un usuario = su vault. Las reglas de usuario que pactan `verify` filtran por `userId` (plan 9). Sin org ni roles.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, GitHub Action, JSON schema de CI, red/sandbox de bash.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `VERIFY_KINDS` | `"verify"` \| `"lint"` \| `"bash"` |
| `VERIFY_TIMEOUT_MS` | `120_000` |
| `VERIFY_KILL_GRACE_MS` | `1_000` |
| `VERIFY_OUTPUT_MAX_CHARS` | `8000` (igual que `TOOL_OUTPUT_MAX_CHARS`) |
| `VERIFY_WATCH_CHARS` | `500` |
| `VERIFY_CMD_MAX_CHARS` | `500` |
| `VERIFY_CONTINUATION_MAX` | `1` |
| `PLAN_VERIFY_MUTATION_DENIED` | `"Plan mode: tests that write coverage or snapshots are disabled. Propose the command instead."` |
| `VERIFY_TIMEOUT_ERROR` | `"Verification timed out after 120s"` |
| `VERIFY_SKIPPED_NO_RULE` | `"No verification command in workspace rules — not inventing a test suite"` |
| `VERIFY_EXPLAIN_PROMPT` | `"Verification failed. The tool output is above. Explain the failure to the user. Do not claim success. Do not re-run the suite unless the user asked to fix it."` |
| `VERIFY_PLAN_HINT` | `"You are in plan mode. You may propose the verification command; do not run it. Do not write coverage or snapshots."` |
| `VERIFY_PREAMBLE` | ver Task 1 (`VERIFY_PREAMBLE`) |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` (reusar literal existente) |

Si `TOOL_OUTPUT_MAX_CHARS` ya existe en `cli/src/llm/tool-display.ts`, **no** duplicar el número: `export const VERIFY_OUTPUT_MAX_CHARS = TOOL_OUTPUT_MAX_CHARS`. Si no existe, definir `8000` aquí.

Tipos (congelados):

```ts
export const VERIFY_KINDS = ["verify", "lint", "bash"] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export const VERIFY_STATUSES = [
  "passed",
  "failed",
  "timeout",
  "skipped",
  "proposed",
  "awaiting_approval",
] as const;
export type VerificationStatus = (typeof VERIFY_STATUSES)[number];

export const VERIFY_SOURCES = ["pact", "user", "agent", "prompt"] as const;
export type VerificationSource = (typeof VERIFY_SOURCES)[number];

export type VerificationMetadata = {
  status: VerificationStatus;
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  source: VerificationSource;
  truncated: boolean;
  silentSuccess?: boolean;
};

export type VerifyRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
};
```

Nombres de events WS (ninguno nuevo):

| Tipo | Dirección | Semántica extra en esta fase |
|---|---|---|
| `chat.tool.start` | daemon → API → broadcast | `metadata.kind`, `metadata.command`, `metadata.source` |
| `chat.tool.result` / `chat.tool.update` | daemon → API → broadcast | `status: error` si exit ≠ 0 o timeout; `exitCode`, `timedOut` |
| `chat.stream.end` | daemon → API → broadcast | `metadata.verification` en el assistant; payload también lleva `verification` |
| `chat.stream.error` | daemon → API → broadcast | timeout de verify: `error = VERIFY_TIMEOUT_ERROR` |
| `agent.turn.ended` | daemon → API → broadcast | **siempre** en `finally` (el chat acepta otro turn) |

HTTP: ninguno nuevo. `chat.get` ya devuelve `metadata`; un reload reconstruye test/lint y el banner.

Clases de tool (igual que planes 2–3; **no** cambiar):

- **read:** `Read`, `Grep`, `Glob`, `LS` → nunca approval, nunca verify.
- **write:** `Write`, `Edit`, `NotebookEdit`, `Bash` → gate de modo. Bash de test **es write**.
- **other:** misma regla que write.

Flags que convierten un verify en **mutante** (plan mode deny específico):

```
--coverage, --collectCoverage, --collect-coverage,
--updateSnapshot, --update-snapshots, --snapshot-update,
--watch, --watchAll, --watch-all,
nyc , c8 , coverage/
```

`-u` solo cuenta como mutante si el runner es `jest` o `vitest`.

---

## Task 1: Módulos puros — classify, pacto, outcome, constantes

**Files:**

- Create: `cli/src/llm/verify-constants.ts`
- Create: `cli/src/llm/verify-classify.ts`
- Create: `cli/src/llm/verify-pact.ts`
- Create: `cli/src/llm/verify-outcome.ts`
- Test: `cli/src/llm/verify-classify.test.ts`
- Test: `cli/src/llm/verify-pact.test.ts`
- Test: `cli/src/llm/verify-outcome.test.ts`
- Modify: `cli/package.json`

Sin I/O de disco ni red. TUI importa desde `cli/src/llm/…`. Web **no** importa CLI: Task 8 duplica labels.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/verify-constants.ts`:

```ts
export const VERIFY_KINDS = ["verify", "lint", "bash"] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export const VERIFY_STATUSES = [
  "passed",
  "failed",
  "timeout",
  "skipped",
  "proposed",
  "awaiting_approval",
] as const;
export type VerificationStatus = (typeof VERIFY_STATUSES)[number];

export const VERIFY_SOURCES = ["pact", "user", "agent", "prompt"] as const;
export type VerificationSource = (typeof VERIFY_SOURCES)[number];

export const VERIFY_TIMEOUT_MS = 120_000;
export const VERIFY_KILL_GRACE_MS = 1_000;
export const VERIFY_CMD_MAX_CHARS = 500;
export const VERIFY_WATCH_CHARS = 500;
export const VERIFY_CONTINUATION_MAX = 1;
/** Same cap as agent-tools `TOOL_OUTPUT_MAX_CHARS`. If `tool-display.ts` exists, reexport it instead of this literal. */
export const VERIFY_OUTPUT_MAX_CHARS = 8000;

export const PLAN_VERIFY_MUTATION_DENIED =
  "Plan mode: tests that write coverage or snapshots are disabled. Propose the command instead.";

export const VERIFY_TIMEOUT_ERROR = "Verification timed out after 120s";

export const VERIFY_SKIPPED_NO_RULE =
  "No verification command in workspace rules — not inventing a test suite";

export const VERIFY_EXPLAIN_PROMPT =
  "Verification failed. The tool output is above. Explain the failure to the user. Do not claim success. Do not re-run the suite unless the user asked to fix it.";

export const VERIFY_PLAN_HINT =
  "You are in plan mode. You may propose the verification command; do not run it. Do not write coverage or snapshots.";

export const VERIFY_PREAMBLE = `Verification policy:
- Tests and linters run as Bash tools. They are not reads: in ask they need approval; in plan they do not execute.
- If workspace rules define a verify command, use that exact command after edits. Do not invent a test suite (do not guess npm test, cargo test, or pytest).
- If the user asked to run tests and no pact command exists, use the command they typed or ask which command. Do not invent.
- If verification fails (non-zero exit), explain the failure. Never claim the turn succeeded.
- In plan mode, propose the command; do not run tests that write coverage or snapshots.
- Linter/diagnostics are a separate tool. They do not replace the file diff.`;

export type VerificationMetadata = {
  status: VerificationStatus;
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  source: VerificationSource;
  truncated: boolean;
  silentSuccess?: boolean;
};

export function isVerifyKind(v: unknown): v is VerifyKind {
  return v === "verify" || v === "lint" || v === "bash";
}
```

Si `cli/src/llm/tool-display.ts` ya exporta `TOOL_OUTPUT_MAX_CHARS`, sustituir el literal por:

```ts
import { TOOL_OUTPUT_MAX_CHARS } from "./tool-display";
export const VERIFY_OUTPUT_MAX_CHARS = TOOL_OUTPUT_MAX_CHARS;
```

- [ ] Crear `cli/src/llm/verify-classify.ts`:

```ts
import type { VerifyKind } from "./verify-constants";
import { VERIFY_CMD_MAX_CHARS } from "./verify-constants";

const VERIFY_RUNNERS = [
  "npm test",
  "npm run test",
  "npx vitest",
  "npx jest",
  "npx mocha",
  "pnpm test",
  "pnpm run test",
  "yarn test",
  "yarn run test",
  "bun test",
  "bun run test",
  "cargo test",
  "go test",
  "pytest",
  "python -m pytest",
  "python -m unittest",
  "mvn test",
  "gradle test",
  "dotnet test",
  "make test",
  "rake test",
  "mix test",
] as const;

const LINT_RUNNERS = [
  "eslint",
  "biome check",
  "biome lint",
  "ruff check",
  "ruff",
  "flake8",
  "pylint",
  "mypy",
  "tsc --noemit",
  "tsc -b --noemit",
  "typos",
  "shellcheck",
  "clippy",
  "cargo clippy",
  "prettier --check",
  "golangci-lint",
  "rubocop",
  "ktlint",
  "deno lint",
] as const;

const MUTATING_FLAGS = [
  "--coverage",
  "--collectcoverage",
  "--collect-coverage",
  "--updatesnapshot",
  "--update-snapshots",
  "--snapshot-update",
  "--watchall",
  "--watch-all",
  "--watch",
] as const;

function stripEnvPrefix(cmd: string): string {
  return cmd.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/,
    "",
  );
}

function normalizeCommand(raw: string): string {
  return stripEnvPrefix(raw.trim().replace(/\s+/g, " ")).slice(
    0,
    VERIFY_CMD_MAX_CHARS,
  );
}

function haystack(cmd: string): string {
  return normalizeCommand(cmd).toLowerCase();
}

function startsWithRunner(cmd: string, runner: string): boolean {
  const h = haystack(cmd);
  const r = runner.toLowerCase();
  return h === r || h.startsWith(`${r} `) || h.includes(` ${r} `);
}

export function classifyBashKind(command: string): VerifyKind {
  const h = haystack(command);
  if (!h) return "bash";
  for (const r of LINT_RUNNERS) {
    if (startsWithRunner(h, r)) return "lint";
  }
  // tsc without --noEmit is still lint-ish when invoked as typecheck
  if (/\btsc\b/.test(h) && /--noemit|--pretty\s+false/.test(h)) return "lint";
  for (const r of VERIFY_RUNNERS) {
    if (startsWithRunner(h, r)) return "verify";
  }
  if (/\b(vitest|jest|mocha|pytest)\b/.test(h)) return "verify";
  return "bash";
}

export function isMutatingVerify(command: string): boolean {
  const h = haystack(command);
  if (h.includes("coverage/") || /\bnyc\b/.test(h) || /\bc8\b/.test(h)) {
    return true;
  }
  for (const f of MUTATING_FLAGS) {
    if (h.includes(f)) return true;
  }
  const jestOrVitest = /\b(jest|vitest)\b/.test(h);
  if (jestOrVitest && /(^|\s)-u(\s|$)/.test(h)) return true;
  return false;
}

export function extractBashCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const cmd = rec.command ?? rec.cmd ?? rec.shell;
  return typeof cmd === "string" ? cmd : "";
}

const ASK_TEST_RE =
  /\b((run|corre[rn]?|ejecuta)\b.{0,40}\btests?|\btests?\b.{0,20}\b(por\s?fa|please)?|npm\s+test|bun\s+test|cargo\s+test|pytest)\b/i;

export function promptAsksForTests(prompt: string): boolean {
  return ASK_TEST_RE.test(prompt);
}

/** User typed the command themselves — not an invented suite. */
export function extractExplicitTestCommand(prompt: string): string | null {
  const m =
    /(?:run|corre(?:r)?|ejecuta)\s+(`[^`]+`|npm test(?:[^\n]*)|bun test(?:[^\n]*)|pnpm test(?:[^\n]*)|yarn test(?:[^\n]*)|cargo test(?:[^\n]*)|go test(?:[^\n]*)|pytest(?:[^\n]*)|make test(?:[^\n]*))/i.exec(
      prompt,
    );
  if (!m?.[1]) return null;
  const cmd = m[1].replace(/^`|`$/g, "").trim();
  return cmd ? normalizeCommand(cmd) : null;
}

export function sameCommand(a: string, b: string): boolean {
  return haystack(a) === haystack(b);
}
```

- [ ] Crear `cli/src/llm/verify-pact.ts`:

```ts
import { VERIFY_CMD_MAX_CHARS } from "./verify-constants";

export type PactRule = {
  layer: "user" | "project" | "local";
  body: string;
  verifyCommand?: string | null;
  enabled?: boolean;
};

function normalizeCmd(raw: string): string | null {
  const cmd = raw.trim().replace(/^`|`$/g, "").replace(/\s+/g, " ");
  if (!cmd) return null;
  return cmd.slice(0, VERIFY_CMD_MAX_CHARS);
}

function parseFrontmatterLite(raw: string): {
  attrs: Record<string, string>;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { attrs: {}, body: text };
  const rest = text.slice(3);
  const end = rest.search(/\r?\n---[ \t]*\r?\n/);
  if (end < 0) return { attrs: {}, body: text };
  const fm = rest.slice(0, end).replace(/^\r?\n/, "");
  const after = rest.slice(end).replace(/^\r?\n---[ \t]*\r?\n/, "");
  const attrs: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = /^(verifyCommand|verify|test)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    attrs[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { attrs, body: after };
}

export function extractVerifyCommandFromText(raw: string): string | null {
  const { attrs, body } = parseFrontmatterLite(raw);
  const fm = attrs.verifyCommand || attrs.verify || attrs.test;
  if (fm) return normalizeCmd(fm);
  const patterns = [
    /^verify(?:Command)?:\s*(.+)$/im,
    /^verification:\s*(.+)$/im,
    /^test(?:s)?(?: command)?:\s*(.+)$/im,
  ];
  for (const re of patterns) {
    const m = re.exec(body);
    if (m?.[1]) return normalizeCmd(m[1]);
  }
  return null;
}

/**
 * local > project > user. Disabled rules skipped.
 * Empty → null. NEVER defaults to `npm test`.
 */
export function pactCommandFromRules(rules: PactRule[]): string | null {
  const layers: Array<PactRule["layer"]> = ["local", "project", "user"];
  for (const layer of layers) {
    const slice = rules.filter((r) => r.layer === layer && r.enabled !== false);
    for (let i = slice.length - 1; i >= 0; i--) {
      const r = slice[i]!;
      const direct = r.verifyCommand?.trim();
      if (direct) return normalizeCmd(direct);
      const fromBody = extractVerifyCommandFromText(r.body || "");
      if (fromBody) return fromBody;
    }
  }
  return null;
}
```

- [ ] Crear `cli/src/llm/verify-outcome.ts`:

```ts
import type {
  VerificationMetadata,
  VerificationSource,
} from "./verify-constants";
import type { VerifyKind } from "./verify-constants";

const SUCCESS_RE =
  /\b(done|success|all tests passed|looks good|lgtm|listo|éxito|sin errores|passed)\b/i;
const FAIL_ACK_RE =
  /\b(fail|failed|failure|error|timeout|timed out|rojo|fall[oó]|fracas|no pasa(?:ron)?)\b/i;

export function statusFromRun(input: {
  timedOut: boolean;
  exitCode: number;
}): VerificationMetadata["status"] {
  if (input.timedOut) return "timeout";
  if (input.exitCode === 0) return "passed";
  return "failed";
}

export function buildVerificationMetadata(input: {
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  source: VerificationSource;
  truncated: boolean;
  assistantText?: string;
}): VerificationMetadata {
  const status = input.timedOut
    ? "timeout"
    : input.exitCode == null
      ? "skipped"
      : input.exitCode === 0
        ? "passed"
        : "failed";
  const meta: VerificationMetadata = {
    status,
    kind: input.kind,
    command: input.command,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    source: input.source,
    truncated: input.truncated,
  };
  if (
    (status === "failed" || status === "timeout") &&
    isSilentSuccess(input.assistantText ?? "", meta)
  ) {
    meta.silentSuccess = true;
  }
  return meta;
}

export function isSilentSuccess(
  assistantText: string,
  v: Pick<VerificationMetadata, "status">,
): boolean {
  if (v.status !== "failed" && v.status !== "timeout") return false;
  if (FAIL_ACK_RE.test(assistantText)) return false;
  if (!assistantText.trim()) return true;
  return SUCCESS_RE.test(assistantText);
}

export function verificationHeadline(v: VerificationMetadata): string {
  const bit =
    v.status === "passed"
      ? "ok"
      : v.status === "failed"
        ? "failed"
        : v.status;
  return `${v.kind === "lint" ? "lint" : "test"} · ${bit}  ${v.command}`;
}

export function formatVerifyToolOutput(input: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  maxChars: number;
}): string {
  const parts: string[] = [];
  if (input.timedOut) parts.push("timed out");
  parts.push(`exit ${input.exitCode}`);
  const body = [input.stdout, input.stderr].filter(Boolean).join("\n");
  const text = `${parts.join(" · ")}\n${body}`.replace(/\s+$/, "");
  if (text.length <= input.maxChars) return text;
  return `${text.slice(0, input.maxChars)}\n[truncated: showing ${input.maxChars} of ${text.length} chars]`;
}

export function kindFromToolMeta(
  kind: unknown,
  fallback: VerifyKind,
): VerifyKind {
  if (kind === "verify" || kind === "lint" || kind === "bash") return kind;
  return fallback;
}
```

- [ ] Crear `cli/src/llm/verify-classify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  classifyBashKind,
  extractExplicitTestCommand,
  isMutatingVerify,
  promptAsksForTests,
} from "./verify-classify";

describe("classifyBashKind", () => {
  test("npm test is verify", () => {
    expect(classifyBashKind("npm test")).toBe("verify");
    expect(classifyBashKind("bun test src/foo.test.ts")).toBe("verify");
    expect(classifyBashKind("cargo test --lib")).toBe("verify");
  });

  test("eslint is lint", () => {
    expect(classifyBashKind("npx eslint src")).toBe("lint");
    expect(classifyBashKind("tsc --noEmit")).toBe("lint");
    expect(classifyBashKind("ruff check .")).toBe("lint");
  });

  test("plain bash stays bash", () => {
    expect(classifyBashKind("ls -la")).toBe("bash");
    expect(classifyBashKind("echo hello")).toBe("bash");
  });

  test("does not treat env-prefixed echo as verify", () => {
    expect(classifyBashKind("FOO=1 echo npm test")).toBe("bash");
  });
});

describe("isMutatingVerify", () => {
  test("coverage and snapshots", () => {
    expect(isMutatingVerify("npm test -- --coverage")).toBe(true);
    expect(isMutatingVerify("npx jest --updateSnapshot")).toBe(true);
    expect(isMutatingVerify("npx vitest -u")).toBe(true);
    expect(isMutatingVerify("bun test")).toBe(false);
    expect(isMutatingVerify("ls -u")).toBe(false);
  });
});

describe("promptAsksForTests", () => {
  test("spanish and english", () => {
    expect(promptAsksForTests("cambia X y corre los tests")).toBe(true);
    expect(promptAsksForTests("run the tests after editing")).toBe(true);
    expect(promptAsksForTests("explica el archivo")).toBe(false);
  });
});

describe("extractExplicitTestCommand", () => {
  test("user typed the command", () => {
    expect(extractExplicitTestCommand("cambia X y corre npm test")).toBe(
      "npm test",
    );
  });

  test("no command in prompt", () => {
    expect(extractExplicitTestCommand("corre los tests")).toBeNull();
  });
});
```

- [ ] Crear `cli/src/llm/verify-pact.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  extractVerifyCommandFromText,
  pactCommandFromRules,
} from "./verify-pact";

describe("extractVerifyCommandFromText", () => {
  test("frontmatter verify", () => {
    const raw = `---
verify: bun test
---
# AGENTS
`;
    expect(extractVerifyCommandFromText(raw)).toBe("bun test");
  });

  test("body Verification line", () => {
    expect(
      extractVerifyCommandFromText("# Rules\n\nVerification: npm test\n"),
    ).toBe("npm test");
  });

  test("empty → null, never npm test by default", () => {
    expect(extractVerifyCommandFromText("# hello\n\nBe kind.\n")).toBeNull();
  });
});

describe("pactCommandFromRules", () => {
  test("local overrides project", () => {
    expect(
      pactCommandFromRules([
        { layer: "project", body: "Verification: npm test" },
        { layer: "local", body: "verify: bun test" },
      ]),
    ).toBe("bun test");
  });

  test("no rules → null (do not invent)", () => {
    expect(pactCommandFromRules([])).toBeNull();
    expect(
      pactCommandFromRules([{ layer: "project", body: "no tests here" }]),
    ).toBeNull();
  });

  test("disabled skipped", () => {
    expect(
      pactCommandFromRules([
        { layer: "user", body: "verify: npm test", enabled: false },
      ]),
    ).toBeNull();
  });
});
```

- [ ] Crear `cli/src/llm/verify-outcome.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildVerificationMetadata,
  formatVerifyToolOutput,
  isSilentSuccess,
  verificationHeadline,
} from "./verify-outcome";

describe("isSilentSuccess", () => {
  test("cheerful text after failed tests is silent", () => {
    expect(
      isSilentSuccess("All tests passed. Done.", { status: "failed" }),
    ).toBe(true);
  });

  test("explanation is not silent", () => {
    expect(
      isSilentSuccess("The tests failed in foo.test.ts because X", {
        status: "failed",
      }),
    ).toBe(false);
  });

  test("passed is never silent-success", () => {
    expect(isSilentSuccess("Done.", { status: "passed" })).toBe(false);
  });
});

describe("buildVerificationMetadata", () => {
  test("timeout", () => {
    const v = buildVerificationMetadata({
      kind: "verify",
      command: "npm test",
      exitCode: null,
      timedOut: true,
      source: "pact",
      truncated: false,
    });
    expect(v.status).toBe("timeout");
    expect(v.timedOut).toBe(true);
  });
});

describe("formatVerifyToolOutput", () => {
  test("truncates with marker", () => {
    const out = formatVerifyToolOutput({
      stdout: "a".repeat(50),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      truncated: false,
      maxChars: 20,
    });
    expect(out).toContain("[truncated:");
    expect(out.startsWith("exit 1")).toBe(true);
  });
});

describe("verificationHeadline", () => {
  test("failed test", () => {
    expect(
      verificationHeadline({
        status: "failed",
        kind: "verify",
        command: "npm test",
        exitCode: 1,
        timedOut: false,
        source: "pact",
        truncated: false,
      }),
    ).toBe("test · failed  npm test");
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/verify-classify.test.ts src/llm/verify-pact.test.ts src/llm/verify-outcome.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/verify-constants.ts cli/src/llm/verify-classify.ts \
  cli/src/llm/verify-pact.ts cli/src/llm/verify-outcome.ts \
  cli/src/llm/verify-classify.test.ts cli/src/llm/verify-pact.test.ts \
  cli/src/llm/verify-outcome.test.ts cli/package.json
git commit -m "feat(verify): classify test/lint bash and parse pact command from rules"
```

---

## Task 2: Reglas — `verifyCommand` en el bundle y el prompt

**Files:**

- Modify: `cli/src/llm/rules-parse.ts` (si el plan 9 lo creó; si no, no inventar el parser completo — el extractor de Task 1 basta y esta task solo enchufa)
- Modify: `cli/src/llm/rules-merge.ts`
- Modify: `cli/src/llm/rules-constants.ts`
- Test: `cli/src/llm/rules-parse.test.ts` (extender)
- Test: `cli/src/llm/rules-merge.test.ts` (extender)
- Modify: `cli/src/llm/verify-pact.ts` (helper `pactCommandFromBundle`)

Si `rules-parse.ts` **no** existe todavía, crear solo `pactCommandFromBundle` como alias documentado y un test que use `PactRule[]`. No reimplementar el loader de AGENTS.md.

- [ ] Si `cli/src/llm/rules-parse.ts` existe, ampliar `ParsedRuleFile`:

```ts
export type ParsedRuleFile = {
  title: string;
  body: string;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  globs: string[];
  alwaysApply: boolean;
  truncated: boolean;
  verifyCommand: string | null;
};
```

En `parseRuleFile`, después de `alwaysApply`:

```ts
import { extractVerifyCommandFromText } from "./verify-pact";

const fmVerify =
  typeof attrs.verifyCommand === "string"
    ? attrs.verifyCommand
    : typeof attrs.verify === "string"
      ? attrs.verify
      : null;
const verifyCommand =
  (fmVerify && fmVerify.trim()) || extractVerifyCommandFromText(raw);

return {
  title: titleFromBodyOrPath(body, pathOrFallback, attrs.title),
  body,
  disallowTools: disallow,
  allowTools: allow,
  globs,
  alwaysApply,
  truncated,
  verifyCommand: verifyCommand || null,
};
```

`toRuleSource` copia `verifyCommand` al `RuleSource`.

- [ ] Si `cli/src/llm/rules-merge.ts` existe, ampliar `RuleSource` y `RulesBundle`:

```ts
export type RuleSource = {
  layer: RuleLayer;
  id?: string;
  title: string;
  body: string;
  path?: string;
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  chars: number;
  truncated: boolean;
  globs?: string[];
  alwaysApply?: boolean;
  verifyCommand?: string | null;
};

export type RulesBundle = {
  user: RuleSource[];
  project: RuleSource[];
  local: RuleSource[];
  userRulesEnabled: boolean;
  disallowedTools: CanonicalDisallowTool[];
  verifyCommand: string | null;
};
```

Tras el merge de capas, asignar:

```ts
import { pactCommandFromRules } from "./verify-pact";

bundle.verifyCommand = pactCommandFromRules([
  ...bundle.user,
  ...bundle.project,
  ...bundle.local,
]);
```

En `formatRulesPrompt`, si `bundle.verifyCommand`:

```ts
const verifyLine = bundle.verifyCommand
  ? `\n\nWorkspace verification command (use this exact command after edits; do not invent another): \`${bundle.verifyCommand}\``
  : "";
```

Concatenar `verifyLine` **después** de `extra` y **antes** del cap `RULES_PROMPT_MAX_CHARS`.

- [ ] Añadir en `cli/src/llm/verify-pact.ts`:

```ts
export function pactCommandFromBundle(bundle: {
  user: PactRule[];
  project: PactRule[];
  local: PactRule[];
  verifyCommand?: string | null;
}): string | null {
  if (bundle.verifyCommand && bundle.verifyCommand.trim()) {
    return bundle.verifyCommand.trim();
  }
  return pactCommandFromRules([
    ...bundle.user,
    ...bundle.project,
    ...bundle.local,
  ]);
}
```

- [ ] Tests a añadir (en el archivo de plan 9 si existe; si no, en `verify-pact.test.ts`):

```ts
test("AGENTS.md with verify: npm test is the pact", () => {
  expect(
    extractVerifyCommandFromText(`---
verify: npm test
---
# AGENTS
`),
  ).toBe("npm test");
});

test("no invent when AGENTS has no verify", () => {
  expect(extractVerifyCommandFromText("# AGENTS\n\nUse bun.\n")).toBeNull();
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/verify-pact.test.ts src/llm/rules-parse.test.ts src/llm/rules-merge.test.ts
```

Si `rules-*.test.ts` no existen, correr solo `verify-pact.test.ts`. Esperado: pasan. No fallar el task porque plan 9 no aterrizó.

- [ ] Commit:

```bash
git add cli/src/llm/verify-pact.ts cli/src/llm/verify-pact.test.ts \
  cli/src/llm/rules-parse.ts cli/src/llm/rules-merge.ts \
  cli/src/llm/rules-constants.ts cli/src/llm/rules-parse.test.ts \
  cli/src/llm/rules-merge.test.ts
git commit -m "feat(verify): read verifyCommand from rules with local > project > user"
```

Si solo cambió `verify-pact.ts`, el `git add` de archivos inexistentes se omite (no usar `git add -A`).

---

## Task 3: Spawn acotado — timeout mata el proceso

**Files:**

- Create: `cli/src/llm/verify-run.ts`
- Test: `cli/src/llm/verify-run.test.ts`

Este spawn lo usa el **pacto post-edit** (el daemon corre el comando). El Bash del SDK se acota en Task 4 vía `updatedInput.timeout` + watchdog.

- [ ] Crear `cli/src/llm/verify-run.ts`:

```ts
import {
  VERIFY_KILL_GRACE_MS,
  VERIFY_OUTPUT_MAX_CHARS,
  VERIFY_TIMEOUT_MS,
} from "./verify-constants";
import { formatVerifyToolOutput } from "./verify-outcome";

export type VerifyRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
};

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars]`,
    truncated: true,
  };
}

export async function runVerifyCommand(input: {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<VerifyRunResult> {
  const timeoutMs = input.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const maxChars = input.maxChars ?? VERIFY_OUTPUT_MAX_CHARS;
  const proc = Bun.spawn(["bash", "-lc", input.command], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, VERIFY_KILL_GRACE_MS);
  }, timeoutMs);

  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const [stdoutRaw, stderrRaw, code] = await Promise.all([
    stdoutP,
    stderrP,
    proc.exited,
  ]);
  clearTimeout(killer);

  const stdout = stdoutRaw.replace(/\s+$/, "");
  const stderr = stderrRaw.replace(/\s+$/, "");
  const combinedRaw = formatVerifyToolOutput({
    stdout,
    stderr,
    exitCode: timedOut ? 124 : code,
    timedOut,
    truncated: false,
    maxChars,
  });
  const cut = truncate(combinedRaw, maxChars);
  const exitCode = timedOut ? 124 : code;
  return {
    ok: !timedOut && exitCode === 0,
    stdout,
    stderr,
    combined: cut.text,
    exitCode,
    timedOut,
    truncated: cut.truncated,
  };
}
```

`bash -lc` corre en `cwd`. No hay `cd /`. Red/sandbox es plan 26. `CI=1` evita watchers interactivos de Jest/Vitest.

- [ ] Crear `cli/src/llm/verify-run.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runVerifyCommand } from "./verify-run";

const cwd = mkdtempSync(join(tmpdir(), "chavez-verify-"));

describe("runVerifyCommand", () => {
  test("exit 0 is ok and stdout is the tool body", async () => {
    const r = await runVerifyCommand({
      cwd,
      command: "echo hello-verify",
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.combined).toContain("hello-verify");
    expect(r.combined.startsWith("exit 0")).toBe(true);
  });

  test("exit 1 is not ok — not silent success material", async () => {
    const r = await runVerifyCommand({
      cwd,
      command: "echo fail-out; echo fail-err 1>&2; exit 7",
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.combined).toContain("fail-out");
    expect(r.combined).toContain("fail-err");
  });

  test("hanging command times out and is killed", async () => {
    const r = await runVerifyCommand({
      cwd,
      command: "sleep 30",
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(124);
    expect(r.combined.toLowerCase()).toContain("timed out");
  });

  test("huge stdout is truncated", async () => {
    writeFileSync(join(cwd, "big.sh"), "python3 -c 'print(\"x\"*20000)'");
    const r = await runVerifyCommand({
      cwd,
      command: "python3 -c 'print(\"x\"*20000)'",
      timeoutMs: 5_000,
      maxChars: 800,
    });
    expect(r.combined.length).toBeLessThanOrEqual(800 + 80);
    expect(r.combined).toContain("[truncated:");
    expect(r.truncated).toBe(true);
  });
});
```

Si `python3` no está, sustituir el caso huge por `yes x | head -c 20000` o `printf '%0.sx' {1..20000}` — el assert es el marcador, no el intérprete.

- [ ] Correr:

```bash
cd cli && bun test src/llm/verify-run.test.ts
```

Esperado: todos pasan. El caso `sleep 30` termina en ~200ms+grace, no en 30s.

- [ ] Commit:

```bash
git add cli/src/llm/verify-run.ts cli/src/llm/verify-run.test.ts
git commit -m "feat(verify): spawn workspace tests with 120s timeout and truncated stdout"
```

---

## Task 4: Gate — plan no muta, ask no salta, auto inyecta timeout

**Files:**

- Create: `cli/src/llm/verify-gate.ts`
- Test: `cli/src/llm/verify-gate.test.ts`
- Modify: `cli/src/llm/can-use-tool.ts` (si el plan 3 lo creó; si no, crearlo aquí con el mínimo de `decideCanUseTool` + verify)
- Modify: `cli/src/llm/execution-gate.ts` (no cambiar `gateClass`: Bash sigue write)
- Modify: `cli/src/llm/claude-runner.ts`
- Test: `cli/src/llm/can-use-tool.test.ts` o `cli/src/llm/claude-runner.mode.test.ts` (extender)

El SDK **no** ejecuta el bash de test hasta que `canUseTool` resuelve `allow`. En `plan`, nunca. En `ask`, después de approve. Un test **no** se reclasifica como read.

- [ ] Crear `cli/src/llm/verify-gate.ts`:

```ts
import type { ExecutionMode } from "./execution-mode";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { PLAN_VERIFY_MUTATION_DENIED } from "./verify-constants";
import {
  classifyBashKind,
  extractBashCommand,
  isMutatingVerify,
} from "./verify-classify";
import type { VerifyKind } from "./verify-constants";
import { VERIFY_TIMEOUT_MS } from "./verify-constants";

export type VerifyGate = {
  kind: VerifyKind;
  command: string;
  mutating: boolean;
  decision: "allow" | "deny" | "ask" | "passthrough";
  message?: string;
  updatedInput?: Record<string, unknown>;
};

export function gateVerifyBash(input: {
  mode: ExecutionMode;
  sdkName: string;
  toolInput: Record<string, unknown> | null;
}): VerifyGate {
  const command = extractBashCommand(input.toolInput);
  const kind =
    input.sdkName === "Bash" || input.sdkName === "bash"
      ? classifyBashKind(command)
      : "bash";
  const mutating = kind !== "bash" && isMutatingVerify(command);

  if (kind === "bash") {
    return { kind, command, mutating: false, decision: "passthrough" };
  }

  if (input.mode === "plan") {
    return {
      kind,
      command,
      mutating,
      decision: "deny",
      message: mutating
        ? PLAN_VERIFY_MUTATION_DENIED
        : PLAN_MUTATION_DENIED,
    };
  }

  if (input.mode === "ask") {
    return { kind, command, mutating, decision: "ask" };
  }

  // auto
  const nextInput = {
    ...(input.toolInput || {}),
    command,
    timeout: VERIFY_TIMEOUT_MS,
  };
  return {
    kind,
    command,
    mutating,
    decision: "allow",
    updatedInput: nextInput,
  };
}
```

Si `execution-mode.ts` no existe, inlinear:

```ts
export type ExecutionMode = "plan" | "auto" | "ask";
const PLAN_MUTATION_DENIED =
  "Plan mode: write/edit/bash are disabled. Switch to ask or auto to apply changes.";
```

en `verify-gate.ts` (mismo literal que el plan 3; no inventar otro wording).

- [ ] Crear `cli/src/llm/verify-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PLAN_VERIFY_MUTATION_DENIED } from "./verify-constants";
import { gateVerifyBash } from "./verify-gate";

describe("gateVerifyBash", () => {
  test("plan denies snapshot update with specific message", () => {
    const g = gateVerifyBash({
      mode: "plan",
      sdkName: "Bash",
      toolInput: { command: "npx jest --updateSnapshot" },
    });
    expect(g.decision).toBe("deny");
    expect(g.message).toBe(PLAN_VERIFY_MUTATION_DENIED);
    expect(g.mutating).toBe(true);
  });

  test("plan denies non-mutating tests too (bash is disabled) but may propose", () => {
    const g = gateVerifyBash({
      mode: "plan",
      sdkName: "Bash",
      toolInput: { command: "npm test" },
    });
    expect(g.decision).toBe("deny");
    expect(g.kind).toBe("verify");
  });

  test("ask never treats tests as reads", () => {
    const g = gateVerifyBash({
      mode: "ask",
      sdkName: "Bash",
      toolInput: { command: "bun test" },
    });
    expect(g.decision).toBe("ask");
    expect(g.kind).toBe("verify");
  });

  test("auto allows and injects timeout", () => {
    const g = gateVerifyBash({
      mode: "auto",
      sdkName: "Bash",
      toolInput: { command: "npm test" },
    });
    expect(g.decision).toBe("allow");
    expect(g.updatedInput?.timeout).toBe(120_000);
  });

  test("plain bash passthrough", () => {
    const g = gateVerifyBash({
      mode: "auto",
      sdkName: "Bash",
      toolInput: { command: "ls" },
    });
    expect(g.decision).toBe("passthrough");
  });
});
```

- [ ] En `cli/src/llm/can-use-tool.ts` (crear si falta, con el cuerpo de execution-modes Task 3 + este hook). **Antes** de `gateMutation`, si `toolName` es `Bash`:

```ts
import { gateVerifyBash } from "./verify-gate";

// inside decideCanUseTool, after denyIfEscapes, before gateMutation:
if (input.toolName === "Bash" || input.toolName === "bash") {
  const vg = gateVerifyBash({
    mode: input.executionMode,
    sdkName: input.toolName,
    toolInput: input.toolInput,
  });
  if (vg.decision === "deny") {
    return { behavior: "deny", message: vg.message || PLAN_MUTATION_DENIED };
  }
  if (vg.decision === "ask") {
    const outcome = (await input.ask?.()) ?? "deny";
    if (outcome === "approve") {
      return {
        behavior: "allow",
        updatedInput: {
          ...input.toolInput,
          timeout: 120_000,
        },
      };
    }
    return {
      behavior: "deny",
      message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
    };
  }
  if (vg.decision === "allow") {
    return { behavior: "allow", updatedInput: vg.updatedInput };
  }
  // passthrough → gateMutation as today
}
```

El tipo `PermissionDecision` gana `updatedInput?: Record<string, unknown>`. `claude-runner.ts` `canUseTool` **devuelve** ese objeto al SDK (el Bash nativo honra `timeout` en ms). Si el SDK ignora el campo, el watchdog de Task 5 sigue cerrando el turn.

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. `canUseTool` delega en `decideCanUseTool` y propaga `updatedInput`.
  2. Concatenar `VERIFY_PREAMBLE` al `appendSystemPrompt` existente (reglas, plan preamble). No pisar `PLAN_MODE_PREAMBLE`.
  3. Si `executionMode === "plan"`, añadir `VERIFY_PLAN_HINT`.
  4. Ampliar `RunClaudeTurnInput` con `verifyPactCommand?: string | null` y `appendSystemPrompt?: string`. Si hay pacto:

```ts
const pactLine = input.verifyPactCommand
  ? `\nWorkspace verification command (use this exact command after edits; do not invent another): \`${input.verifyPactCommand}\``
  : "";
const verifyBlock = `${VERIFY_PREAMBLE}${pactLine}`;
```

  Mezclar con `appendSystemPrompt` del plan 9: `${rulesPrompt}\n\n${verifyBlock}` (verificar no duplica si `formatRulesPrompt` ya metió la línea del pacto: si `rulesPrompt` ya contiene `Workspace verification command`, no concatenar `pactLine` otra vez).

- [ ] Test extra en `can-use-tool` / `verify-gate`:

```ts
test("Read in ask does not go through verify gate as ask", async () => {
  const d = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: "Read",
    toolInput: { file_path: "in.txt" },
    ask: async () => {
      throw new Error("ask should not run for Read");
    },
  });
  expect(d.behavior).toBe("allow");
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/verify-gate.test.ts src/llm/can-use-tool.test.ts src/llm/claude-runner.mode.test.ts
```

Omitir archivos que no existan. Esperado: pasan.

- [ ] Commit:

```bash
git add cli/src/llm/verify-gate.ts cli/src/llm/verify-gate.test.ts \
  cli/src/llm/can-use-tool.ts cli/src/llm/claude-runner.ts \
  cli/src/llm/execution-gate.ts cli/src/llm/can-use-tool.test.ts
git commit -m "feat(verify): gate tests by mode — plan denies, ask approves, auto times out"
```

---

## Task 5: Turn — clasificar tools, pacto post-edit, no éxito silencioso, timeout cierra

**Files:**

- Create: `cli/src/llm/verify-turn.ts`
- Test: `cli/src/llm/verify-turn.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/llm/claude-runner.ts` (eventos `tool_start` llevan command; abort en timeout)
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts` (no hace falta campo nuevo; `metadata` ya existe)
- Modify: `api/openapi/openapi.yaml`
- Test: `api/src/ws/handlers.verify.test.ts` (si el paquete ya tiene `bun test`; si no, un test de merge de metadata en CLI que simula el payload)

El loop del turn vive en el daemon. La API solo persiste y reenvía.

- [ ] Crear `cli/src/llm/verify-turn.ts`:

```ts
import type { ExecutionMode } from "./execution-mode";
import type { VerificationMetadata } from "./verify-constants";
import {
  VERIFY_CONTINUATION_MAX,
  VERIFY_EXPLAIN_PROMPT,
  VERIFY_SKIPPED_NO_RULE,
  VERIFY_TIMEOUT_ERROR,
  VERIFY_TIMEOUT_MS,
} from "./verify-constants";
import {
  classifyBashKind,
  extractBashCommand,
  promptAsksForTests,
  sameCommand,
} from "./verify-classify";
import { buildVerificationMetadata, isSilentSuccess } from "./verify-outcome";
import { runVerifyCommand } from "./verify-run";

export class VerifyTimeoutError extends Error {
  readonly code = "VERIFY_TIMEOUT" as const;
  constructor() {
    super(VERIFY_TIMEOUT_ERROR);
  }
}

export type VerifyToolEvent = {
  toolCallId: string;
  sdkName: string;
  input?: unknown;
  output?: string;
  status?: string;
};

export type TurnVerifyState = {
  mode: ExecutionMode;
  pactCommand: string | null;
  userAsked: boolean;
  mutated: boolean;
  verifyRan: boolean;
  last?: VerificationMetadata;
  inFlight: Map<string, { kind: "verify" | "lint"; command: string; startedAt: number }>;
  continuations: number;
};

export function createTurnVerifyState(input: {
  mode: ExecutionMode;
  pactCommand: string | null;
  prompt: string;
}): TurnVerifyState {
  return {
    mode: input.mode,
    pactCommand: input.pactCommand,
    userAsked: promptAsksForTests(input.prompt),
    mutated: false,
    verifyRan: false,
    inFlight: new Map(),
    continuations: 0,
  };
}

export function noteToolStart(
  state: TurnVerifyState,
  ev: VerifyToolEvent,
): { kind: "verify" | "lint" | "bash" | "write" | "read"; command?: string } {
  const sdk = ev.sdkName;
  if (sdk === "Write" || sdk === "Edit" || sdk === "NotebookEdit") {
    state.mutated = true;
    return { kind: "write" };
  }
  if (sdk === "Read" || sdk === "Grep" || sdk === "Glob" || sdk === "LS") {
    return { kind: "read" };
  }
  if (sdk === "Bash" || sdk === "bash") {
    const command = extractBashCommand(ev.input);
    const kind = classifyBashKind(command);
    if (kind === "verify" || kind === "lint") {
      state.inFlight.set(ev.toolCallId, {
        kind,
        command,
        startedAt: Date.now(),
      });
      return { kind, command };
    }
    state.mutated = true;
    return { kind: "bash", command };
  }
  return { kind: "bash" };
}

export function noteToolResult(
  state: TurnVerifyState,
  ev: VerifyToolEvent,
): VerificationMetadata | null {
  const inflight = state.inFlight.get(ev.toolCallId);
  const command =
    inflight?.command || extractBashCommand(undefined) || "";
  const kind = inflight?.kind;
  state.inFlight.delete(ev.toolCallId);
  if (!kind) return null;
  const timedOut =
    ev.status === "error" &&
    String(ev.output || "").includes("timed out");
  const exitMatch = /exit (\d+)/.exec(String(ev.output || ""));
  const isError = ev.status === "error" || timedOut;
  const exitCode = timedOut
    ? 124
    : exitMatch
      ? Number(exitMatch[1])
      : isError
        ? 1
        : 0;
  state.verifyRan = true;
  const meta = buildVerificationMetadata({
    kind,
    command: command || state.pactCommand || "test",
    exitCode,
    timedOut,
    source:
      state.pactCommand && sameCommand(command, state.pactCommand)
        ? "pact"
        : "agent",
    truncated: String(ev.output || "").includes("[truncated:"),
  });
  state.last = meta;
  return meta;
}

export function shouldRunPact(state: TurnVerifyState): boolean {
  if (state.mode !== "auto") return false;
  if (!state.mutated) return false;
  if (!state.pactCommand) return false;
  if (state.verifyRan) return false;
  return true;
}

export function skippedBecauseNoRule(state: TurnVerifyState): VerificationMetadata | null {
  if (state.mode !== "auto") return null;
  if (!state.mutated) return null;
  if (state.pactCommand) return null;
  if (state.verifyRan) return null;
  if (!state.userAsked) {
    return {
      status: "skipped",
      kind: "verify",
      command: "",
      exitCode: null,
      timedOut: false,
      source: "pact",
      truncated: false,
    };
  }
  return {
    status: "skipped",
    kind: "verify",
    command: "",
    exitCode: null,
    timedOut: false,
    source: "pact",
    truncated: false,
  };
}

export async function runPactIfNeeded(
  state: TurnVerifyState,
  cwd: string,
): Promise<{
  ran: boolean;
  result?: Awaited<ReturnType<typeof runVerifyCommand>>;
  meta?: VerificationMetadata;
  skipReason?: string;
}> {
  if (!shouldRunPact(state)) {
    const skip = skippedBecauseNoRule(state);
    return {
      ran: false,
      skipReason: skip && !state.pactCommand ? VERIFY_SKIPPED_NO_RULE : undefined,
      meta: skip ?? undefined,
    };
  }
  const result = await runVerifyCommand({
    cwd,
    command: state.pactCommand!,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  state.verifyRan = true;
  const meta = buildVerificationMetadata({
    kind: "verify",
    command: state.pactCommand!,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    source: "pact",
    truncated: result.truncated,
  });
  state.last = meta;
  return { ran: true, result, meta };
}

export function shouldExplain(state: TurnVerifyState, assistantText: string): boolean {
  if (!state.last) return false;
  if (state.last.status !== "failed" && state.last.status !== "timeout") {
    return false;
  }
  if (state.last.status === "timeout") return false;
  if (state.continuations >= VERIFY_CONTINUATION_MAX) return false;
  return isSilentSuccess(assistantText, state.last) || !assistantText.trim();
}

export function stampSilentSuccess(
  state: TurnVerifyState,
  assistantText: string,
): VerificationMetadata | undefined {
  if (!state.last) return undefined;
  if (isSilentSuccess(assistantText, state.last)) {
    state.last = { ...state.last, silentSuccess: true };
  }
  return state.last;
}

export function watchdogTimedOut(
  state: TurnVerifyState,
  now = Date.now(),
): { toolCallId: string; command: string } | null {
  for (const [id, rec] of state.inFlight) {
    if (now - rec.startedAt >= VERIFY_TIMEOUT_MS) {
      return { toolCallId: id, command: rec.command };
    }
  }
  return null;
}
```

Si `execution-mode.ts` no existe, importar el type desde un `type ExecutionMode = "plan" | "auto" | "ask"` local en este archivo.

- [ ] Crear `cli/src/llm/verify-turn.test.ts` cubriendo: pacto corre solo en auto+mutated+comando; sin regla no inventa; timeout error; silent success; explain cap 1.

```ts
import { describe, expect, test } from "bun:test";
import {
  createTurnVerifyState,
  noteToolResult,
  noteToolStart,
  shouldRunPact,
  skippedBecauseNoRule,
  shouldExplain,
} from "./verify-turn";
import { VERIFY_SKIPPED_NO_RULE } from "./verify-constants";

describe("TurnVerifyState", () => {
  test("auto + edits + pact and model did not run → shouldRunPact", () => {
    const s = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "cambia X",
    });
    noteToolStart(s, {
      toolCallId: "w1",
      sdkName: "Write",
      input: { file_path: "a.ts" },
    });
    expect(shouldRunPact(s)).toBe(true);
  });

  test("auto + edits + no pact → do not invent", () => {
    const s = createTurnVerifyState({
      mode: "auto",
      pactCommand: null,
      prompt: "cambia X",
    });
    noteToolStart(s, { toolCallId: "w1", sdkName: "Edit" });
    expect(shouldRunPact(s)).toBe(false);
    const skip = skippedBecauseNoRule(s);
    expect(skip?.status).toBe("skipped");
    expect(VERIFY_SKIPPED_NO_RULE).toContain("not inventing");
  });

  test("if the agent already ran the tests, do not run pact twice", () => {
    const s = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "cambia X y corre los tests",
    });
    noteToolStart(s, {
      toolCallId: "t1",
      sdkName: "Bash",
      input: { command: "npm test" },
    });
    noteToolResult(s, {
      toolCallId: "t1",
      sdkName: "Bash",
      output: "exit 0\nok",
      status: "done",
    });
    noteToolStart(s, { toolCallId: "w1", sdkName: "Write" });
    expect(shouldRunPact(s)).toBe(false);
  });

  test("failed tests + cheerful assistant → explain", () => {
    const s = createTurnVerifyState({
      mode: "auto",
      pactCommand: "npm test",
      prompt: "cambia X y corre los tests",
    });
    noteToolStart(s, {
      toolCallId: "t1",
      sdkName: "Bash",
      input: { command: "npm test" },
    });
    noteToolResult(s, {
      toolCallId: "t1",
      sdkName: "Bash",
      output: "exit 1\nFAIL src/a.test.ts",
      status: "error",
    });
    expect(shouldExplain(s, "All tests passed. Done.")).toBe(true);
    expect(shouldExplain(s, "The tests failed in src/a.test.ts")).toBe(false);
  });
});
```

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Resolver `executionMode` (plan 3) y `pactCommand`:

```ts
import { pactCommandFromBundle } from "./verify-pact";
import {
  createTurnVerifyState,
  noteToolStart,
  noteToolResult,
  runPactIfNeeded,
  shouldExplain,
  stampSilentSuccess,
  VerifyTimeoutError,
  watchdogTimedOut,
} from "./verify-turn";
import { VERIFY_EXPLAIN_PROMPT, VERIFY_TIMEOUT_MS } from "./verify-constants";
import { canonicalToolName } from "./tool-names";
import { sanitizeToolInput, summarizeToolInput } from "./tool-display";
```

  Si el loader de reglas del plan 9 existe (`loadRulesForTurn` / `assembleBundle`), usarlo. Si no, `pactCommand = null` (el modelo aún puede correr tests si el usuario los pidió; el host no inventa).

  2. `const verifyState = createTurnVerifyState({ mode: executionMode, pactCommand, prompt })`.

  3. En `onEvent` `tool_start`:

```ts
const classified = noteToolStart(verifyState, {
  toolCallId: ev.toolCallId,
  sdkName: ev.toolName,
  input: ev.input,
});
await client.request({
  type: "chat.tool.start",
  chatId,
  streamId,
  toolCallId: ev.toolCallId,
  toolName: canonicalToolName(ev.toolName),
  content: ev.toolName,
  metadata: {
    sdkName: ev.toolName,
    input: sanitizeToolInput(ev.input),
    summary: summarizeToolInput(ev.toolName, ev.input),
    kind: classified.kind === "write" || classified.kind === "read"
      ? undefined
      : classified.kind,
    command: classified.command,
    source: "agent",
  },
});
```

  Si `tool-names` / `tool-display` no existen, usar `ev.toolName.toLowerCase()` y `JSON.stringify(ev.input).slice(0, 200)`.

  4. En `tool_result`: `noteToolResult`; si `meta.status === "timeout"` o el output es timeout, **throw** `new VerifyTimeoutError()` después de persistir el result. Si `meta` y `exitCode !== 0`, mandar `status: "error"` (aunque el SDK haya dicho done).

  5. Watchdog: `setInterval` 1s mientras el turn corre:

```ts
const tick = setInterval(async () => {
  const hit = watchdogTimedOut(verifyState);
  if (!hit) return;
  await client.request({
    type: "chat.tool.result",
    chatId,
    toolCallId: hit.toolCallId,
    content: VERIFY_TIMEOUT_ERROR,
    status: "error",
    metadata: { timedOut: true, kind: "verify", command: hit.command },
  });
  abortTurn(); // AbortController del plan 16/5 si existe; si no, throw en el loop
}, 1000);
```

  `clearInterval(tick)` en el `finally`.

  6. Tras `runClaudeTurn` **successful** (antes de `chat.stream.end`):

```ts
const pact = await runPactIfNeeded(verifyState, cwd);
if (pact.ran && pact.result && pact.meta) {
  const pactId = `verify-pact-${streamId}`;
  await client.request({
    type: "chat.tool.start",
    chatId,
    streamId,
    toolCallId: pactId,
    toolName: "bash",
    content: "bash",
    metadata: {
      sdkName: "Bash",
      kind: "verify",
      command: verifyState.pactCommand,
      source: "pact",
      input: { command: verifyState.pactCommand },
      summary: verifyState.pactCommand,
    },
  });
  await client.request({
    type: "chat.tool.result",
    chatId,
    toolCallId: pactId,
    toolName: "bash",
    content: pact.result.combined,
    status: pact.meta.timedOut || !pact.result.ok ? "error" : "done",
    metadata: {
      kind: "verify",
      command: verifyState.pactCommand,
      source: "pact",
      exitCode: pact.result.exitCode,
      timedOut: pact.result.timedOut,
      output: pact.result.combined,
    },
  });
  if (pact.meta.timedOut) throw new VerifyTimeoutError();
  if (shouldExplain(verifyState, result)) {
    verifyState.continuations += 1;
    result = await runClaudeTurn({
      ...sameAuth,
      prompt: VERIFY_EXPLAIN_PROMPT,
      history: [
        ...(history ?? []),
        { role: "user", content: prompt },
        { role: "assistant", content: result },
        {
          role: "user",
          content: `Tool bash (verify) error:\n${pact.result.combined}\n\n${VERIFY_EXPLAIN_PROMPT}`,
        },
      ],
      cwd,
      executionMode,
      // skip tools? allow Read so it can cite; still gated
    });
  }
}
```

  `runClaudeTurn` actual no acepta `history` con un user extra de esa forma — usar `prompt: VERIFY_EXPLAIN_PROMPT` y `historyFromChatMessages` **después** de persistir el tool sintético: hacer `chat.get` de nuevo y reconstruir history. Cap `VERIFY_CONTINUATION_MAX`. **No** llamar a `runPactIfNeeded` otra vez en la continuación.

  7. `chat.stream.end`:

```ts
const verification = stampSilentSuccess(verifyState, result);
await client.request({
  type: "chat.stream.end",
  chatId,
  streamId,
  content: result,
  metadata: { streamId, executionMode, verification },
}, 60_000);
```

  Payload extra: si el helper de request no manda `verification` top-level, basta `metadata.verification` (el handler ya lo mergea). Task API abajo también copia `verification` al broadcast.

  8. `catch`: si `err instanceof VerifyTimeoutError`, `chat.stream.error` con `VERIFY_TIMEOUT_ERROR`, y **no** `chat.stream.end` de éxito. `finally`: `clearInterval`, `cancelApprovalsForChat`, `agent.turn.ended` (si el tipo existe; si no, al menos `turnBusy = false` en daemon).

- [ ] En `cli/src/llm/claude-runner.ts`, si hay `AbortController` (plan 16), exportar un hook `abort()` que `publish-turn` llama en timeout. Si no hay, `throw` desde el watchdog vía una `Promise.race` alrededor de `runClaudeTurn`:

```ts
const timeoutPromise = new Promise<never>((_, reject) => {
  const t = setTimeout(
    () => reject(new VerifyTimeoutError()),
    VERIFY_TIMEOUT_MS + 5_000,
  );
  // cleared in finally
});
```

El watchdog por tool (paso 5) es la fuente de verdad; este race es red de seguridad para un bash SDK que nunca emite `tool_result`.

- [ ] En `api/src/ws/handlers.ts`:

  `chat.tool.start` — persistir el metadata completo, no solo `input`:

```ts
metadata: {
  toolCallId: msg.toolCallId,
  toolName: msg.toolName,
  status: "running",
  input: msg.metadata?.input ?? msg.metadata ?? null,
  ...(msg.metadata || {}),
},
```

  `chat.tool.result` — merge:

```ts
const metadata = {
  ...prev,
  status: msg.status || "done",
  output,
  ...(msg.metadata || {}),
};
```

  `chat.stream.end` — el assistant ya recibe `...(msg.metadata || {})`. Añadir `verification` al payload de broadcast:

```ts
const payload = {
  chatId: msg.chatId,
  streamId: msg.streamId,
  message,
  verification: (msg.metadata || {}).verification ?? null,
};
```

  `chat.stream.error` — si `msg.content === VERIFY_TIMEOUT_ERROR` (comparar el literal), incluir `reason: "verify_timeout"` en el payload. No es un campo de schema.

- [ ] En `api/openapi/openapi.yaml`, sección WebSocket `/ws`, añadir a la description:

```
chat.tool.* metadata.kind: verify | lint | bash
chat.stream.end metadata.verification: { status, kind, command, exitCode, timedOut, source, truncated }
verify timeout → chat.stream.error error="Verification timed out after 120s" and the turn ends
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/verify-turn.test.ts src/llm/verify-run.test.ts src/llm/verify-gate.test.ts
```

Esperado: pasan.

- [ ] Commit:

```bash
git add cli/src/llm/verify-turn.ts cli/src/llm/verify-turn.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/claude-runner.ts \
  api/src/ws/handlers.ts api/openapi/openapi.yaml
git commit -m "feat(verify): run pact tests after edits, fail loudly, timeout closes the turn"
```

---

## Task 6: CLI `chat watch` — `test ·` / `lint ·` / `verify ·`, sin sustituir diffs

**Files:**

- Modify: `cli/src/llm/watch-format.ts` (crear si el plan 2 no lo hizo, con el mínimo de agent-tools Task 5 **más** estos branches)
- Test: `cli/src/llm/watch-format.test.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts` (usage: una línea, no un subcomando nuevo)

- [ ] En `cli/src/llm/watch-format.ts`, dentro de `formatWatchLine`, **antes** del generic `chat.tool.*`:

```ts
import { VERIFY_WATCH_CHARS, VERIFY_TIMEOUT_ERROR } from "./verify-constants";
import { verificationHeadline } from "./verify-outcome";
import { truncateToolText } from "./tool-display";

function verifyFromPayload(data: Record<string, unknown>) {
  const message = rec(data.message);
  const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
  const kind = String(meta.kind || "");
  const command = String(meta.command || meta.summary || "");
  const status = String(meta.status || data.status || "");
  return { kind, command, status, output: meta.output ?? message?.content, meta };
}

// inside formatWatchLine, for chat.tool.start/result/update:
const v = verifyFromPayload(data);
if (v.kind === "verify" || v.kind === "lint") {
  const label = v.kind === "lint" ? "lint" : "test";
  const head = `${label} · ${v.status || "running"}  ${v.command}`.trim();
  if (v.status === "error" || v.status === "done") {
    const body =
      v.output != null
        ? truncateToolText(String(v.output), VERIFY_WATCH_CHARS)
        : "";
    return body ? `${head}\n${body}` : head;
  }
  return head;
}
```

  Para `chat.stream.end`:

```ts
if (msg.type === "chat.stream.end") {
  const verification = rec(data.verification) ?? rec(rec(data.message)?.metadata)?.verification;
  const vrec = rec(verification);
  if (vrec && vrec.status) {
    const line = verificationHeadline({
      status: String(vrec.status) as never,
      kind: vrec.kind === "lint" ? "lint" : "verify",
      command: String(vrec.command || ""),
      exitCode: typeof vrec.exitCode === "number" ? vrec.exitCode : null,
      timedOut: Boolean(vrec.timedOut),
      source: (vrec.source as never) || "agent",
      truncated: Boolean(vrec.truncated),
      silentSuccess: Boolean(vrec.silentSuccess),
    });
    const extra = vrec.silentSuccess ? "  (not silent — tests failed)" : "";
    return `verify · ${line}${extra}`;
  }
  return "stream end";
}
```

  Para `chat.stream.error`:

```ts
if (msg.type === "chat.stream.error") {
  const err = String(data.error ?? data.content ?? "");
  if (err.includes("timed out") || err === VERIFY_TIMEOUT_ERROR) {
    return `verify · timeout  ${VERIFY_TIMEOUT_ERROR}`;
  }
  return `stream error  ${err}`;
}
```

  **No** borrar el branch `diff ·` del plan 6. Un evento `chat.diff.upsert` sigue yendo a `diff ·`. Lint y diff pueden aparecer **los dos** en el mismo turn.

  Si `watch-format.ts` no existe, crearlo con los cases de agent-tools Task 5 **y** estos. Firma `formatWatchLine(msg: { type: string; data?: unknown }): string | null`.

- [ ] Tests en `cli/src/llm/watch-format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";
import { VERIFY_TIMEOUT_ERROR } from "./verify-constants";

describe("formatWatchLine verify", () => {
  test("test tool start", () => {
    const line = formatWatchLine({
      type: "chat.tool.start",
      data: {
        metadata: {
          kind: "verify",
          command: "npm test",
          status: "running",
        },
      },
    });
    expect(line).toContain("test ·");
    expect(line).toContain("npm test");
  });

  test("lint does not look like a diff", () => {
    const lint = formatWatchLine({
      type: "chat.tool.result",
      data: {
        metadata: {
          kind: "lint",
          command: "tsc --noEmit",
          status: "done",
          output: "src/a.ts(1,1): error TS000",
        },
      },
    });
    expect(lint).toContain("lint ·");
    expect(lint).not.toMatch(/^diff ·/);
  });

  test("failed verification on stream.end", () => {
    const line = formatWatchLine({
      type: "chat.stream.end",
      data: {
        verification: {
          status: "failed",
          kind: "verify",
          command: "npm test",
          exitCode: 1,
          timedOut: false,
          source: "pact",
          truncated: false,
          silentSuccess: true,
        },
      },
    });
    expect(line).toContain("failed");
    expect(line).toContain("not silent");
  });

  test("timeout closes", () => {
    const line = formatWatchLine({
      type: "chat.stream.error",
      data: { error: VERIFY_TIMEOUT_ERROR },
    });
    expect(line).toContain("timeout");
  });
});
```

- [ ] En `cli/src/commands/headless.ts` `chat watch`: si `formatWatchLine` retorna string, imprimir esa línea; si null, caer al JSON (comportamiento ya descrito en planes 2/13). No volcar el stdout entero del test.

- [ ] En `cli/src/index.ts` usage, **no** añadir un subcomando `test`. Los tests son tools del turn.

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  cli/src/commands/headless.ts cli/src/index.ts
git commit -m "feat(verify): show test and lint tools in chat watch without replacing diffs"
```

---

## Task 7: TUI — tools test/lint, banner de fallo, diffs intactos

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json` (añadir `"test": "bun test"` si falta; no quitar `start`/`dev`)
- Test: `tui/src/verify-line.test.ts`

La TUI **no** spawnea tests: observa el mismo chat. `publishAgentTurn` ya corre el loop (Task 5) porque la TUI es daemon.

- [ ] Ampliar el tipo `Message` si aún no tiene metadata (el plan 2 lo añade; si no, hacerlo aquí):

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

En `loadChat`, copiar `metadata` desde `chat.get`. En el handler de push `chat.tool.*` / `message.appended`, actualizar in-place por `toolCallId` si el plan 2 ya lo hace; si no, `await loadChat(activeChatId)` al `tool.result` y al `stream.end`.

- [ ] Helper en el mismo archivo (o `tui/src/verify-line.ts` importando `cli/src/llm/verify-outcome.ts`):

```ts
function toolLine(m: Message): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const kind = String(meta.kind || "");
  const status = String(meta.status || "running");
  const command = String(meta.command || meta.summary || "");
  if (kind === "verify") return `test · ${status}  ${command}`.trim();
  if (kind === "lint") return `lint · ${status}  ${command}`.trim();
  const name = String(meta.toolName || m.content || "tool");
  return `tool · ${name} · ${status}`;
}

function verificationBanner(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const v = (m.metadata as { verification?: Record<string, unknown> } | null)
      ?.verification;
    if (!v) continue;
    if (v.status === "failed") {
      return `verify failed · ${String(v.command || "")}  exit=${String(v.exitCode ?? "?")}`;
    }
    if (v.status === "timeout") {
      return `verify timeout · ${String(v.command || "")}`;
    }
    if (v.status === "proposed") {
      return `verify proposed · ${String(v.command || "")}  (plan: not run)`;
    }
    return null;
  }
  return null;
}
```

- [ ] En el bloque Messages (hoy `messages.slice(-8)`):

  - Si `m.role === "tool"` → `<Text color={status==="error" ? "red" : "cyan"}>{toolLine(m)}</Text>`.
  - Si `m.role === "assistant"` → content truncado **y**, si `metadata.verification`, una línea extra con el banner (rojo si failed/timeout).
  - Diffs (plan 6): si ya hay lista `diff · path`, **dejarla**. Lint no la reemplaza; se pinta como tool **antes** o **después**, nunca en su lugar.

- [ ] Tras `stream.end` / `stream.error`, `setLog` con el banner si failed/timeout. Si timeout, `setBusy(false)` (el `finally` de `sendWithLlm` ya lo hace; no dejar `… generando respuesta`).

- [ ] Crear `tui/src/verify-line.test.ts` extrayendo `toolLine` / `verificationBanner` a `tui/src/verify-line.ts` (importan classify/outcome desde CLI):

```ts
import { describe, expect, test } from "bun:test";
import { toolLine, verificationBanner } from "./verify-line";

test("verify tool", () => {
  expect(
    toolLine({
      id: "1",
      role: "tool",
      content: "bash",
      metadata: { kind: "verify", status: "error", command: "npm test" },
    }),
  ).toBe("test · error  npm test");
});

test("banner after failed assistant", () => {
  const b = verificationBanner([
    {
      id: "a",
      role: "assistant",
      content: "Done.",
      metadata: {
        verification: { status: "failed", command: "npm test", exitCode: 1 },
      },
    },
  ]);
  expect(b).toContain("verify failed");
  expect(b).toContain("npm test");
});
```

- [ ] Correr:

```bash
cd tui && bun test src/verify-line.test.ts
```

Añadir `"test": "bun test"` en `tui/package.json` si falta.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/verify-line.ts tui/src/verify-line.test.ts tui/package.json
git commit -m "feat(verify): show test/lint tools and failure banner in TUI timeline"
```

---

## Task 8: Web — ToolCard test/lint, banner, diagnostics no sustituyen el diff

**Files:**

- Create: `web/src/lib/verify-display.ts`
- Test: `web/src/lib/verify-display.test.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx` (preview: `test ·` / `lint ·` si el último mensaje es esa tool)

Web no ejecuta tests. Un reload de `/chats/:id` relee `chat.get` (metadata intacta).

- [ ] Añadir `"test": "bun test"` en `web/package.json` scripts si falta.

- [ ] Crear `web/src/lib/verify-display.ts` — **copia** de labels (keep-in-sync con `cli/src/llm/verify-outcome.ts` + classify). No importar `cli/`.

```ts
export type VerificationView = {
  status: string;
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  silentSuccess?: boolean;
};

export function verificationFromMeta(
  meta: Record<string, unknown> | null | undefined,
): VerificationView | null {
  const v = meta?.verification;
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const status = String(rec.status || "");
  if (!status) return null;
  return {
    status,
    kind: rec.kind === "lint" ? "lint" : "verify",
    command: String(rec.command || ""),
    exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
    timedOut: Boolean(rec.timedOut),
    silentSuccess: Boolean(rec.silentSuccess),
  };
}

export function toolKindLabel(kind: unknown, fallbackName: string): string {
  if (kind === "verify") return "test";
  if (kind === "lint") return "lint";
  return fallbackName || "tool";
}

export function verificationBannerText(v: VerificationView): string | null {
  if (v.status === "failed") {
    return `Verificación falló · ${v.command} · exit ${v.exitCode ?? "?"}. El assistant debe explicar el fallo.`;
  }
  if (v.status === "timeout") {
    return `Verificación: timeout de 120s · ${v.command}. El turn se cerró.`;
  }
  if (v.status === "proposed") {
    return `Modo plan: comando propuesto · ${v.command} (no ejecutado; no se escriben coverage ni snapshots).`;
  }
  if (v.status === "skipped" && !v.command) {
    return null;
  }
  return null;
}
```

- [ ] Crear `web/src/lib/verify-display.test.ts` con: failed banner contiene “falló”; timeout contiene “120s”; `toolKindLabel("verify") === "test"`; `verificationFromMeta({})` null.

- [ ] En `web/src/styles/global.css`:

```css
.badge.test {
  color: #8ec8ff;
  border-color: color-mix(in srgb, #8ec8ff 40%, var(--border));
}
.badge.lint {
  color: #f0c36d;
  border-color: color-mix(in srgb, #f0c36d 40%, var(--border));
}
.verify-banner {
  border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
  color: #f0b4b4;
  font-size: 0.9rem;
  margin: 0.5rem 0 0;
}
.verify-banner.plan {
  border-color: color-mix(in srgb, #f0c36d 40%, var(--border));
  color: #f0c36d;
}
.diagnostics-block pre {
  max-height: 12rem;
  overflow: auto;
}
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  1. Importar `toolKindLabel`, `verificationFromMeta`, `verificationBannerText`.

  2. `ToolCard`: leer `meta.kind`. Badge `test · {status}` / `lint · {status}` / `tool · {name} · {status}` (el plan 2 ya tiene el último). Output en `<pre>` truncado (si existe `truncateToolText` de `web/src/lib/tool-display.ts`, usarlo; si no, `String(output).slice(0, 8000)`). Si `kind === "lint"`, envolver el output en `<div className="diagnostics-block">` — **no** es el DiffsPanel.

  3. Tras el `<pre>` del assistant, si `verificationBannerText(verificationFromMeta(m.metadata))`, pintar:

```tsx
<p className={`panel verify-banner${v.status === "proposed" ? " plan" : ""}`}>
  {verificationBannerText(v)}
</p>
```

  4. **DiffsPanel** (plan 6): no moverlo dentro del ToolCard de lint. Sigue agrupado por `streamId` **después** de las tools. Un turn con edits + eslint muestra **los dos**: ToolCard lint y DiffsPanel.

  5. Push `chat.stream.error`: si el error es el literal de timeout, `setMsg({ kind: "error", text })` y `setStreaming(false)`.

  6. Reload: `useChat` ya trae metadata; el banner y el ToolCard `test · error` sobreviven sin WS.

- [ ] En `web/src/components/WorkspaceDetailPanel.tsx`, el preview `tool · ${name}` (si existe): si `metadata.kind === "verify"` mostrar `test · ${status}`; si `lint`, `lint · ${status}`. No mostrar un assistant vacío cuando lo último fue un test.

- [ ] Correr:

```bash
cd web && bun test src/lib/verify-display.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/verify-display.ts web/src/lib/verify-display.test.ts \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx \
  web/src/styles/global.css web/package.json
git commit -m "feat(verify): render test/lint tools and failure banner on web without replacing diffs"
```

---

## Task 9: Smoke Gherkin — los seis escenarios, sin LLM vivo

**Files:**

- Create: `cli/scripts/verify-loop-smoke.ts`
- Modify: `cli/package.json` (script opcional `"test:verify": "bun test src/llm/verify-*.test.ts && bun run scripts/verify-loop-smoke.ts"`)

Cero llamada a Anthropic. Spawn real solo para timeout/exit (Task 3 ya lo cubre). El smoke ensambla el state machine + formatters + gate.

- [ ] Crear `cli/scripts/verify-loop-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBashKind, promptAsksForTests } from "../src/llm/verify-classify";
import { extractVerifyCommandFromText, pactCommandFromRules } from "../src/llm/verify-pact";
import { gateVerifyBash } from "../src/llm/verify-gate";
import { runVerifyCommand } from "../src/llm/verify-run";
import {
  createTurnVerifyState,
  noteToolResult,
  noteToolStart,
  runPactIfNeeded,
  shouldExplain,
  shouldRunPact,
} from "../src/llm/verify-turn";
import { formatWatchLine } from "../src/llm/watch-format";
import { PLAN_VERIFY_MUTATION_DENIED, VERIFY_TIMEOUT_ERROR } from "../src/llm/verify-constants";
import { isSilentSuccess, verificationHeadline } from "../src/llm/verify-outcome";

const cwd = mkdtempSync(join(tmpdir(), "chavez-verify-smoke-"));
writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n");

// Escenario: El usuario pide tests
assert.equal(promptAsksForTests("cambia X y corre los tests"), true);
assert.equal(classifyBashKind("npm test"), "verify");
{
  const s = createTurnVerifyState({
    mode: "auto",
    pactCommand: "echo ok-tests",
    prompt: "cambia X y corre los tests",
  });
  noteToolStart(s, { toolCallId: "w", sdkName: "Write" });
  noteToolStart(s, {
    toolCallId: "t",
    sdkName: "Bash",
    input: { command: "echo ok-tests" },
  });
  const meta = noteToolResult(s, {
    toolCallId: "t",
    sdkName: "Bash",
    output: "exit 1\nFAIL x.test.ts",
    status: "error",
  });
  assert.equal(meta?.status, "failed");
  assert.equal(isSilentSuccess("All tests passed. Done.", meta!), true);
  assert.equal(shouldExplain(s, "All tests passed. Done."), true);
  assert.equal(shouldExplain(s, "FAIL x.test.ts — missing export"), false);
}

// Escenario: Linter/diagnostics no sustituyen al diff
{
  const lint = formatWatchLine({
    type: "chat.tool.result",
    data: {
      metadata: {
        kind: "lint",
        command: "tsc --noEmit",
        status: "done",
        output: "x.ts(1,1): error TS1234",
      },
    },
  });
  const diff = formatWatchLine({
    type: "chat.diff.upsert",
    data: { diff: { path: "x.ts", kind: "modified", additions: 1, deletions: 0 } },
  });
  assert.match(String(lint), /^lint ·/);
  // diff line may be null if plan 6 formatter is absent — then at least lint is not a diff
  if (diff) assert.match(diff, /^diff ·/);
  assert.notEqual(lint, diff);
}

// Escenario: Modo plan no corre tests que mutan
{
  const g = gateVerifyBash({
    mode: "plan",
    sdkName: "Bash",
    toolInput: { command: "npx jest --coverage --updateSnapshot" },
  });
  assert.equal(g.decision, "deny");
  assert.equal(g.message, PLAN_VERIFY_MUTATION_DENIED);
  const plain = gateVerifyBash({
    mode: "plan",
    sdkName: "Bash",
    toolInput: { command: "npm test" },
  });
  assert.equal(plain.decision, "deny");
}

// Escenario: Modo ask — test no es skip-as-read
{
  const g = gateVerifyBash({
    mode: "ask",
    sdkName: "Bash",
    toolInput: { command: "bun test" },
  });
  assert.equal(g.decision, "ask");
  const readish = gateVerifyBash({
    mode: "ask",
    sdkName: "Read",
    toolInput: { file_path: "x.ts" },
  });
  assert.equal(readish.decision, "passthrough");
}

// Escenario: Verificación pactada / no inventar
{
  const pact = extractVerifyCommandFromText(`---
verify: npm test
---
# AGENTS
`);
  assert.equal(pact, "npm test");
  assert.equal(pactCommandFromRules([]), null);
  assert.equal(
    pactCommandFromRules([{ layer: "project", body: "Be nice." }]),
    null,
  );
  const s = createTurnVerifyState({
    mode: "auto",
    pactCommand: "echo pact-ok",
    prompt: "cambia X",
  });
  noteToolStart(s, { toolCallId: "w", sdkName: "Edit" });
  assert.equal(shouldRunPact(s), true);
  const ran = await runPactIfNeeded(s, cwd);
  assert.equal(ran.ran, true);
  assert.equal(ran.result?.ok, true);

  const none = createTurnVerifyState({
    mode: "auto",
    pactCommand: null,
    prompt: "cambia X",
  });
  noteToolStart(none, { toolCallId: "w", sdkName: "Write" });
  const skipped = await runPactIfNeeded(none, cwd);
  assert.equal(skipped.ran, false);
  assert.match(String(skipped.skipReason), /not inventing a test suite/);
}

// Escenario: Test interminable → timeout, tool error, turn cierra
{
  const r = await runVerifyCommand({
    cwd,
    command: "sleep 30",
    timeoutMs: 200,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 124);
  const line = formatWatchLine({
    type: "chat.stream.error",
    data: { error: VERIFY_TIMEOUT_ERROR },
  });
  assert.match(String(line), /timeout/);
  assert.equal(verificationHeadline({
    status: "timeout",
    kind: "verify",
    command: "sleep 30",
    exitCode: 124,
    timedOut: true,
    source: "agent",
    truncated: false,
  }).includes("timeout"), true);
}

console.log("verify-loop-smoke ok");
```

Si `formatWatchLine` no acepta `chat.diff.upsert` (plan 6 ausente), el assert `if (diff)` ya es condicional. Si `watch-format.ts` no existe, el smoke usa `verificationHeadline` para lint/test y no importa `watch-format`.

- [ ] Añadir script en `cli/package.json` **sin** quitar los existentes:

```json
"test:verify": "bun test src/llm/verify-*.test.ts && bun run scripts/verify-loop-smoke.ts"
```

- [ ] Correr:

```bash
cd cli && bun run scripts/verify-loop-smoke.ts
```

Esperado: imprime `verify-loop-smoke ok` y exit 0. `sleep 30` no dura 30s.

- [ ] Commit:

```bash
git add cli/scripts/verify-loop-smoke.ts cli/package.json
git commit -m "test(verify): smoke the six Gherkin verification-loop scenarios"
```

---

## Gherkin coverage

| Escenario | Tasks |
|---|---|
| El usuario pide tests (cwd, stdout acotado, no éxito silencioso, assistant explica) | 1 classify/outcome, 3 truncado, 5 turn + continuación, 6–8 UI |
| Linter/diagnostics como tool o bloque, no sustituyen al diff | 1 lint kind, 6 watch, 7 TUI, 8 DiagnosticsBlock vs DiffsPanel |
| Modo plan no corre tests que mutan; puede proponer | 4 `PLAN_VERIFY_MUTATION_DENIED`, 7–8 banner `proposed` |
| Modo ask: bash de test pide aprobación; no skip-as-read | 4 `decision: "ask"`, reusa waiter planes 3/13 |
| Pacto `npm test` en reglas + auto + edits; sin regla no inventa | 2 `verifyCommand`, 5 `runPactIfNeeded` / `VERIFY_SKIPPED_NO_RULE` |
| Test interminable → timeout, tool error, turn se cierra | 3 spawn kill, 5 watchdog + `VerifyTimeoutError` + `stream.error` + `turn.ended` |

## Fuera de esta fase (no implementar)

- Plan 25 CI: leer `metadata.verification.status` ∈ `failed`|`timeout` para exit ≠ 0. El stamp ya está.
- Plan 26: denegar red en auto. `npm test` que precise red fallará después.
- Plan 4 Cursor ejecutable: cuando `cursor-runner.ts` exista, pasar el mismo `kind` / pacto / timeout al shell. No simular turns.
- Slash `/test`. JSON schema. GitHub Action. Notificaciones OS/email. Cursor cloud.
