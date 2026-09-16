# Approvals Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement lote, “siempre permitir”, Cursor cloud, notificaciones OS/email, slash `/mode`, artefacto de plan, cola de turns, ni sandbox de red. Spec: [`plan.md`](./plan.md). Depende del waiter de [`execution-modes`](../execution-modes/implementation.md), del contrato de tools en [`agent-tools`](../agent-tools/implementation.md) y del diff propuesto en [`diffs-review`](../diffs-review/implementation.md). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas. Si `canUseTool` / `waitForApproval` / `chat.tool.update` / `agent.tool.approve` aún no existen, esta fase los añade lo mínimo para **ask** (no implementa el picker de `plan`/`auto`).

**Goal:** Cerrar el modo `ask`. Cada write/edit/bash se aprueba **una a una**. Web, TUI y CLI `watch` ven el mismo pedido (path + diff o comando) y cualquiera puede resolver; el primero gana y el segundo ve **`ya resuelto`**. Si nadie responde, un timeout **visible** deniega la tool y el turn **no** queda busy. Headless **no** auto-aprueba. Lecturas nunca aparecen como approval.

**Architecture:** El waiter vive en el proceso daemon (`cli/src/ws/daemon.ts` o TUI `clientKind: "daemon"`). La API **no** ejecuta tools: hace CAS de “quién gana”, reenvía `agent.tool.approve` / `deny` al daemon y hace fan-out del pedido y de `ya resuelto`. El countdown es **local** en cada cliente a partir de `metadata.approvalDeadline` (un solo timestamp; sin ticks de red). El filesystem se toca **solo** después de `resolveApproval(..., "approve")`.

```
Composer (Web | TUI | CLI ask)
        |
        v
  agent.turn.request  --WS-->  API  --dispatch-->  daemon
        |
        v
  canUseTool (ANTES de mutar)
        |  Read/Grep/Glob/LS  → allow (nunca awaiting_approval)
        |  Write/Edit/Bash + ask
        |     chat.tool.update awaiting_approval
        |       { path|command, diff?, approvalDeadline }
        |     waitForApproval (300s)
        |
        |  Web Aprobar | TUI [y]/[n] | watch y/n | chat approve
        |        |
        |        v
        |  API CAS  status==awaiting_approval && !resolution
        |     primero → forward daemon → resolveApproval
        |     segundo → fail "ya resuelto"
        |
        |  timeout → deny ASK_TIMEOUT_DENIED
        |            status=error  resolution=timeout
        |            turn.ended en finally (no busy eterno)
        v
  broadcast chat.tool.update  →  Web ToolCard | TUI banner | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` usa `permissionMode: "bypassPermissions"`. Los planes 2–3 lo pasan a `default` + `canUseTool`. Si aún está `bypassPermissions`, **esta fase lo sustituye** (sin volver a él).
- `cli/src/llm/publish-turn.ts` emite `chat.tool.start` / `result`. **No** hay `awaiting_approval`, **no** hay deadline, **no** hay `onAskPermission`.
- `cli/src/ws/daemon.ts` solo atiende `agent.turn.dispatch`. `stdin: "ignore"` en `workspaceOpen`. **No** hay handler de approve/deny. **No** auto-aprueba hoy (tampoco espera: el SDK corre con bypass).
- `api/src/ws/handlers.ts` tiene `chat.tool.start` / `result`. **No** hay `chat.tool.update`, **no** hay `agent.tool.approve` / `deny`.
- Web `ChatDetailPanel.tsx` `ToolCard`: nombre + status + JSON crudo. Sin botones, sin countdown, sin diff.
- TUI `App.tsx`: `Message = { id, role, content }` **sin** metadata. Compose bloqueado con `busy`. No hay `[y]`/`[n]`.
- CLI `chat watch` vuelca JSON crudo. **No** hay `chat approve` / `deny`. Watch **no** lee stdin para resolver.
- `cli/package.json`, `api/package.json`, `web/package.json` **no** tienen script `"test": "bun test"` (añadirlo si falta; no quitar `start`/`dev`/`bin`).
- Cursor `runnable: false`. No simular approvals de Cursor.
- Plan 3 deja el waiter + `"No tool awaiting approval"` y **delega** a este plan el “ya resuelto” pulido, el countdown y el path+diff/comando junto a la pregunta.
- Plan 6 añade `metadata.diff` propuesto. Si no está mergeado, Task 1 calcula un diff mínimo desde el input SDK (Write/Edit) o muestra el comando (Bash).

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (sin migración), Claude Agent SDK `query` (`canUseTool` **antes** de mutar, `permissionMode: "default"`, `permissionPrompts: "host"`), Ink TUI, Astro/React web. Countdown con `Date.parse` + `setInterval` 1s en el cliente. Sin paquete `diff` nuevo.

**Global Constraints:**

1. El filesystem se lee y escribe **solo** en el daemon (cwd del workspace). API y browser no ejecutan tools ni “aprueban en el servidor”: el API reenvía; el waiter del daemon es quien deja correr el SDK.
2. Sin daemon bound, `agent.turn.request` falla con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`. Un `agent.tool.approve` sin daemon falla con el mismo string. No queda un waiter huérfano.
3. Aprobaciones **una a una**. Un click / una tecla / una línea de watch = un `toolCallId`. Sin lote, sin “siempre permitir”, sin `suggestions` / `updatedPermissions` del SDK.
4. El **primero gana**. El segundo request (cualquier superficie) recibe `ok: false` con error que **incluye** `ya resuelto`. La UI del perdedor sustituye los botones por ese texto. No se reenvía al daemon.
5. Timeout `ASK_APPROVAL_TIMEOUT_MS` (300s). Al vencer: la tool se deniega con `ASK_TIMEOUT_DENIED`, `status: "error"`, `resolution: "timeout"`. El modelo puede continuar. `cancelApprovalsForChat` + `agent.turn.ended` en el `finally` del turn: el chat **no** queda busy.
6. Headless daemon **nunca** llama `resolveApproval(..., "approve")` por su cuenta. `workspace open` spawnea con `stdin: "ignore"`. Espera a Web / TUI / `chat watch`. Un write en ask **no** toca el disco hasta approve.
7. El pedido muestra **path + diff** (Write/Edit) o **comando** (Bash), no solo el nombre de la tool. Lecturas (`Read`, `Grep`, `Glob`, `LS`) **nunca** emiten `awaiting_approval` ni pintan botones, en ningún modo.
8. Web, TUI y CLI `watch` ven el mismo contrato (`chat.tool.update` con `approvalDeadline` + `prompt`). Un reload reconstruye el countdown desde el deadline persistido.
9. 1 turn por daemon. Un segundo `agent.turn.request` falla con `"Turn already running on this daemon"` si el lock del plan 2 existe; si no, el daemon ignora el dispatch (log existente) — esta fase **no** implementa cola.
10. Claude es el provider ejecutable. Cursor vinculado no ejecuta turns aquí; cuando el plan 4 lo haga, reutiliza el mismo waiter y el mismo CAS.
11. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, lote, “siempre permitir”, slash `/mode`, red/sandbox de bash.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `ASK_APPROVAL_TIMEOUT_MS` | `300_000` |
| `ASK_DENIED` | `"User denied this tool"` |
| `ASK_TIMEOUT_DENIED` | `"Approval timed out after 300s — tool denied"` |
| `NO_APPROVAL_ERROR` | `"No tool awaiting approval"` |
| `ALREADY_RESOLVED_ERROR` | `"ya resuelto"` |
| `ALREADY_RESOLVED_APPROVED` | `"ya resuelto (approved)"` |
| `ALREADY_RESOLVED_DENIED` | `"ya resuelto (denied)"` |
| `ALREADY_RESOLVED_TIMEOUT` | `"ya resuelto (timeout)"` |
| `HEADLESS_WAITING` | `"ask: waiting for approval from Web, TUI, or chat watch — not auto-approved"` |
| `WATCH_APPROVAL_HINT` | `"approval needed — type y/n or: chavez headless chat approve <chatId> <toolCallId>"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `APPROVAL_DIFF_MAX_CHARS` | `8000` |
| `APPROVAL_COUNTDOWN_TICK_MS` | `1000` |

Reusar si ya existen en `cli/src/llm/execution-mode.ts` (plan 3): `ASK_APPROVAL_TIMEOUT_MS`, `ASK_DENIED`, `ASK_TIMEOUT_DENIED`. **No** cambiar esos strings. Añadir las constantes `ALREADY_RESOLVED_*` / `HEADLESS_WAITING` / `WATCH_APPROVAL_HINT` en `cli/src/llm/approval-constants.ts` (y copia API/Web).

Clases de tool (igual que planes 2–3):

- **read:** `Read`, `Grep`, `Glob`, `LS` → nunca approval.
- **write:** `Write`, `Edit`, `NotebookEdit`, `Bash` → ask.
- **other:** (p.ej. `TodoWrite`) → misma regla que write.

Outcomes de resolución:

```ts
export type ApprovalResolution = "approve" | "deny" | "timeout";
```

Payload persistido en `chat_messages.metadata` cuando `status === "awaiting_approval"`:

```ts
type ApprovalPrompt =
  | { kind: "write"; path: string; diff: string; truncated: boolean }
  | { kind: "edit"; path: string; diff: string; truncated: boolean }
  | { kind: "bash"; command: string }
  | { kind: "other"; summary: string };

// metadata (fragmento)
{
  toolCallId: string;
  toolName: string;          // canónico: write|edit|bash
  sdkName: string;           // Write|Edit|Bash
  status: "awaiting_approval";
  input: Record<string, unknown>;
  summary: string;
  approvalDeadline: string;  // ISO-8601
  remainingMs: number;       // snapshot inicial = 300_000
  prompt: ApprovalPrompt;
  diff?: { path: string; preview: string; kind: string; additions?: number; deletions?: number };
  resolution?: ApprovalResolution;
  resolvedBy?: string;
  resolvedAt?: string;
}
```

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `chat.tool.update` | daemon → API → broadcast | Pedido (`awaiting_approval` + deadline + prompt) o parche de `resolution` |
| `agent.tool.approve` | cualquier cliente → API → daemon | Resolver **un** `toolCallId`. CAS en API. |
| `agent.tool.deny` | cualquier cliente → API → daemon | Igual, outcome deny. |
| `chat.tool.resolved` | API → broadcast (después del CAS ganador **o** timeout del daemon) | `{ chatId, toolCallId, outcome, resolvedBy }` para que el segundo cliente pinte `ya resuelto` sin esperar al `result`. |

HTTP: ninguno nuevo. `chat.get` ya devuelve `metadata`; el reload reconstruye countdown y botones.

---

## Task 1: Módulos puros — prompt (path+diff/comando), deadline, ya resuelto, lecturas

**Files:**

- Create: `cli/src/llm/approval-constants.ts`
- Create: `cli/src/llm/approval-prompt.ts`
- Create: `cli/src/llm/approval-deadline.ts`
- Create: `cli/src/llm/approval-resolve.ts`
- Test: `cli/src/llm/approval-prompt.test.ts`
- Test: `cli/src/llm/approval-deadline.test.ts`
- Test: `cli/src/llm/approval-resolve.test.ts`
- Modify: `cli/src/llm/tool-approval.ts` (si el plan 3 lo creó; si no, crearlo aquí con el waiter mínimo)
- Test: `cli/src/llm/tool-approval.test.ts` (extender o crear)
- Modify: `cli/package.json`

Sin I/O de red. TUI importa desde `cli/src/llm/…`. Web y API **no** importan CLI: Tasks 2 y 6 duplican constants + deadline + alreadyResolvedMessage.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/approval-constants.ts`:

```ts
export const ASK_APPROVAL_TIMEOUT_MS = 300_000;
export const ASK_DENIED = "User denied this tool";
export const ASK_TIMEOUT_DENIED =
  "Approval timed out after 300s — tool denied";
export const NO_APPROVAL_ERROR = "No tool awaiting approval";
export const ALREADY_RESOLVED_ERROR = "ya resuelto";
export const ALREADY_RESOLVED_APPROVED = "ya resuelto (approved)";
export const ALREADY_RESOLVED_DENIED = "ya resuelto (denied)";
export const ALREADY_RESOLVED_TIMEOUT = "ya resuelto (timeout)";
export const HEADLESS_WAITING =
  "ask: waiting for approval from Web, TUI, or chat watch — not auto-approved";
export const WATCH_APPROVAL_HINT =
  "approval needed — type y/n or: chavez headless chat approve <chatId> <toolCallId>";
export const APPROVAL_DIFF_MAX_CHARS = 8000;
export const APPROVAL_COUNTDOWN_TICK_MS = 1000;

export type ApprovalResolution = "approve" | "deny" | "timeout";
export type ApprovalOutcome = ApprovalResolution | "cancelled";

export const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);
export const WRITE_SDK = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export function isReadSdkName(sdkName: string): boolean {
  return READ_SDK.has(sdkName);
}

export function needsAskApproval(sdkName: string): boolean {
  return !isReadSdkName(sdkName);
}
```

Si `cli/src/llm/execution-mode.ts` **ya** exporta `ASK_APPROVAL_TIMEOUT_MS` / `ASK_DENIED` / `ASK_TIMEOUT_DENIED` con **el mismo valor**, reexportarlos desde ahí y **no** duplicar el string. `needsAskApproval` permanece aquí.

- [ ] Crear `cli/src/llm/approval-deadline.ts`:

```ts
import { ASK_APPROVAL_TIMEOUT_MS } from "./approval-constants";

export function approvalDeadlineIso(
  nowMs = Date.now(),
  timeoutMs = ASK_APPROVAL_TIMEOUT_MS,
): string {
  return new Date(nowMs + timeoutMs).toISOString();
}

export function remainingApprovalMs(
  deadlineIso: string,
  nowMs = Date.now(),
): number {
  const t = Date.parse(deadlineIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - nowMs);
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function isApprovalTimedOut(
  deadlineIso: string,
  nowMs = Date.now(),
): boolean {
  return remainingApprovalMs(deadlineIso, nowMs) <= 0;
}
```

- [ ] Crear `cli/src/llm/approval-resolve.ts`:

```ts
import {
  ALREADY_RESOLVED_APPROVED,
  ALREADY_RESOLVED_DENIED,
  ALREADY_RESOLVED_ERROR,
  ALREADY_RESOLVED_TIMEOUT,
  NO_APPROVAL_ERROR,
  type ApprovalResolution,
} from "./approval-constants";

export function alreadyResolvedMessage(
  resolution?: ApprovalResolution | string | null,
): string {
  if (resolution === "approve") return ALREADY_RESOLVED_APPROVED;
  if (resolution === "deny") return ALREADY_RESOLVED_DENIED;
  if (resolution === "timeout") return ALREADY_RESOLVED_TIMEOUT;
  return ALREADY_RESOLVED_ERROR;
}

export function isAlreadyResolvedError(msg: string): boolean {
  return msg.includes(ALREADY_RESOLVED_ERROR);
}

/**
 * API CAS decision. `resolving` is a process-local Set of `${chatId}:${toolCallId}`.
 * Winner = awaiting + no resolution + not in-flight.
 */
export function decideResolveGate(input: {
  status: string;
  resolution?: string | null;
  inflight: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (input.inflight) {
    return { ok: false, error: ALREADY_RESOLVED_ERROR };
  }
  if (input.resolution) {
    return { ok: false, error: alreadyResolvedMessage(input.resolution) };
  }
  if (input.status !== "awaiting_approval") {
    return { ok: false, error: NO_APPROVAL_ERROR };
  }
  return { ok: true };
}
```

- [ ] Crear `cli/src/llm/approval-prompt.ts`:

```ts
import { APPROVAL_DIFF_MAX_CHARS } from "./approval-constants";
import { isReadSdkName } from "./approval-constants";

export type ApprovalPrompt =
  | { kind: "write"; path: string; diff: string; truncated: boolean }
  | { kind: "edit"; path: string; diff: string; truncated: boolean }
  | { kind: "bash"; command: string }
  | { kind: "other"; summary: string };

function posixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function toolPathFromInput(
  input: Record<string, unknown>,
): string | null {
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return posixRel(v.trim());
  }
  return null;
}

export function bashCommandFromInput(
  input: Record<string, unknown>,
): string {
  const c = input.command ?? input.cmd;
  if (typeof c === "string" && c.trim()) return c.trim();
  return JSON.stringify(input);
}

function truncateDiff(text: string): { diff: string; truncated: boolean } {
  if (text.length <= APPROVAL_DIFF_MAX_CHARS) {
    return { diff: text, truncated: false };
  }
  return {
    diff:
      text.slice(0, APPROVAL_DIFF_MAX_CHARS) +
      `\n[truncated: showing ${APPROVAL_DIFF_MAX_CHARS} of ${text.length} chars]`,
    truncated: true,
  };
}

function writeDiff(path: string, content: string): string {
  const body = content.split("\n").map((l) => `+${l}`).join("\n");
  return `--- /dev/null\n+++ b/${path}\n${body}`;
}

function editDiff(path: string, oldS: string, newS: string): string {
  const oldL = oldS.split("\n").map((l) => `-${l}`).join("\n");
  const newL = newS.split("\n").map((l) => `+${l}`).join("\n");
  return `--- a/${path}\n+++ b/${path}\n${oldL}\n${newL}`;
}

/**
 * Build the human prompt shown next to Aprobar/Rechazar.
 * Prefer `proposedPreview` from diffs-review when present.
 * Reads must never call this (guard with isReadSdkName).
 */
export function buildApprovalPrompt(
  sdkName: string,
  input: Record<string, unknown>,
  proposedPreview?: string | null,
): ApprovalPrompt | null {
  if (isReadSdkName(sdkName)) return null;

  if (sdkName === "Bash") {
    return { kind: "bash", command: bashCommandFromInput(input) };
  }

  const path = toolPathFromInput(input) || "file";
  if (proposedPreview && proposedPreview.trim()) {
    const t = truncateDiff(proposedPreview);
    const kind = sdkName === "Write" ? "write" : "edit";
    return { kind, path, diff: t.diff, truncated: t.truncated };
  }

  if (sdkName === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    const t = truncateDiff(writeDiff(path, content));
    return { kind: "write", path, diff: t.diff, truncated: t.truncated };
  }

  if (sdkName === "Edit" || sdkName === "NotebookEdit") {
    const oldS = typeof input.old_string === "string" ? input.old_string : "";
    const newS = typeof input.new_string === "string" ? input.new_string : "";
    const t = truncateDiff(editDiff(path, oldS, newS));
    return { kind: "edit", path, diff: t.diff, truncated: t.truncated };
  }

  const summary =
    path !== "file" ? path : JSON.stringify(input).slice(0, 200);
  return { kind: "other", summary };
}

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  if (prompt.kind === "bash") return `bash · ${prompt.command}`;
  if (prompt.kind === "other") return prompt.summary;
  return `${prompt.kind} · ${prompt.path}`;
}
```

Si `cli/src/llm/proposed-edit.ts` (plan 6) exporta un preview, `buildApprovalPrompt` lo recibe como `proposedPreview`; **no** reimplementar Myers. Si no existe, el fallback Write/Edit de arriba basta para el escenario Gherkin “path + diff o comando”.

- [ ] Si `cli/src/llm/tool-approval.ts` **no** existe, crearlo **igual** que execution-modes Task 1 (`waitForApproval`, `resolveApproval`, `pendingApproval`, `cancelApprovalsForChat`, timeout → `"timeout"` **nunca** `"approve"`). Importar `ASK_APPROVAL_TIMEOUT_MS` desde `./approval-constants` (o `./execution-mode` si ya está). Si **sí** existe, no reescribir; solo asegurar que el timeout resuelve `"timeout"` y que el segundo `resolveApproval` devuelve `false`.

- [ ] Tests `cli/src/llm/approval-prompt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildApprovalPrompt,
  formatApprovalHeadline,
} from "./approval-prompt";

describe("buildApprovalPrompt", () => {
  test("reads return null — they never become an approval", () => {
    expect(buildApprovalPrompt("Read", { file_path: "a.ts" })).toBeNull();
    expect(buildApprovalPrompt("Grep", { pattern: "x" })).toBeNull();
    expect(buildApprovalPrompt("Glob", { pattern: "**/*.ts" })).toBeNull();
    expect(buildApprovalPrompt("LS", { path: "." })).toBeNull();
  });

  test("Write shows path + diff, not just the tool name", () => {
    const p = buildApprovalPrompt("Write", {
      file_path: "NOTES.md",
      content: "hello",
    });
    expect(p).not.toBeNull();
    if (p?.kind !== "write") throw new Error("expected write");
    expect(p.path).toBe("NOTES.md");
    expect(p.diff).toContain("+++ b/NOTES.md");
    expect(p.diff).toContain("+hello");
    expect(formatApprovalHeadline(p)).toContain("NOTES.md");
    expect(formatApprovalHeadline(p)).not.toBe("write");
  });

  test("Edit shows path + old/new diff", () => {
    const p = buildApprovalPrompt("Edit", {
      file_path: "src/a.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(p?.kind).toBe("edit");
    if (p?.kind !== "edit") throw new Error("expected edit");
    expect(p.path).toBe("src/a.ts");
    expect(p.diff).toContain("-foo");
    expect(p.diff).toContain("+bar");
  });

  test("Bash shows the command, not just bash", () => {
    const p = buildApprovalPrompt("Bash", { command: "npm test" });
    expect(p).toEqual({ kind: "bash", command: "npm test" });
    expect(formatApprovalHeadline(p!)).toContain("npm test");
  });

  test("prefers proposedPreview from diffs-review", () => {
    const p = buildApprovalPrompt(
      "Edit",
      { file_path: "a.ts", old_string: "x", new_string: "y" },
      "diff --git a/a.ts b/a.ts\n-x\n+y",
    );
    expect(p?.kind).toBe("edit");
    if (p?.kind !== "edit") throw new Error("expected edit");
    expect(p.diff).toContain("diff --git");
  });
});
```

- [ ] Tests `cli/src/llm/approval-deadline.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  approvalDeadlineIso,
  formatRemaining,
  isApprovalTimedOut,
  remainingApprovalMs,
} from "./approval-deadline";
import { ASK_APPROVAL_TIMEOUT_MS } from "./approval-constants";

describe("approval deadline", () => {
  test("remaining at t0 is the full timeout", () => {
    const now = Date.parse("2026-09-16T00:00:00.000Z");
    const iso = approvalDeadlineIso(now, ASK_APPROVAL_TIMEOUT_MS);
    expect(remainingApprovalMs(iso, now)).toBe(ASK_APPROVAL_TIMEOUT_MS);
    expect(formatRemaining(ASK_APPROVAL_TIMEOUT_MS)).toBe("5:00");
  });

  test("visible countdown formats mm:ss", () => {
    expect(formatRemaining(62_000)).toBe("1:02");
    expect(formatRemaining(0)).toBe("0:00");
  });

  test("after timeout remaining is 0 and isApprovalTimedOut", () => {
    const now = Date.parse("2026-09-16T00:00:00.000Z");
    const iso = approvalDeadlineIso(now, 1_000);
    expect(isApprovalTimedOut(iso, now + 1_000)).toBe(true);
    expect(remainingApprovalMs(iso, now + 5_000)).toBe(0);
  });
});
```

- [ ] Tests `cli/src/llm/approval-resolve.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  ALREADY_RESOLVED_APPROVED,
  ALREADY_RESOLVED_ERROR,
  NO_APPROVAL_ERROR,
} from "./approval-constants";
import {
  alreadyResolvedMessage,
  decideResolveGate,
  isAlreadyResolvedError,
} from "./approval-resolve";

describe("decideResolveGate", () => {
  test("first waiter wins", () => {
    expect(
      decideResolveGate({
        status: "awaiting_approval",
        resolution: null,
        inflight: false,
      }),
    ).toEqual({ ok: true });
  });

  test("second sees ya resuelto when resolution is set", () => {
    const r = decideResolveGate({
      status: "awaiting_approval",
      resolution: "approve",
      inflight: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(ALREADY_RESOLVED_APPROVED);
      expect(isAlreadyResolvedError(r.error)).toBe(true);
    }
  });

  test("second inflight request is ya resuelto", () => {
    const r = decideResolveGate({
      status: "awaiting_approval",
      inflight: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ALREADY_RESOLVED_ERROR);
  });

  test("done tool is not awaiting", () => {
    const r = decideResolveGate({
      status: "done",
      inflight: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(NO_APPROVAL_ERROR);
  });
});

describe("alreadyResolvedMessage", () => {
  test("bare ya resuelto is the default", () => {
    expect(alreadyResolvedMessage(null)).toBe("ya resuelto");
    expect(alreadyResolvedMessage("approve")).toBe("ya resuelto (approved)");
  });
});
```

- [ ] Tests del waiter (crear o extender `cli/src/llm/tool-approval.test.ts`). Casos **obligatorios**:

  1. `resolveApproval` primero → `true`; segundo → `false`.
  2. timeout con `{ timeoutMs: 20 }` resuelve `"timeout"` (no `"approve"`).
  3. `cancelApprovalsForChat` desbloquea.
  4. **no** existe un camino que resuelva `"approve"` sin `resolveApproval` explícito.

```ts
import { describe, expect, test } from "bun:test";
import {
  pendingApproval,
  resolveApproval,
  waitForApproval,
} from "./tool-approval";

describe("waitForApproval first-wins and timeout", () => {
  test("first resolve wins, second is false", async () => {
    const p = waitForApproval("t1", "c1", { timeoutMs: 5_000 });
    expect(resolveApproval("t1", "approve")).toBe(true);
    expect(await p).toBe("approve");
    expect(resolveApproval("t1", "deny")).toBe(false);
    expect(pendingApproval("t1")).toBe(false);
  });

  test("timeout denies — never auto-approves", async () => {
    const p = waitForApproval("t2", "c1", { timeoutMs: 20 });
    expect(await p).toBe("timeout");
    expect(pendingApproval("t2")).toBe(false);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/approval-prompt.test.ts src/llm/approval-deadline.test.ts src/llm/approval-resolve.test.ts src/llm/tool-approval.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/approval-constants.ts cli/src/llm/approval-prompt.ts \
  cli/src/llm/approval-deadline.ts cli/src/llm/approval-resolve.ts \
  cli/src/llm/approval-prompt.test.ts cli/src/llm/approval-deadline.test.ts \
  cli/src/llm/approval-resolve.test.ts cli/src/llm/tool-approval.ts \
  cli/src/llm/tool-approval.test.ts cli/package.json
git commit -m "feat(approvals): one-by-one prompt, deadline, and first-wins gate"
```

No incluir `tool-approval.ts` en el commit si ya venía de execution-modes sin cambios.

---

## Task 2: API — CAS primero gana, `ya resuelto`, persistir deadline, broadcast resolved

**Files:**

- Create: `api/src/llm/approval-constants.ts`
- Create: `api/src/llm/approval-resolve.ts`
- Test: `api/src/llm/approval-resolve.test.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API es el árbitro del **segundo cliente**. El daemon sigue siendo el árbitro del disco. Sin migración: `resolution` / `approvalDeadline` viven en jsonb.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si falta.

- [ ] Crear `api/src/llm/approval-constants.ts` — **mismos strings** que CLI para `ALREADY_RESOLVED_ERROR`, `ALREADY_RESOLVED_APPROVED`, `ALREADY_RESOLVED_DENIED`, `ALREADY_RESOLVED_TIMEOUT`, `NO_APPROVAL_ERROR`, `NO_DAEMON_ERROR`. No importar `cli/`.

- [ ] Crear `api/src/llm/approval-resolve.ts` — copiar `alreadyResolvedMessage`, `decideResolveGate`, `isAlreadyResolvedError` de Task 1 (misma semántica). Test idéntico al de CLI en `api/src/llm/approval-resolve.test.ts`.

- [ ] En `api/src/ws/protocol.ts`, `ClientMessage` ya tiene `toolCallId` / `status` / `metadata`. Añadir solo si faltan:

```ts
decision?: string;
resolvedBy?: string;
```

No hace falta un tipo extra: el payload viaja en `metadata` y en `data` del push.

- [ ] En `api/src/ws/handlers.ts`:

  1. Importar `fail`, `ok` (ya), `hub`, `chatMessages`, `eq`, `desc`.
  2. Importar `decideResolveGate`, `alreadyResolvedMessage` desde `../llm/approval-resolve`.
  3. Importar `NO_DAEMON_ERROR`, `NO_APPROVAL_ERROR` desde `../llm/approval-constants`.
  4. Module-scope (junto a los helpers del archivo, **no** globalThis):

```ts
const resolvingApproval = new Set<string>();

function approvalKey(chatId: string, toolCallId: string): string {
  return `${chatId}:${toolCallId}`;
}

function asMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

async function loadToolRow(chatId: string, toolCallId: string) {
  const existing = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.createdAt));
  return existing.find((m) => {
    const meta = asMeta(m.metadata);
    return m.role === "tool" && meta.toolCallId === toolCallId;
  });
}
```

  5. Si **no** existen (plan 2 no mergeado), añadir `chat.tool.update` **exactamente** como agent-tools Task 2 (merge de `status` / `input` / `metadata`, broadcast `chat.tool.update` + `message.appended` updated). Extra: al mergear, **conservar** `approvalDeadline`, `prompt`, `resolution` si el update no los pisa.

  6. Cases `agent.tool.approve` / `agent.tool.deny` — **reemplazar** el forward ciego del plan 2 (si existe) por este CAS. Si no existen, añadirlos:

```ts
case "agent.tool.approve":
case "agent.tool.deny": {
  if (!msg.chatId || !msg.toolCallId) {
    return fail(type, id, "chatId and toolCallId are required");
  }
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);

  const toolRow = await loadToolRow(msg.chatId, msg.toolCallId);
  if (!toolRow) return fail(type, id, "Tool call not found");
  const meta = asMeta(toolRow.metadata);
  const key = approvalKey(msg.chatId, msg.toolCallId);
  const gate = decideResolveGate({
    status: String(meta.status || ""),
    resolution: typeof meta.resolution === "string" ? meta.resolution : null,
    inflight: resolvingApproval.has(key),
  });
  if (!gate.ok) return fail(type, id, gate.error);

  resolvingApproval.add(key);
  try {
    const outcome = type === "agent.tool.approve" ? "approve" : "deny";
    const resolvedAt = new Date().toISOString();
    const nextMeta = {
      ...meta,
      resolution: outcome,
      resolvedBy: connectionId,
      resolvedAt,
    };
    await db
      .update(chatMessages)
      .set({ metadata: nextMeta })
      .where(eq(chatMessages.id, toolRow.id));
    const message = { ...toolRow, metadata: nextMeta };

    const sent = hub.sendTo(
      daemon.connectionId,
      hub.pushEvent(type, {
        chatId: msg.chatId,
        toolCallId: msg.toolCallId,
        requesterConnectionId: connectionId,
        outcome,
      }),
    );
    if (!sent) {
      await db
        .update(chatMessages)
        .set({ metadata: meta })
        .where(eq(chatMessages.id, toolRow.id));
      return fail(type, id, "Daemon connection unavailable");
    }

    broadcast(userId, "chat.tool.update", {
      message,
      chatId: msg.chatId,
    });
    broadcast(userId, "chat.tool.resolved", {
      chatId: msg.chatId,
      toolCallId: msg.toolCallId,
      outcome,
      resolvedBy: connectionId,
    });
    broadcast(userId, "message.appended", {
      message,
      chatId: msg.chatId,
      updated: true,
    });
    return ok(type, id, { forwarded: true, outcome });
  } finally {
    resolvingApproval.delete(key);
  }
}
```

  Orden **obligatorio**: load → `decideResolveGate` (incluye inflight) → add inflight → persist `resolution` → `sendTo` → broadcast. El segundo request, aunque entre en el mismo tick, ve `inflight` o `resolution` y recibe `ya resuelto`. **No** reenviar al daemon.

  Persistimos `resolution` **antes** de que el SDK corra para que el segundo cliente no gane la carrera. El `status` sigue `awaiting_approval` hasta `chat.tool.result` (approve) o hasta que el daemon publique `error` (deny/timeout). Los botones se ocultan por `resolution`, no por un status inventado.

  7. En `chat.tool.update`, si el daemon manda `status: "error"` con `metadata.resolution === "timeout"`, mergear y **además** `broadcast(userId, "chat.tool.resolved", { chatId, toolCallId, outcome: "timeout", resolvedBy: "timeout" })`. Así watch/Web/TUI pintan el timeout aunque nadie haya pulsado deny.

  8. `chat.stream.error`: si el plan 2 ya falla tools `running` / `awaiting_approval`, dejarlo. Si no, para cada tool de ese `streamId` con `status === "awaiting_approval"`, poner `status: "error"`, `resolution` intacto o `"deny"` si faltaba, y no dejar waiters (el daemon `cancelApprovalsForChat` en Task 3).

- [ ] En `api/openapi/openapi.yaml`, description de `/ws`:

  - Añadir a **Tipos implementados:** `chat.tool.update`, `agent.tool.approve`, `agent.tool.deny`.
  - Añadir: `agent.tool.approve` / `deny` hacen CAS; el segundo recibe error `ya resuelto`.
  - Push: `chat.tool.resolved` `{ chatId, toolCallId, outcome, resolvedBy }`.
  - `chat.tool.update` con `awaiting_approval` incluye `approvalDeadline` (ISO) y `prompt` (path+diff o command).

- [ ] Correr:

```bash
cd api && bun test src/llm/approval-resolve.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/llm/approval-constants.ts api/src/llm/approval-resolve.ts \
  api/src/llm/approval-resolve.test.ts api/src/ws/handlers.ts \
  api/src/ws/protocol.ts api/openapi/openapi.yaml api/package.json
git commit -m "feat(approvals): API first-wins CAS and already-resolved fan-out"
```

---

## Task 3: Daemon / runner — no auto-approve, payload junto a la pregunta, timeout libera busy

**Files:**

- Create: `cli/src/llm/handle-tool-resolution.ts` (si plan 3 no lo creó)
- Create: `cli/src/llm/can-use-tool.ts` (si plan 3 no lo creó; si existe, extender)
- Modify: `cli/src/llm/claude-runner.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Test: `cli/src/llm/can-use-tool.approval.test.ts`
- Test: `cli/src/llm/handle-tool-resolution.test.ts`

El SDK **no** escribe hasta `canUseTool` → `allow`. Headless **no** tiene un branch que resuelva `"approve"`. El `finally` del turn **siempre** cancela waiters y emite `agent.turn.ended` si ese tipo existe (plan 2); si no existe, al menos `turnBusy = false` en daemon.

- [ ] `cli/src/llm/handle-tool-resolution.ts`:

```ts
import type { WsPushMessage } from "../ws/client";
import { resolveApproval } from "./tool-approval";

export function handleToolResolutionPush(msg: WsPushMessage): boolean {
  if (msg.type !== "agent.tool.approve" && msg.type !== "agent.tool.deny") {
    return false;
  }
  const data = (msg.data || {}) as { toolCallId?: string };
  if (!data.toolCallId) return true;
  const outcome = msg.type === "agent.tool.approve" ? "approve" : "deny";
  resolveApproval(data.toolCallId, outcome);
  return true;
}
```

Si el archivo ya existe (plan 3), no duplicar. Test: un push `agent.turn.dispatch` **no** es handled; un approve sin pending no lanza.

```ts
import { describe, expect, test } from "bun:test";
import { handleToolResolutionPush } from "./handle-tool-resolution";
import { waitForApproval, pendingApproval } from "./tool-approval";

describe("handleToolResolutionPush", () => {
  test("does not treat dispatch as an approval", () => {
    expect(
      handleToolResolutionPush({
        type: "agent.turn.dispatch",
        push: true,
        eventId: "e",
        data: { chatId: "c" },
      }),
    ).toBe(false);
  });

  test("approve resolves waiter; missing pending is no-op not auto-approve", async () => {
    const p = waitForApproval("t-h", "c", { timeoutMs: 5_000 });
    expect(
      handleToolResolutionPush({
        type: "agent.tool.approve",
        push: true,
        eventId: "e",
        data: { toolCallId: "t-h" },
      }),
    ).toBe(true);
    expect(await p).toBe("approve");
    expect(
      handleToolResolutionPush({
        type: "agent.tool.approve",
        push: true,
        eventId: "e2",
        data: { toolCallId: "nope" },
      }),
    ).toBe(true);
    expect(pendingApproval("nope")).toBe(false);
  });
});
```

- [ ] `cli/src/llm/can-use-tool.ts` — si plan 3 ya tiene `decideCanUseTool`, **extenderlo** para que el caller de `ask` reciba el `sdkName` y **no** se invoque `ask()` en lecturas. Si no existe:

```ts
import { denyIfEscapes } from "./tool-sandbox";
import {
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  isReadSdkName,
} from "./approval-constants";

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export async function decideCanUseTool(input: {
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  executionMode?: string;
  ask?: () => Promise<"approve" | "deny" | "timeout" | "cancelled">;
}): Promise<PermissionDecision> {
  if (typeof denyIfEscapes === "function") {
    const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
    if (denied) return denied;
  }
  if (isReadSdkName(input.toolName)) {
    return { behavior: "allow" };
  }
  const mode = input.executionMode || "ask";
  if (mode === "auto") return { behavior: "allow" };
  if (mode === "plan") {
    return {
      behavior: "deny",
      message:
        "Plan mode: write/edit/bash are disabled. Switch to ask or auto to apply changes.",
    };
  }
  const outcome = (await input.ask?.()) ?? "deny";
  if (outcome === "approve") return { behavior: "allow" };
  return {
    behavior: "deny",
    message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
  };
}
```

Si `tool-sandbox.ts` no existe, **no** dejar el path abierto: copiar `denyIfEscapes` + `extractToolPath` de agent-tools Task 1 a `cli/src/llm/tool-sandbox.ts` (auto/ask no significan sin límites de path). Si `gateMutation` de plan 3 existe, **delegar** en él en lugar del `mode ===` inline.

- [ ] Tests `cli/src/llm/can-use-tool.approval.test.ts` (temp dir, **sin** SDK):

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { ASK_DENIED, ASK_TIMEOUT_DENIED } from "./approval-constants";

const cwd = mkdtempSync(join(tmpdir(), "chavez-ask-"));
writeFileSync(join(cwd, "in.txt"), "ok");

describe("decideCanUseTool ask", () => {
  test("Read/Grep/Glob never call ask()", async () => {
    for (const toolName of ["Read", "Grep", "Glob", "LS"]) {
      let called = false;
      const r = await decideCanUseTool({
        cwd,
        toolName,
        toolInput: { file_path: join(cwd, "in.txt"), pattern: "ok" },
        executionMode: "ask",
        ask: async () => {
          called = true;
          return "deny";
        },
      });
      expect(r.behavior).toBe("allow");
      expect(called).toBe(false);
    }
  });

  test("Write waits; timeout is deny not allow", async () => {
    const r = await decideCanUseTool({
      cwd,
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      executionMode: "ask",
      ask: async () => "timeout",
    });
    expect(r).toEqual({
      behavior: "deny",
      message: ASK_TIMEOUT_DENIED,
    });
  });

  test("missing ask() does not auto-approve", async () => {
    const r = await decideCanUseTool({
      cwd,
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      executionMode: "ask",
    });
    expect(r).toEqual({ behavior: "deny", message: ASK_DENIED });
  });
});
```

- [ ] En `cli/src/llm/claude-runner.ts`:

  1. Ampliar `RunClaudeTurnInput` con `executionMode?: string` y `onAskPermission?: AskPermission` (si plan 3 ya lo hizo, no duplicar el type).
  2. `permissionMode: "default"`, `permissionPrompts: "host"`. **Eliminar** `"bypassPermissions"` si aún está.
  3. `canUseTool` delega en `decideCanUseTool`. El callback `ask` **solo** se construye si `needsAskApproval(toolName)` (las lecturas ni siquiera reciben el closure que publica `awaiting_approval`).
  4. `tools` / `allowedTools`: si `DEFAULT_CLAUDE_TOOLS` existe, usarlo; si no, `["Read","Write","Edit","Grep","Glob","Bash"]`.

```ts
canUseTool: async (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOpts: { signal: AbortSignal; toolUseID?: string },
) => {
  const toolCallId = String(toolOpts.toolUseID || crypto.randomUUID());
  return decideCanUseTool({
    cwd: input.cwd,
    toolName,
    toolInput,
    executionMode: input.executionMode || "ask",
    ask: input.onAskPermission
      ? () =>
          input.onAskPermission!({
            toolCallId,
            toolName,
            input: toolInput,
            signal: toolOpts.signal,
          })
      : undefined,
  });
},
```

- [ ] En `cli/src/llm/publish-turn.ts`, `onAskPermission`:

```ts
import {
  ASK_APPROVAL_TIMEOUT_MS,
  ASK_TIMEOUT_DENIED,
  ASK_DENIED,
  HEADLESS_WAITING,
} from "./approval-constants";
import { approvalDeadlineIso } from "./approval-deadline";
import { buildApprovalPrompt, formatApprovalHeadline } from "./approval-prompt";
import { waitForApproval, cancelApprovalsForChat } from "./tool-approval";
import { canonicalToolName } from "./tool-names";
import { sanitizeToolInput, summarizeToolInput } from "./tool-display";

onAskPermission: async ({ toolCallId, toolName, input: toolInput, signal }) => {
  const deadline = approvalDeadlineIso();
  const proposedPreview =
    typeof (toolInput as { preview?: string }).preview === "string"
      ? String((toolInput as { preview?: string }).preview)
      : undefined;
  // If plan 6 collector can propose a diff, pass collector.previewFor(toolCallId).
  const prompt = buildApprovalPrompt(toolName, toolInput, proposedPreview);
  if (!prompt) {
    // reads must not reach here; belt
    return "approve";
  }
  const summary =
    typeof summarizeToolInput === "function"
      ? summarizeToolInput(toolName, toolInput)
      : formatApprovalHeadline(prompt);
  const inputSafe =
    typeof sanitizeToolInput === "function"
      ? sanitizeToolInput(toolInput)
      : toolInput;
  const name =
    typeof canonicalToolName === "function"
      ? canonicalToolName(toolName)
      : toolName.toLowerCase();

  const update = await client.request({
    type: "chat.tool.update",
    chatId,
    streamId,
    toolCallId,
    toolName: name,
    status: "awaiting_approval",
    metadata: {
      sdkName: toolName,
      input: inputSafe,
      summary,
      approvalDeadline: deadline,
      remainingMs: ASK_APPROVAL_TIMEOUT_MS,
      prompt,
      diff:
        prompt.kind === "write" || prompt.kind === "edit"
          ? { path: prompt.path, preview: prompt.diff, kind: prompt.kind }
          : undefined,
    },
  });
  if (!update.ok) {
    await client.request({
      type: "chat.tool.start",
      chatId,
      streamId,
      toolCallId,
      toolName: name,
      status: "awaiting_approval",
      content: formatApprovalHeadline(prompt),
      metadata: {
        sdkName: toolName,
        input: inputSafe,
        summary,
        approvalDeadline: deadline,
        remainingMs: ASK_APPROVAL_TIMEOUT_MS,
        prompt,
      },
    });
  }
  console.error(HEADLESS_WAITING);

  const outcome = await waitForApproval(toolCallId, chatId, {
    timeoutMs: ASK_APPROVAL_TIMEOUT_MS,
    signal,
  });

  if (outcome === "timeout") {
    await client.request({
      type: "chat.tool.update",
      chatId,
      streamId,
      toolCallId,
      status: "error",
      content: ASK_TIMEOUT_DENIED,
      metadata: {
        resolution: "timeout",
        resolvedBy: "timeout",
        resolvedAt: new Date().toISOString(),
        output: ASK_TIMEOUT_DENIED,
      },
    });
  }
  if (outcome === "deny" || outcome === "cancelled") {
    await client.request({
      type: "chat.tool.update",
      chatId,
      streamId,
      toolCallId,
      status: "error",
      content: ASK_DENIED,
      metadata: {
        resolution: "deny",
        resolvedAt: new Date().toISOString(),
        output: ASK_DENIED,
      },
    });
  }
  return outcome;
},
```

Si `canonicalToolName` / `sanitizeToolInput` / `summarizeToolInput` no existen, usar el fallback indicado; **no** dejar `awaiting_approval` sin `prompt`.

En el `finally` de `publishAgentTurn` (junto a `agent.turn.ended` si el plan 2 lo añadió):

```ts
cancelApprovalsForChat(chatId);
```

Si `agent.turn.ended` no existe, el daemon `finally { turnBusy = false }` ya cubre el lock local. Añadir `client.request({ type: "agent.turn.ended", chatId })` **solo** si el handler API ya lo acepta (plan 2). No inventar un tipo que el API rechace con `Unknown type`.

El `console.error(HEADLESS_WAITING)` va al log del daemon (`~/.chavez/workspaces/*.log`). **No** es un approve. Watch/Web no lo necesitan para el countdown (usan `approvalDeadline`).

Pasar `executionMode` a `runClaudeTurn`: `parseExecutionMode` si existe; si no, `input.executionMode || "ask"`.

- [ ] En `cli/src/ws/daemon.ts`, el `onPush` actual solo atiende `agent.turn.dispatch`. Cambiar a:

```ts
import { handleToolResolutionPush } from "../llm/handle-tool-resolution";

client.onPush(async (msg: WsPushMessage) => {
  if (handleToolResolutionPush(msg)) {
    const data = (msg.data || {}) as { toolCallId?: string };
    log(`${msg.type} toolCallId=${data.toolCallId ?? "?"}`);
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  // … busy guard existente …
});
```

**Prohibido** en este archivo: `resolveApproval(..., "approve")` fuera de `handleToolResolutionPush`. Grep de verificación (Task 7) lo comprueba. No leer stdin. No tratar un timeout como approve.

- [ ] Correr:

```bash
cd cli && bun test src/llm/can-use-tool.approval.test.ts src/llm/handle-tool-resolution.test.ts src/llm/approval-prompt.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/handle-tool-resolution.ts \
  cli/src/llm/handle-tool-resolution.test.ts cli/src/llm/can-use-tool.ts \
  cli/src/llm/can-use-tool.approval.test.ts cli/src/llm/claude-runner.ts \
  cli/src/llm/publish-turn.ts cli/src/ws/daemon.ts cli/src/llm/tool-sandbox.ts
git commit -m "feat(approvals): daemon waits in ask; timeout denies; no silent write"
```

No incluir `tool-sandbox.ts` si ya venía de agent-tools sin cambios.

---

## Task 4: CLI — watch resuelve, `chat approve`/`deny`, timeout visible, headless no auto-aprueba

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (crear si plan 2 no lo hizo)
- Test: `cli/src/llm/watch-format.test.ts`
- Test: `cli/src/commands/headless-approval.test.ts`

Watch es un **observador que puede resolver** si stdin es TTY. El daemon headless **no** es TTY. `chat ask` dispara el turn y sale; no espera ni aprueba.

- [ ] En `cli/src/llm/watch-format.ts` (crear mínimo si no existe):

```ts
import {
  ALREADY_RESOLVED_ERROR,
  WATCH_APPROVAL_HINT,
} from "./approval-constants";
import { formatRemaining, remainingApprovalMs } from "./approval-deadline";
import { formatApprovalHeadline, type ApprovalPrompt } from "./approval-prompt";

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function metaOf(data: Record<string, unknown>): Record<string, unknown> {
  const message = rec(data.message);
  return rec(message?.metadata) || rec(data.metadata) || {};
}

export function formatWatchLine(
  type: string,
  data: Record<string, unknown>,
): string | null {
  if (type === "chat.tool.resolved") {
    const outcome = String(data.outcome || "");
    const id = String(data.toolCallId || "").slice(0, 8);
    if (outcome === "timeout") {
      return `tool · ${id}… · timeout — Approval timed out after 300s — tool denied`;
    }
    return `tool · ${id}… · ${ALREADY_RESOLVED_ERROR} (${outcome || "resolved"})`;
  }

  if (
    type !== "chat.tool.update" &&
    type !== "chat.tool.start" &&
    type !== "chat.tool.result"
  ) {
    return null;
  }

  const meta = metaOf(data);
  const status = String(meta.status || data.status || "");
  const prompt = meta.prompt as ApprovalPrompt | undefined;
  const name = String(meta.toolName || data.toolName || "tool");
  const chatId = String(data.chatId || rec(data.message)?.chatId || "");
  const toolCallId = String(meta.toolCallId || "");

  if (status === "awaiting_approval") {
    const head = prompt
      ? formatApprovalHeadline(prompt)
      : `tool · ${name} · awaiting_approval`;
    const body =
      prompt && (prompt.kind === "write" || prompt.kind === "edit")
        ? `\n${prompt.diff}`
        : prompt?.kind === "bash"
          ? `\n$ ${prompt.command}`
          : "";
    const deadline =
      typeof meta.approvalDeadline === "string"
        ? meta.approvalDeadline
        : "";
    const left = deadline
      ? `\ntimeout in ${formatRemaining(remainingApprovalMs(deadline))}`
      : "";
    const hint =
      chatId && toolCallId
        ? `\n${WATCH_APPROVAL_HINT.replace("<chatId>", chatId).replace("<toolCallId>", toolCallId)}`
        : `\n${WATCH_APPROVAL_HINT}`;
    return `${head} · awaiting_approval${body}${left}${hint}`;
  }

  if (meta.resolution && status === "error") {
    return `tool · ${name} · error · ${ALREADY_RESOLVED_ERROR} (${meta.resolution})`;
  }
  return `tool · ${name} · ${status || "running"}`;
}
```

Si `formatWatchLine` **ya** existe (plan 2), **añadir** los branches `awaiting_approval`, `chat.tool.resolved` y el body path/diff/command. No tirar el resto (stream delta, done). El JSON crudo deja de ser el único output cuando esta función devuelve string; si el watch aún imprime JSON, imprimir **además** la línea compacta (no en lugar, hasta que plan 2 lo sustituya). En esta fase: si `formatWatchLine` retorna no-null, imprimir esa línea; si null, caer al JSON.

- [ ] Tests `cli/src/llm/watch-format.test.ts` (añadir casos; crear archivo si falta):

```ts
import { describe, expect, test } from "bun:test";
import { formatWatchLine } from "./watch-format";
import { approvalDeadlineIso } from "./approval-deadline";

describe("formatWatchLine ask", () => {
  test("awaiting write shows path + diff and approval needed, never auto-approved", () => {
    const line = formatWatchLine("chat.tool.update", {
      chatId: "chat-1",
      message: {
        chatId: "chat-1",
        metadata: {
          toolCallId: "tool-1",
          toolName: "write",
          status: "awaiting_approval",
          approvalDeadline: approvalDeadlineIso(),
          prompt: {
            kind: "write",
            path: "NOTES.md",
            diff: "+++ b/NOTES.md\n+hello",
            truncated: false,
          },
        },
      },
    });
    expect(line).toContain("NOTES.md");
    expect(line).toContain("+hello");
    expect(line).toContain("awaiting_approval");
    expect(line).toContain("approval needed");
    expect(line).toContain("chat-1");
    expect(line).toContain("tool-1");
    expect(line).not.toContain("auto-approved");
  });

  test("bash shows the command", () => {
    const line = formatWatchLine("chat.tool.update", {
      chatId: "c",
      message: {
        metadata: {
          toolCallId: "t",
          toolName: "bash",
          status: "awaiting_approval",
          prompt: { kind: "bash", command: "npm test" },
        },
      },
    });
    expect(line).toContain("npm test");
  });

  test("resolved prints ya resuelto", () => {
    const line = formatWatchLine("chat.tool.resolved", {
      chatId: "c",
      toolCallId: "abcdefghij",
      outcome: "approve",
    });
    expect(line).toContain("ya resuelto");
  });

  test("timeout line is visible", () => {
    const line = formatWatchLine("chat.tool.resolved", {
      toolCallId: "zzzzzzzz",
      outcome: "timeout",
    });
    expect(line).toContain("timeout");
    expect(line).toContain("300s");
  });
});
```

- [ ] En `cli/src/commands/headless.ts`:

  1. Importar `formatWatchLine` y `ALREADY_RESOLVED_ERROR`.
  2. Acciones nuevas `approve` / `deny` (si plan 3 ya las puso, no duplicar; sí: si `!res.ok` y el error contiene `ya resuelto`, `console.error(res.error)` y `process.exit(1)`):

```ts
if (action === "approve" || action === "deny") {
  const chatId = rest[0];
  const toolCallId = rest[1];
  if (!chatId || !toolCallId) {
    throw new Error(`Uso: … chat ${action} <chatId> <toolCallId>`);
  }
  const res = await client.request({
    type: action === "approve" ? "agent.tool.approve" : "agent.tool.deny",
    chatId,
    toolCallId,
  });
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  return;
}
```

  Actualizar el `throw` de uso de `chat` a:

```
Uso: chavez headless chat <create|list|append|get|ask|watch|approve|deny> …
```

  3. `ask` **no** auto-aprueba. Tras `ok`, el aviso existente se amplía:

```
Turn aceptado por el daemon. En modo ask, write/edit/bash esperan Web, TUI o `chat watch` — no se auto-aprueban.
Usa `chavez headless chat watch <chatId>` o `chavez headless chat approve <chatId> <toolCallId>`.
```

  4. `watch`: **no** cerrar el client. Imprimir líneas de `formatWatchLine`. Si `process.stdin.isTTY === true`, leer líneas y resolver el **último** `awaiting_approval` visto (uno a uno):

```ts
if (action === "watch") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: … chat watch <chatId>");
  const watchClient = client;
  let lastAwaiting: { chatId: string; toolCallId: string } | null = null;

  watchClient.onPush((msg) => {
    const data = (msg.data || {}) as Record<string, unknown>;
    if (data.chatId && data.chatId !== chatId) return;
    const line = formatWatchLine(msg.type, data);
    if (line) console.log(line);
    else {
      console.log(
        JSON.stringify({ type: msg.type, eventId: msg.eventId, data: msg.data }),
      );
    }
    if (msg.type === "chat.tool.update" || msg.type === "chat.tool.start") {
      const message = (data.message || {}) as {
        metadata?: Record<string, unknown>;
      };
      const meta = message.metadata || {};
      if (meta.status === "awaiting_approval" && meta.toolCallId) {
        lastAwaiting = { chatId, toolCallId: String(meta.toolCallId) };
      }
      if (meta.resolution) lastAwaiting = null;
    }
    if (msg.type === "chat.tool.resolved") lastAwaiting = null;
  });

  if (process.stdin.isTTY) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.on("line", async (raw) => {
      const t = raw.trim().toLowerCase();
      if (t !== "y" && t !== "n" && t !== "approve" && t !== "deny") return;
      if (!lastAwaiting) {
        console.error("No tool awaiting approval");
        return;
      }
      const decision =
        t === "y" || t === "approve" ? "agent.tool.approve" : "agent.tool.deny";
      const res = await watchClient.request({
        type: decision,
        chatId: lastAwaiting.chatId,
        toolCallId: lastAwaiting.toolCallId,
      });
      if (!res.ok) {
        console.error(res.error || "ya resuelto");
        return;
      }
      lastAwaiting = null;
    });
  }

  console.error(`watching chat=${chatId} (Ctrl+C para salir)`);
  await new Promise(() => {});
  return;
}
```

  Si stdin **no** es TTY, solo se imprime el hint: el usuario usa `chat approve` en otra terminal. **Nunca** se envía approve solo por ver el evento.

- [ ] En `cli/src/index.ts` `usage()` añadir:

```
  chavez headless chat approve <chatId> <toolCallId>
  chavez headless chat deny <chatId> <toolCallId>
  chavez headless chat watch <chatId>   # y/n si TTY; nunca auto-aprueba
```

- [ ] Test de parse de acciones (sin WS) en `cli/src/commands/headless-approval.test.ts`: extraer el parser de `approve`/`deny` args a un helper exportado para no mockear la red.

```ts
export function parseApproveArgs(
  action: string,
  rest: string[],
): { action: "approve" | "deny"; chatId: string; toolCallId: string } {
  if (action !== "approve" && action !== "deny") {
    throw new Error("not an approval action");
  }
  const chatId = rest[0];
  const toolCallId = rest[1];
  if (!chatId || !toolCallId) {
    throw new Error(`Uso: … chat ${action} <chatId> <toolCallId>`);
  }
  return { action, chatId, toolCallId };
}
```

```ts
import { describe, expect, test } from "bun:test";
import { parseApproveArgs } from "./headless";

test("approve requires both ids — one at a time", () => {
  expect(parseApproveArgs("approve", ["c1", "t1"])).toEqual({
    action: "approve",
    chatId: "c1",
    toolCallId: "t1",
  });
  expect(() => parseApproveArgs("approve", ["c1"])).toThrow("toolCallId");
});
```

Si exportar desde `headless.ts` ensucia el CLI, poner el helper en `cli/src/commands/approval-args.ts` e importarlo en `headless.ts`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts src/commands/headless-approval.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  cli/src/commands/headless-approval.test.ts cli/src/commands/approval-args.ts
git commit -m "feat(approvals): CLI watch and approve/deny; never auto-approve"
```

---

## Task 5: TUI — `[y]`/`[n]` uno a uno, countdown, ya resuelto, path+diff/comando

**Files:**

- Modify: `tui/src/App.tsx`

La TUI es daemon **y** observador. Un turn disparado desde Web aparece aquí. `[y]`/`[n]` funcionan **aunque** `busy`. Compose sigue bloqueado. No hay “siempre”. Lecturas no pintan el banner de approval.

- [ ] Ampliar el type:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna lo que viene de `chat.get`; no filtrar `metadata`.

- [ ] Imports:

```ts
import { handleToolResolutionPush } from "../../cli/src/llm/handle-tool-resolution";
import {
  ALREADY_RESOLVED_ERROR,
  NO_APPROVAL_ERROR,
} from "../../cli/src/llm/approval-constants";
import {
  formatRemaining,
  remainingApprovalMs,
} from "../../cli/src/llm/approval-deadline";
import {
  formatApprovalHeadline,
  type ApprovalPrompt,
} from "../../cli/src/llm/approval-prompt";
```

- [ ] State:

```ts
const [nowMs, setNowMs] = useState(() => Date.now());
const [resolveMsg, setResolveMsg] = useState<string | null>(null);
```

`useEffect` que, mientras exista un tool `awaiting_approval` **sin** `resolution` en `messages`, hace `setInterval` 1s → `setNowMs(Date.now())`. Cleanup al desmontar o cuando no hay awaiting.

- [ ] Helper (dentro de `App`, antes del return):

```ts
function firstAwaiting(list: Message[]): Message | undefined {
  return list.find((m) => {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const sdk = String(meta.sdkName || "");
    if (sdk === "Read" || sdk === "Grep" || sdk === "Glob" || sdk === "LS") {
      return false;
    }
    return (
      m.role === "tool" &&
      meta.status === "awaiting_approval" &&
      !meta.resolution &&
      meta.toolCallId
    );
  });
}
```

- [ ] En el `onPush` (efecto live sync), **antes** de `agent.turn.dispatch`:

```ts
if (handleToolResolutionPush(msg)) return;
```

Así un approve llegado por el hub desbloquea el waiter **en este proceso** (TUI-as-daemon). Un segundo approve local que el API rechace no llama a `resolveApproval`.

También invalidar mensajes en `chat.tool.resolved` (mismo `loadChat` que `chat.tool.*`).

- [ ] `useInput`: **antes** de `if (busy) return` en command mode (no dentro de compose):

```ts
async function resolveFirstAwaiting(decision: "approve" | "deny") {
  if (!client || !activeChatId) return;
  const awaiting = firstAwaiting(messages);
  if (!awaiting) {
    setLog(NO_APPROVAL_ERROR);
    return;
  }
  const toolCallId = String(
    (awaiting.metadata as Record<string, unknown>).toolCallId,
  );
  const res = await client.request({
    type: decision === "approve" ? "agent.tool.approve" : "agent.tool.deny",
    chatId: activeChatId,
    toolCallId,
  });
  if (!res.ok) {
    setResolveMsg(res.error || ALREADY_RESOLVED_ERROR);
    setLog(res.error || ALREADY_RESOLVED_ERROR);
    return;
  }
  setResolveMsg(null);
  setLog(`${decision} ${toolCallId.slice(0, 8)}…`);
}

if (ch === "y" || ch === "n") {
  await resolveFirstAwaiting(ch === "y" ? "approve" : "deny");
  return;
}
```

`find`, no `filter`. Un `y` = un tool. Si el API responde `ya resuelto`, se muestra en el log (el otro cliente ganó).

- [ ] Banner (encima de Messages, debajo de `busy`):

```tsx
{(() => {
  const awaiting = firstAwaiting(messages);
  if (!awaiting) {
    return resolveMsg ? (
      <Text color="yellow">{resolveMsg}</Text>
    ) : null;
  }
  const meta = (awaiting.metadata || {}) as Record<string, unknown>;
  const prompt = meta.prompt as ApprovalPrompt | undefined;
  const deadline =
    typeof meta.approvalDeadline === "string" ? meta.approvalDeadline : "";
  const left = deadline
    ? formatRemaining(remainingApprovalMs(deadline, nowMs))
    : "?";
  const head = prompt
    ? formatApprovalHeadline(prompt)
    : String(meta.summary || meta.toolName || "tool");
  const body =
    prompt && (prompt.kind === "write" || prompt.kind === "edit")
      ? prompt.diff.split("\n").slice(0, 8).join("\n")
      : prompt?.kind === "bash"
        ? `$ ${prompt.command}`
        : "";
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        awaiting approval {left} — [y] sí  [n] no (uno a uno)
      </Text>
      <Text>{head}</Text>
      {body ? <Text dimColor>{body}</Text> : null}
    </Box>
  );
})()}
```

- [ ] Timeline: tools se distinguen. Para `role === "tool"`:

```tsx
{m.role === "tool" ? (
  <Text key={m.id} wrap="truncate-end">
    <Text color="yellow">
      tool · {String((m.metadata as Record<string, unknown> | null)?.toolName || "tool")} ·{" "}
      {String((m.metadata as Record<string, unknown> | null)?.status || "")}
      {(m.metadata as Record<string, unknown> | null)?.resolution
        ? ` · ${ALREADY_RESOLVED_ERROR}`
        : ""}
    </Text>
    {" "}
    {String(
      (m.metadata as Record<string, unknown> | null)?.summary ||
        m.content,
    )
      .replace(/\s+/g, " ")
      .slice(0, 80)}
  </Text>
) : (
  // existing user/assistant line
)}
```

Lecturas (`status` running/done, sin `resolution`) **no** muestran `ya resuelto` ni el banner. Un grep enorme sigue truncado a 80 chars como el resto.

- [ ] Ayuda: añadir `[y]/[n] approval` a la línea de atajos.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(approvals): TUI y/n one-by-one with visible timeout and diff"
```

---

## Task 6: Web — botones, countdown, ya resuelto, diff/comando; lecturas sin diálogo

**Files:**

- Create: `web/src/lib/approval-constants.ts`
- Create: `web/src/lib/approval-deadline.ts`
- Create: `web/src/lib/approval-prompt.ts`
- Test: `web/src/lib/approval-deadline.test.ts`
- Test: `web/src/lib/approval-prompt.test.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web no ejecuta tools. Pinta el pedido y manda `agent.tool.approve` / `deny`. El daemon escribe.

- [ ] Añadir `"test": "bun test"` en `web/package.json` scripts si falta.

- [ ] `web/src/lib/approval-constants.ts` — copiar `ALREADY_RESOLVED_*`, `NO_APPROVAL_ERROR`, `APPROVAL_COUNTDOWN_TICK_MS`. No importar `cli/`.

- [ ] `web/src/lib/approval-deadline.ts` — copiar `remainingApprovalMs`, `formatRemaining`, `isApprovalTimedOut` (misma aritmética que CLI). Test: `formatRemaining(300_000) === "5:00"`, timeout → 0.

- [ ] `web/src/lib/approval-prompt.ts` — type `ApprovalPrompt` + `formatApprovalHeadline` (copia). No hace falta `buildApprovalPrompt` (el daemon ya mandó `metadata.prompt`). Test: headline de `{ kind: "bash", command: "npm test" }` contiene `npm test`.

- [ ] En `web/src/lib/ws-context.tsx`, el tipo de `request` **añade** `toolCallId?: string` y `status?: string` si aún no están. En el `onPush` que invalida queries, tratar también `chat.tool.resolved`:

```ts
if (
  msg.type === "message.appended" ||
  msg.type.startsWith("chat.stream.") ||
  msg.type.startsWith("chat.tool.") ||
  msg.type === "chat.created" ||
  msg.type === "session.created"
) {
```

`chat.tool.resolved` ya entra por `startsWith("chat.tool.")`.

- [ ] En `web/src/lib/ws-hooks.ts`, si `useWsToolResolve` **no** existe (plan 2), añadirlo:

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

No duplicar si ya está.

- [ ] En `web/src/styles/global.css`, junto a `.badge.err` (si plan 2 no puso `.badge.warn`):

```css
.badge.warn {
  color: #f0c36d;
  border-color: color-mix(in srgb, #f0c36d 40%, var(--border));
}
.approval-diff {
  max-height: 16rem;
  overflow: auto;
  font-size: 0.8rem;
  white-space: pre-wrap;
  margin: 0.5rem 0 0;
}
.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
}
```

- [ ] Reemplazar `ToolCard` en `web/src/components/ChatDetailPanel.tsx`. **Un** toolCallId por click. **Sin** botón “siempre permitir”. **Sin** checkbox de lote.

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { ALREADY_RESOLVED_ERROR } from "../lib/approval-constants";
import {
  formatRemaining,
  remainingApprovalMs,
} from "../lib/approval-deadline";
import {
  formatApprovalHeadline,
  type ApprovalPrompt,
} from "../lib/approval-prompt";
import { useWsToolResolve } from "../lib/ws-hooks";

const READ_CANON = new Set(["read", "grep", "glob"]);

function isReadTool(meta: Record<string, unknown>): boolean {
  const canon = String(meta.toolName || "").toLowerCase();
  const sdk = String(meta.sdkName || "");
  return (
    READ_CANON.has(canon) ||
    sdk === "Read" ||
    sdk === "Grep" ||
    sdk === "Glob" ||
    sdk === "LS"
  );
}

function ToolCard({ m, chatId }: { m: ChatMessage; chatId: string }) {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const name = String(meta.toolName || m.content || "tool");
  const status = String(meta.status || "running");
  const resolve = useWsToolResolve();
  const [now, setNow] = useState(() => Date.now());
  const [localError, setLocalError] = useState<string | null>(null);
  const prompt = meta.prompt as ApprovalPrompt | undefined;
  const awaiting =
    status === "awaiting_approval" && !meta.resolution && !isReadTool(meta);
  const deadline =
    typeof meta.approvalDeadline === "string" ? meta.approvalDeadline : "";

  useEffect(() => {
    if (!awaiting || !deadline) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [awaiting, deadline]);

  async function decide(decision: "approve" | "deny") {
    setLocalError(null);
    try {
      const res = await resolve.mutateAsync({
        chatId,
        toolCallId: String(meta.toolCallId),
        decision,
      });
      if (!res.ok) {
        setLocalError(res.error || ALREADY_RESOLVED_ERROR);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setLocalError(text);
    }
  }

  return (
    <div className="panel tool-card" style={{ marginBottom: "0.5rem" }}>
      <span
        className={`badge ${
          status === "done"
            ? "ok"
            : status === "error"
              ? "err"
              : awaiting
                ? "warn"
                : ""
        }`}
      >
        tool · {name} · {status}
        {meta.resolution ? ` · ${ALREADY_RESOLVED_ERROR}` : ""}
      </span>
      {prompt ? (
        <p style={{ margin: "0.5rem 0 0" }}>
          {formatApprovalHeadline(prompt)}
        </p>
      ) : meta.summary ? (
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          {String(meta.summary)}
        </p>
      ) : null}
      {prompt && (prompt.kind === "write" || prompt.kind === "edit") && (
        <pre className="approval-diff">{prompt.diff}</pre>
      )}
      {prompt?.kind === "bash" && (
        <pre className="approval-diff">$ {prompt.command}</pre>
      )}
      {awaiting && deadline && (
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          Timeout en {formatRemaining(remainingApprovalMs(deadline, now))}
        </p>
      )}
      {awaiting && (
        <div className="approval-actions">
          <button
            type="button"
            disabled={resolve.isPending}
            onClick={() => void decide("approve")}
          >
            Aprobar
          </button>
          <button
            type="button"
            className="secondary"
            disabled={resolve.isPending}
            onClick={() => void decide("deny")}
          >
            Rechazar
          </button>
        </div>
      )}
      {!awaiting && meta.resolution && (
        <p className="muted">
          {typeof localError === "string" && localError.includes("ya resuelto")
            ? localError
            : `${ALREADY_RESOLVED_ERROR} (${String(meta.resolution)})`}
        </p>
      )}
      {localError && <p className="error">{localError}</p>}
      {meta.output != null && status !== "awaiting_approval" && (
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
          out: {typeof meta.output === "string" ? meta.output : JSON.stringify(meta.output)}
        </pre>
      )}
    </div>
  );
}
```

Pasar `chatId` desde el map:

```tsx
m.role === "tool" ? (
  <ToolCard key={m.id} m={m} chatId={chatId} />
) : (
```

Lecturas: `isReadTool` → `awaiting` false aunque un bug marcara `awaiting_approval`. No hay botones.

Si el segundo click llega `ok: false` con `ya resuelto`, `localError` lo muestra (escenario Gherkin).

**No** añadir un tercer botón. **No** “Aprobar todas”.

- [ ] `WorkspaceDetailPanel.tsx` preview: si el último mensaje es tool `awaiting_approval`, el texto es `tool · {name} · awaiting_approval`, no un assistant vacío.

```ts
if (m.role === "tool") {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const name = String(meta.toolName || m.content || "tool");
  const status = String(meta.status || "");
  return status ? `tool · ${name} · ${status}` : `tool · ${name}`;
}
```

- [ ] Correr:

```bash
cd web && bun test src/lib/approval-deadline.test.ts src/lib/approval-prompt.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/approval-constants.ts web/src/lib/approval-deadline.ts \
  web/src/lib/approval-deadline.test.ts web/src/lib/approval-prompt.ts \
  web/src/lib/approval-prompt.test.ts web/src/lib/ws-hooks.ts \
  web/src/lib/ws-context.tsx web/src/lib/ws-client.ts \
  web/src/components/ChatDetailPanel.tsx \
  web/src/components/WorkspaceDetailPanel.tsx web/src/styles/global.css \
  web/package.json
git commit -m "feat(approvals): Web one-by-one approve with diff and visible timeout"
```

---

## Task 7: Smoke Gherkin — dos clientes, timeout, headless, lecturas, path+diff

**Files:**

- Create: `cli/scripts/approvals-smoke.ts`
- Create: `cli/src/llm/headless-no-auto-approve.test.ts`

Sin LLM vivo (cuota). El proceso de test actúa como daemon: publica `awaiting_approval`, espera `waitForApproval`, resuelve o deja timeout. Cubre los cinco escenarios.

- [ ] Crear `cli/src/llm/headless-no-auto-approve.test.ts` — grep estático para que un refactor no meta auto-approve en el daemon:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("headless daemon never auto-approves", () => {
  test("daemon.ts has no resolveApproval approve of its own", () => {
    const src = readFileSync(
      join(import.meta.dir, "../ws/daemon.ts"),
      "utf8",
    );
    expect(src).toContain("handleToolResolutionPush");
    expect(src).not.toMatch(/resolveApproval\([^)]*["']approve["']/);
    expect(src).not.toMatch(/onAskPermission[\s\S]*return ["']approve["']/);
  });

  test("workspaceOpen ignores stdin so the daemon cannot type y", () => {
    const src = readFileSync(
      join(import.meta.dir, "../commands/headless.ts"),
      "utf8",
    );
    expect(src).toContain('stdin: "ignore"');
  });
});
```

- [ ] Crear `cli/scripts/approvals-smoke.ts`:

```ts
/**
 * Smoke: first-wins ya resuelto, timeout visible, headless no auto-approve,
 * prompt has path+diff, reads never await.
 * Needs: chavez login, API up. This process binds as daemon.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  ALREADY_RESOLVED_ERROR,
  ASK_APPROVAL_TIMEOUT_MS,
  HEADLESS_WAITING,
} from "../src/llm/approval-constants";
import { waitForApproval, resolveApproval } from "../src/llm/tool-approval";
import { buildApprovalPrompt } from "../src/llm/approval-prompt";
import { decideCanUseTool } from "../src/llm/can-use-tool";
import { handleToolResolutionPush } from "../src/llm/handle-tool-resolution";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

// --- reads never ask (local, no WS) ---
{
  const cwd = mkdtempSync(join(tmpdir(), "chavez-appr-"));
  writeFileSync(join(cwd, "in.txt"), "ok");
  let called = false;
  const r = await decideCanUseTool({
    cwd,
    toolName: "Read",
    toolInput: { file_path: join(cwd, "in.txt") },
    executionMode: "ask",
    ask: async () => {
      called = true;
      return "approve";
    },
  });
  if (r.behavior !== "allow" || called) fail("reads must not go through approval");
  if (buildApprovalPrompt("Read", { file_path: "in.txt" }) !== null) {
    fail("read prompt must be null");
  }
  const w = buildApprovalPrompt("Write", {
    file_path: "NOTES.md",
    content: "hi",
  });
  if (!w || w.kind !== "write" || !w.diff.includes("NOTES.md")) {
    fail("write prompt must show path + diff");
  }
  const b = buildApprovalPrompt("Bash", { command: "ls" });
  if (!b || b.kind !== "bash" || b.command !== "ls") {
    fail("bash prompt must show command");
  }
  console.log("ok reads-and-prompt");
}

// --- first-wins waiter (in-process) ---
{
  const p = waitForApproval("smoke-t1", "smoke-c", { timeoutMs: 5_000 });
  if (!resolveApproval("smoke-t1", "approve")) fail("first resolve must win");
  if ((await p) !== "approve") fail("waiter outcome");
  if (resolveApproval("smoke-t1", "deny")) fail("second resolve must lose");
  console.log("ok waiter-first-wins");
}

// --- timeout does not auto-approve ---
{
  const p = waitForApproval("smoke-t2", "smoke-c", { timeoutMs: 30 });
  const outcome = await p;
  if (outcome !== "timeout") fail(`expected timeout, got ${outcome}`);
  console.log("ok timeout-denies");
}

// --- WS: two clients, CAS ya resuelto ---
const daemon = new ChavezWsClient(token);
const web = new ChavezWsClient(token);
const watch = new ChavezWsClient(token);
await daemon.connect();
await web.connect();
await watch.connect();
const bindPath = cwdPath();
const db = await daemon.bind(bindPath, "daemon");
if (!db.ok) fail(db.error || "daemon bind");
const wb = await web.bind(bindPath, "client");
if (!wb.ok) fail(wb.error || "web bind");
const wtb = await watch.bind(bindPath, "client");
if (!wtb.ok) fail(wtb.error || "watch bind");

const sessions = await web.request({ type: "session.list" });
if (!sessions.ok) fail(sessions.error || "session.list");
let sessionId = (sessions.data as { sessions?: { id: string }[] })?.sessions?.[0]
  ?.id;
if (!sessionId) {
  const created = await web.request({
    type: "session.create",
    title: "approvals-smoke",
  });
  if (!created.ok) fail(created.error || "session.create");
  sessionId = (created.data as { session: { id: string } }).session.id;
}
const chatRes = await web.request({
  type: "chat.create",
  sessionId,
  title: "approvals-smoke",
});
if (!chatRes.ok) fail(chatRes.error || "chat.create");
const chatId = (chatRes.data as { chat: { id: string } }).chat.id;

const toolCallId = crypto.randomUUID();
const start = await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId,
  toolName: "write",
  status: "awaiting_approval",
  metadata: {
    sdkName: "Write",
    status: "awaiting_approval",
    approvalDeadline: new Date(Date.now() + ASK_APPROVAL_TIMEOUT_MS).toISOString(),
    remainingMs: ASK_APPROVAL_TIMEOUT_MS,
    prompt: {
      kind: "write",
      path: "NOTES.md",
      diff: "+++ b/NOTES.md\n+hello",
      truncated: false,
    },
  },
});
if (!start.ok) {
  const upd = await daemon.request({
    type: "chat.tool.update",
    chatId,
    toolCallId,
    toolName: "write",
    status: "awaiting_approval",
    metadata: {
      sdkName: "Write",
      status: "awaiting_approval",
      approvalDeadline: new Date(
        Date.now() + ASK_APPROVAL_TIMEOUT_MS,
      ).toISOString(),
      prompt: {
        kind: "write",
        path: "NOTES.md",
        diff: "+++ b/NOTES.md\n+hello",
        truncated: false,
      },
    },
  });
  if (!upd.ok) fail(upd.error || "could not persist awaiting_approval");
}

const waiter = waitForApproval(toolCallId, chatId, { timeoutMs: 8_000 });
daemon.onPush((msg) => {
  handleToolResolutionPush(msg);
});

const first = await web.request({
  type: "agent.tool.approve",
  chatId,
  toolCallId,
});
if (!first.ok) fail(`first approve should win: ${first.error}`);

const second = await watch.request({
  type: "agent.tool.approve",
  chatId,
  toolCallId,
});
if (second.ok) fail("second approve must fail");
if (!String(second.error || "").includes(ALREADY_RESOLVED_ERROR)) {
  fail(`second error should include ya resuelto, got ${second.error}`);
}
const outcome = await waiter;
if (outcome !== "approve") fail(`daemon waiter got ${outcome}`);
console.log("ok first-wins-ya-resuelto");

console.error(HEADLESS_WAITING);
console.log("ok headless-waiting-log");

daemon.close();
web.close();
watch.close();
console.log("SMOKE PASS");
```

Si `chat.tool.start` ignora `status: "awaiting_approval"` (plan 2 aún no mergeado y el handler fuerza `running`), el smoke hace `chat.tool.update` después. Si **ambos** fallan porque el tipo no existe, el smoke sale con el error del API: hay que tener Task 2 mergeada.

El bind-as-daemon puede chocar con un daemon real (`findDaemon` devuelve el primero). Documentar: correr con `chavez headless workspace close` en ese cwd, o un cwd temporal. Si `agent.tool.approve` falla `Turn already running` / daemon ocupado, imprimir el error y `process.exit(1)` — no silenciar.

- [ ] Correr unitarios + smoke:

```bash
cd cli && bun test src/llm/approval-prompt.test.ts \
  src/llm/approval-deadline.test.ts src/llm/approval-resolve.test.ts \
  src/llm/tool-approval.test.ts src/llm/can-use-tool.approval.test.ts \
  src/llm/handle-tool-resolution.test.ts src/llm/watch-format.test.ts \
  src/llm/headless-no-auto-approve.test.ts \
  src/commands/headless-approval.test.ts
cd api && bun test src/llm/approval-resolve.test.ts
cd web && bun test src/lib/approval-deadline.test.ts src/lib/approval-prompt.test.ts
```

Esperado: todos pasan.

```bash
cd cli && bun run scripts/approvals-smoke.ts
```

Esperado: `SMOKE PASS` y las líneas `ok reads-and-prompt`, `ok waiter-first-wins`, `ok timeout-denies`, `ok first-wins-ya-resuelto`, `ok headless-waiting-log`.

- [ ] Commit:

```bash
git add cli/scripts/approvals-smoke.ts \
  cli/src/llm/headless-no-auto-approve.test.ts
git commit -m "test(approvals): first-wins, timeout, no silent headless write"
```

---

## Orden de ejecución

1. Task 1 (módulos puros) — no depende de API.
2. Task 2 (API CAS) — no depende del runner.
3. Task 3 (daemon/runner) — depende de Task 1; `chat.tool.update` de Task 2 o de agent-tools.
4. Task 4 (CLI watch/approve) — depende de Task 2.
5. Task 5 (TUI) — depende de Tasks 1 y 3 (waiter en-proceso).
6. Task 6 (Web) — depende de Task 2.
7. Task 7 (smoke) — después de 2+3; idealmente al final.

Tasks 4, 5 y 6 son paralelizables entre sí una vez 1–3 están mergeadas.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Cualquier observador puede aprobar; el primero gana; el segundo ve `ya resuelto` | Task 1 `decideResolveGate` / waiter; Task 2 CAS + `chat.tool.resolved`; Task 4 watch y/n + `chat approve`; Task 5 `[y]`/`[n]`; Task 6 botones; Task 7 smoke dos clientes |
| Timeout visible; tool denegada; turn no busy | Task 1 deadline + waiter `"timeout"`; Task 3 `ASK_TIMEOUT_DENIED` + `cancelApprovalsForChat` + `turnBusy = false`; Task 4 línea `timeout in m:ss`; Task 5/6 countdown; Task 7 timeout 30ms |
| Headless no auto-aprueba; espera Web/watch | Task 3 `HEADLESS_WAITING`, daemon sin `resolveApproval("approve")`; Task 4 `stdin: "ignore"` + watch no envía approve al ver el evento; Task 7 grep estático |
| Diff/comando junto a la pregunta | Task 1 `buildApprovalPrompt`; Task 3 metadata `prompt`; Task 4/5/6 pintan path+diff o `$ command` |
| Lecturas no pasan por aquí | Task 1 `buildApprovalPrompt` null; Task 3 `decideCanUseTool` no llama `ask`; Task 5 `firstAwaiting` filtra; Task 6 `isReadTool`; Task 7 smoke |

## Fuera de este plan (no implementar)

- Picker persistente `plan` / `auto` / `ask` → [execution-modes](../execution-modes/plan.md). Esta fase **asume** ask cuando el gate pide confirmación; si el modo ya viaja en el dispatch, se respeta.
- Diffs de turn aplicados / panel de archivos tocados → [diffs-review](../diffs-review/plan.md). Aquí el diff es **material del pedido** (propuesto).
- Cursor ejecutable → [cursor-provider](../cursor-provider/plan.md). Mismo contrato de approval cuando exista.
- Notificaciones in-app genéricas → [notifications](../notifications/plan.md). El banner/countdown de este plan es UI del pedido, no un centro de notificaciones.
- Lote, “siempre permitir”, `updatedPermissions` del SDK → prohibido (decisión 11).
- Notificaciones OS/email → prohibido (decisión 13).
- Cursor cloud, voz, extensión IDE, upload desde el navegador → fuera de alcance (decisión 12).
- Cola de turns → [turn-queue](../turn-queue/plan.md).
- Slash `/mode` → [slash-commands](../slash-commands/plan.md).
- Red en ask → [sandbox-network](../sandbox-network/plan.md).
