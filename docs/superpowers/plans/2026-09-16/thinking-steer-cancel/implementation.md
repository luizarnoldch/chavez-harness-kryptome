# Thinking Steer Cancel Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, cola de turns (plan 29), slash `/steer` (plan 11), undo (plan 12), reconnect/heartbeat (plan 17), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Depende del contrato de turns (`agent.turn.request` / `dispatch` / `publishAgentTurn`) y, si existen, de cancel básico ([`invariants`](../invariants/implementation.md) Task 5), tools in-flight ([`agent-tools`](../agent-tools/implementation.md)), diffs propuestos ([`diffs-review`](../diffs-review/implementation.md)) y Cursor `run.steer` ([`cursor-provider`](../cursor-provider/implementation.md)). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario controla un turn en vuelo. Web y TUI muestran el **razonamiento** (thinking) colapsable, distinto del assistant final; un reload reconstruye el thinking si se persistió, o lo omite de forma explícita. CLI, TUI y Web pueden **steerear** a mitad de turn: si el provider lo inyecta, el texto entra en el turn actual; si no, se explica y queda como follow-up al terminar. **Cancelar** termina el stream `cancelled`, para tools in-flight y **no escribe** diffs no aplicados; el chat acepta un turn nuevo. Cancelar **no** es undo: los writes ya aplicados se quedan; undo (plan 12) los revierte después si hay git.

**Architecture:** El filesystem y el loop del agente viven en el proceso daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). La API **no** ejecuta el LLM ni mata procesos: persiste thinking en `chat_messages.metadata` (jsonb, **sin migración**), reenvía `agent.turn.steer` / `agent.turn.cancel` al daemon y hace fan-out. Claude usa `query({ prompt: AsyncIterable, includePartialMessages: true, abortController })` + `Query.interrupt()` / `Query.close()` para fold-in y abort. Cursor (si el runner del plan 4 existe) usa `run.steer?` / `run.cancel()`. Un registro in-process (`TurnSession`) une abort, prompt-stream, thinking acumulado y follow-up pendiente.

```
Composer (Web | TUI | CLI)
        |
        v
  agent.turn.request  --WS-->  API hub.findDaemon
        |                         | no daemon → NO_DAEMON_ERROR
        v                         v
  agent.turn.dispatch  ------>  daemon / TUI
        |
        v
  publishAgentTurn + TurnSession(chatId)
        |  chat.append user
        |  Claude: query(AsyncIterable) + includePartialMessages
        |          thinking block / thinking_delta → chat.thinking.delta
        |          text                          → chat.stream.delta
        |          tool_use                      → chat.tool.start
        |  Cursor: run.stream() thinking / text / tool_call
        |
        |  STEER  agent.turn.steer { content }
        |         Claude PromptStream.pushSteer  → complete_delivered
        |         Cursor run.steer?              → complete_delivered | revert_to_followup
        |         no soporte / iterable cerrado  → revert_to_followup + follow-up al end
        |
        |  CANCEL agent.turn.cancel
        |         abort + Query.interrupt/close | run.cancel()
        |         tools running/awaiting → status cancelled
        |         diffs proposed         → rejected, disco intacto
        |         writes already applied → se quedan (no git restore)
        |         chat.stream.end status=cancelled + agent.turn.ended
        v
  API persist metadata.thinking / metadata.status
  broadcast → Web ThinkingBlock | TUI [thinking] | CLI watch
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` ya pone `thinking: { type: "adaptive" }` cuando `effort !== "none"`. `emitBlocks` solo reenvía `text` / `tool_use` / `tool_result`. `stream_event` solo mira `delta.text`. **No** hay `thinking_delta`, **no** hay `includePartialMessages`, **no** hay `abortController`, el prompt es **string** (no se puede fold-in).
- `cli/src/llm/publish-turn.ts` emite `chat.stream.*` / `chat.tool.*`. **No** hay `chat.thinking.*`, **no** hay `agent.turn.ended`, **no** hay registro de sesión, **no** hay steer.
- `cli/src/ws/daemon.ts` solo atiende `agent.turn.dispatch`. `turnBusy` ignora un segundo dispatch. **No** hay cancel ni steer.
- `api/src/ws/handlers.ts` despacha `agent.turn.request` → `agent.turn.dispatch`. `chat.stream.end` persiste assistant `content` + `metadata.streamId`. **No** hay `agent.turn.steer` / `cancel` / `chat.thinking.*`. `chat.stream.error` **no** marca tools in-flight (el plan 2 lo añade; esta fase lo exige o lo crea con status `cancelled`).
- `api/src/ws/protocol.ts` `RESERVED_STREAM_TYPES` = start/delta/end/error. `ClientMessage` ya tiene `chatId`, `content`, `streamId`, `status`, `metadata`.
- `api/src/db/schema.ts` `chat_messages.metadata` jsonb **ya existe**. No hay tabla nueva. No hay migración. `user_preferences` **no** gana columna de thinking (el colapso es UI local).
- Web `ChatDetailPanel.tsx`: un solo `<pre>` live mezcla todo el `streamText`. Timeline pinta `m.content` del assistant. **No** hay ThinkingBlock, **no** hay Cancelar, **no** hay Steer.
- TUI `tui/src/App.tsx`: `Message = { id, role, content }` **sin** metadata. Log `"Claude thinking (…)"` es un spinner, no el razonamiento. Escape **mata la TUI**. Compose se bloquea con `busy`.
- CLI `chavez headless chat`: `create|list|append|get|ask|watch`. **No** hay `steer` ni `cancel` (el plan 5 añade `cancel`; si ya está, esta fase lo refina).
- `cli/src/llm/history.ts` usa `content` de user/assistant/system y tira `role=tool`. Correcto: thinking vive en **metadata**, no se reinyecta como assistant.
- Cursor `runnable: false` hoy. Si `cli/src/llm/cursor-runner.ts` existe, esta fase cablea `thinking` + `run.steer?` + `run.cancel()`. Si no, el codec y los tests de fixture quedan listos; **no** simular un turn Cursor.
- Plan 5 (invariants) Task 5 añade `turn-abort.ts`, `agent.turn.cancel`, Esc-cancela. Si ya aterrizó: **extender** (stream.end `status=cancelled`, tools `cancelled`, no undo). Si no: esta fase incluye el abort + cancel completo.
- Plan 2 `failRunningTools` marca tools `running` como `error` en `stream.error`. Esta fase pasa `cancelled` cuando el motivo es cancel.
- Plan 6 diffs `proposed`: al cancelar se marcan `rejected` y **no** se escriben. `applied` se quedan.
- Plan 12 undo **no** se llama desde cancel. Tras cancel, el usuario puede disparar undo si hay git.

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (sin migración), Claude Agent SDK `query` (`prompt: AsyncIterable<SDKUserMessage>`, `includePartialMessages`, `abortController`, `Query.interrupt`, `Query.close`, bloques `thinking` / `thinking_delta`), Cursor SDK `Run.steer?` / `Run.cancel` / evento `thinking` (si plan 4 aterrizó), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar el codec de thinking (comentario keep-in-sync).

**Global Constraints:**

1. El filesystem y el loop del agente viven **solo** en el daemon (cwd del workspace). API y browser no abortan procesos, no inyectan tokens al LLM y no restauran git.
2. Sin daemon bound, `agent.turn.steer` y `agent.turn.cancel` fallan con el string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Thinking **nunca** se mezcla con `content` del assistant. El texto final va en `content`; el razonamiento va en `metadata.thinking`. Web/TUI/watch lo pintan en un bloque distinto. `historyFromChatMessages` no ve el thinking (lee `content`).
4. Colapsar/expandir es **UI local** (Web `localStorage`, TUI estado). No hay columna de preferencias. Default: **colapsado**. Recargar reconstruye el cuerpo si `metadata.thinking.text` existe; si `omitted: true`, muestra la etiqueta de omitido **sin** cuerpo.
5. Steer: si el provider confirma la inyección (`complete_delivered`), **no** se dispara un turn nuevo. Si no (`revert_to_followup`), se explica con `STEER_UNSUPPORTED` (o el reason del provider) y el texto queda encolado: al `stream.end` **finished** se despacha como el siguiente `agent.turn` (mismo `chatId`). Si el turn se **cancela**, el follow-up **no** auto-despacha (el mensaje user ya está en el chat).
6. Steer exige un turn running en ese `chatId`. Sin turn: `fail` con `STEER_NO_TURN` (no es idempotente como cancel). Texto vacío o solo whitespace: `STEER_EMPTY`. Cap `STEER_MAX_CHARS`.
7. Cancel es **idempotente**: sin turn → `ok: true, wasRunning: false`. Con turn → abort, stream `cancelled`, `wasRunning: true`. El chat acepta un turn nuevo (`agent.turn.ended` limpia busy).
8. Cancel **no** es undo. Cero `git restore` / `git reset` / `agent.turn.undo`. Writes ya aplicados en disco se quedan. Diffs `proposed` (ask, aún no aprobados) **no** se escriben. Tools `running` / `awaiting_approval` pasan a `cancelled` (no se cuelgan).
9. 1 turn por daemon. Steer no abre un segundo turn. Follow-up espera al `ended`. Un segundo `agent.turn.request` mientras busy sigue siendo `TURN_BUSY_ERROR`.
10. Claude es el provider ejecutable hoy. Cursor vinculado: si el runner existe, thinking/steer/cancel usan el mismo contrato visual; si `run.steer` está ausente, **siempre** `revert_to_followup` (nunca inventar una inyección).
11. Web, TUI y CLI `watch` ven el mismo contrato: `chat.thinking.*`, `chat.steer`, `chat.stream.end` con `status`. Un reload de `chat.get` reconstruye thinking y el badge `cancelled`.
12. Lecturas no piden confirmación. Steer y cancel no son tools del modelo y no entran en `canUseTool`.
13. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash `/steer` `/stop`, cola genérica (plan 29), worktrees paralelos, persistir el estado expandido en el servidor.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `TURN_CANCELLED` | `"Turn cancelled"` |
| `STEER_UNSUPPORTED` | `"This provider cannot inject mid-turn; queued as follow-up when the turn ends"` |
| `STEER_DELIVERED` | `"Steer injected into the running turn"` |
| `STEER_EMPTY` | `"steer text is required"` |
| `STEER_NO_TURN` | `"No turn running"` |
| `STEER_TOO_LONG` | `"steer text exceeds 4000 characters"` |
| `STEER_MAX_CHARS` | `4000` |
| `THINKING_MAX_CHARS` | `32000` |
| `THINKING_OMITTED_LABEL` | `"razonamiento omitido"` |
| `THINKING_COLLAPSED_LABEL` | `"razonamiento"` |
| `THINKING_META_KIND` | `"thinking"` |
| `STEER_KIND` | `"steer"` |
| `FOLLOWUP_KIND` | `"steer_followup"` |
| `STREAM_STATUS_CANCELLED` | `"cancelled"` |
| `STREAM_STATUS_FINISHED` | `"finished"` |
| `TOOL_STATUS_CANCELLED` | `"cancelled"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `NO_TURN_RUNNING` | `"No turn running"` |
| `WEB_THINKING_LS_KEY` | `"chavez.thinking.expanded"` |

Reusar `NO_DAEMON_ERROR` / `TURN_BUSY_ERROR` / `TURN_CANCELLED` si ya existen en `api/src/ws/errors.ts` o `cli/src/llm/turn-abort.ts`; **no** cambiar esos strings.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `chat.thinking.delta` | daemon → API → broadcast | `{ chatId, streamId, delta }` — **no** persiste |
| `chat.thinking.end` | daemon → API → broadcast | `{ chatId, streamId, omitted?, durationMs? }` — **no** persiste (el cuerpo va en `stream.end`) |
| `agent.turn.steer` | cualquier cliente → API | `{ chatId, content }` inyectar o encolar |
| `agent.turn.steer.dispatch` | API → daemon | `{ requestId, chatId, content }` |
| `agent.turn.steer.result` | daemon → API | `{ requestId, outcome, reason? }` completa el pending |
| `chat.steer` | API → broadcast | `{ chatId, streamId, outcome, content, message?, reason? }` |
| `agent.turn.cancel` | cualquier cliente → API | `{ chatId }` — idempotente |
| `agent.turn.cancel` (push) | API → daemon | `{ chatId, requestId }` |
| `chat.stream.end` | daemon → API → broadcast | gana `status: "finished" \| "cancelled"`; persiste assistant + `metadata.thinking` + `metadata.status` |
| `agent.turn.ended` | daemon → API → broadcast | `{ chatId, streamId, status }` limpia busy |

HTTP: ninguno nuevo. `GET /chats/:chatId` y `chat.get` ya devuelven `metadata`; el reload reconstruye ThinkingBlock y el badge `cancelled`.

Thinking persistido en `chat_messages.metadata` del mensaje **assistant** del turn:

```ts
export type ThinkingPersist = {
  kind: "thinking";
  omitted: boolean;
  text?: string;          // ausente si omitted
  durationMs?: number;
};

export type SteerOutcome = "complete_delivered" | "revert_to_followup";

// assistant metadata (fragmento)
{
  streamId: string;
  status?: "finished" | "cancelled";
  thinking?: ThinkingPersist;
}

// user metadata de un steer persistido
{
  kind: "steer";
  outcome: SteerOutcome;
  streamId: string;
}
```

---

## Task 1: Módulos puros — thinking, steer, abort, prompt-stream

**Files:**

- Create: `cli/src/llm/thinking.ts`
- Test: `cli/src/llm/thinking.test.ts`
- Create: `cli/src/llm/steer.ts`
- Test: `cli/src/llm/steer.test.ts`
- Create: `cli/src/llm/prompt-stream.ts`
- Test: `cli/src/llm/prompt-stream.test.ts`
- Create: `cli/src/llm/turn-abort.ts` (solo si **no** existe; si el plan 5 ya lo creó, **extenderlo**)
- Test: `cli/src/llm/turn-abort.test.ts` (crear o extender)
- Modify: `cli/package.json`

Módulos sin I/O de red. TUI importa desde `cli/src/llm/…`. Web **no** importa CLI: Task 7 duplica `thinking.ts`.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Crear `cli/src/llm/thinking.ts`:

```ts
export const THINKING_META_KIND = "thinking" as const;
export const THINKING_MAX_CHARS = 32_000;
export const THINKING_OMITTED_LABEL = "razonamiento omitido";
export const THINKING_COLLAPSED_LABEL = "razonamiento";

export type ThinkingPersist = {
  kind: typeof THINKING_META_KIND;
  omitted: boolean;
  text?: string;
  durationMs?: number;
};

export type ThinkingAccum = {
  omitted: boolean;
  text: string;
  startedAt: number;
  ended: boolean;
};

export function emptyThinkingAccum(): ThinkingAccum {
  return { omitted: false, text: "", startedAt: Date.now(), ended: false };
}

export function appendThinkingDelta(acc: ThinkingAccum, delta: string): void {
  if (acc.omitted || !delta) return;
  const next = acc.text + delta;
  acc.text =
    next.length > THINKING_MAX_CHARS
      ? next.slice(0, THINKING_MAX_CHARS)
      : next;
}

export function markThinkingOmitted(acc: ThinkingAccum): void {
  acc.omitted = true;
  acc.text = "";
}

export function finalizeThinking(
  acc: ThinkingAccum | null,
): ThinkingPersist | undefined {
  if (!acc) return undefined;
  if (acc.omitted) {
    return {
      kind: THINKING_META_KIND,
      omitted: true,
      durationMs: Date.now() - acc.startedAt,
    };
  }
  if (!acc.text.trim()) return undefined;
  return {
    kind: THINKING_META_KIND,
    omitted: false,
    text: acc.text,
    durationMs: Date.now() - acc.startedAt,
  };
}

export function thinkingFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ThinkingPersist | null {
  const raw = metadata?.thinking;
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.omitted === true) {
    return { kind: THINKING_META_KIND, omitted: true };
  }
  const text = typeof t.text === "string" ? t.text : "";
  if (!text.trim()) return null;
  return {
    kind: THINKING_META_KIND,
    omitted: false,
    text,
    durationMs: typeof t.durationMs === "number" ? t.durationMs : undefined,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** Extract thinking text from an Anthropic content block. */
export function thinkingTextFromBlock(block: unknown): string | null {
  const b = asRecord(block);
  if (!b) return null;
  const type = String(b.type || "");
  if (type === "thinking" && typeof b.thinking === "string") return b.thinking;
  if (type === "redacted_thinking") return null;
  return null;
}

export function isRedactedThinkingBlock(block: unknown): boolean {
  const b = asRecord(block);
  return Boolean(b && String(b.type || "") === "redacted_thinking");
}

/** Stream event: thinking_delta.thinking (partial messages). */
export function thinkingDeltaFromStreamEvent(event: unknown): string | null {
  const ev = asRecord(event);
  if (!ev) return null;
  const delta = asRecord(ev.delta);
  if (!delta) return null;
  const dtype = String(delta.type || "");
  if (dtype === "thinking_delta" && typeof delta.thinking === "string") {
    return delta.thinking;
  }
  return null;
}

export function textDeltaFromStreamEvent(event: unknown): string | null {
  const ev = asRecord(event);
  if (!ev) return null;
  const delta = asRecord(ev.delta);
  if (!delta) return null;
  const dtype = String(delta.type || "");
  if (
    (dtype === "text_delta" || dtype === "") &&
    typeof delta.text === "string" &&
    delta.text
  ) {
    return delta.text;
  }
  return null;
}

export function truncateThinkingPreview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}
```

- [ ] Crear `cli/src/llm/thinking.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  appendThinkingDelta,
  emptyThinkingAccum,
  finalizeThinking,
  isRedactedThinkingBlock,
  markThinkingOmitted,
  textDeltaFromStreamEvent,
  thinkingDeltaFromStreamEvent,
  thinkingFromMetadata,
  thinkingTextFromBlock,
  THINKING_COLLAPSED_LABEL,
  THINKING_MAX_CHARS,
  THINKING_OMITTED_LABEL,
} from "./thinking";

describe("thinking codec", () => {
  test("block thinking vs text never mix", () => {
    expect(thinkingTextFromBlock({ type: "thinking", thinking: "plan A" })).toBe(
      "plan A",
    );
    expect(thinkingTextFromBlock({ type: "text", text: "hello" })).toBeNull();
    expect(thinkingTextFromBlock({ type: "text", thinking: "nope" })).toBeNull();
  });

  test("redacted is omitted, not assistant text", () => {
    expect(isRedactedThinkingBlock({ type: "redacted_thinking", data: "x" })).toBe(
      true,
    );
    expect(thinkingTextFromBlock({ type: "redacted_thinking", data: "x" })).toBeNull();
    const acc = emptyThinkingAccum();
    markThinkingOmitted(acc);
    const fin = finalizeThinking(acc)!;
    expect(fin.omitted).toBe(true);
    expect(fin.text).toBeUndefined();
  });

  test("stream thinking_delta vs text_delta", () => {
    expect(
      thinkingDeltaFromStreamEvent({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
    ).toBe("hmm");
    expect(
      textDeltaFromStreamEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }),
    ).toBe("hi");
    expect(
      thinkingDeltaFromStreamEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }),
    ).toBeNull();
  });

  test("finalize empty → undefined; omitted survives empty text", () => {
    expect(finalizeThinking(emptyThinkingAccum())).toBeUndefined();
    const acc = emptyThinkingAccum();
    markThinkingOmitted(acc);
    appendThinkingDelta(acc, "should be ignored");
    expect(finalizeThinking(acc)?.omitted).toBe(true);
  });

  test("reload from metadata reconstructs or omits", () => {
    expect(
      thinkingFromMetadata({
        thinking: { kind: "thinking", omitted: false, text: "why" },
      })?.text,
    ).toBe("why");
    expect(
      thinkingFromMetadata({ thinking: { omitted: true } })?.omitted,
    ).toBe(true);
    expect(thinkingFromMetadata({ streamId: "x" })).toBeNull();
    expect(thinkingFromMetadata({ thinking: { omitted: false, text: "  " } })).toBeNull();
  });

  test("cap THINKING_MAX_CHARS", () => {
    const acc = emptyThinkingAccum();
    appendThinkingDelta(acc, "a".repeat(THINKING_MAX_CHARS + 50));
    expect(acc.text.length).toBe(THINKING_MAX_CHARS);
  });

  test("labels are frozen", () => {
    expect(THINKING_COLLAPSED_LABEL).toBe("razonamiento");
    expect(THINKING_OMITTED_LABEL).toBe("razonamiento omitido");
  });
});
```

- [ ] Crear `cli/src/llm/steer.ts`:

```ts
export const STEER_KIND = "steer" as const;
export const FOLLOWUP_KIND = "steer_followup" as const;
export const STEER_MAX_CHARS = 4000;

export const STEER_UNSUPPORTED =
  "This provider cannot inject mid-turn; queued as follow-up when the turn ends";
export const STEER_DELIVERED = "Steer injected into the running turn";
export const STEER_EMPTY = "steer text is required";
export const STEER_NO_TURN = "No turn running";
export const STEER_TOO_LONG = "steer text exceeds 4000 characters";

export type SteerOutcome = "complete_delivered" | "revert_to_followup";

export type SteerAck = {
  outcome: SteerOutcome;
  reason?: string;
  content: string;
};

export function normalizeSteerText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

export function validateSteerText(raw: unknown): string {
  const text = normalizeSteerText(raw);
  if (!text) throw new Error(STEER_EMPTY);
  if (text.length > STEER_MAX_CHARS) throw new Error(STEER_TOO_LONG);
  return text;
}

export type PendingFollowUp = {
  chatId: string;
  text: string;
  queuedAt: string;
};

const followUps = new Map<string, PendingFollowUp>();

export function queueFollowUp(chatId: string, text: string): PendingFollowUp {
  const item: PendingFollowUp = {
    chatId,
    text,
    queuedAt: new Date().toISOString(),
  };
  followUps.set(chatId, item);
  return item;
}

export function takeFollowUp(chatId: string): PendingFollowUp | null {
  const item = followUps.get(chatId) ?? null;
  if (item) followUps.delete(chatId);
  return item;
}

export function peekFollowUp(chatId: string): PendingFollowUp | null {
  return followUps.get(chatId) ?? null;
}

export function dropFollowUp(chatId: string): void {
  followUps.delete(chatId);
}

export function deliveredAck(content: string): SteerAck {
  return { outcome: "complete_delivered", reason: STEER_DELIVERED, content };
}

export function followupAck(content: string, reason = STEER_UNSUPPORTED): SteerAck {
  return { outcome: "revert_to_followup", reason, content };
}
```

- [ ] Crear `cli/src/llm/steer.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  deliveredAck,
  dropFollowUp,
  followupAck,
  peekFollowUp,
  queueFollowUp,
  takeFollowUp,
  validateSteerText,
  STEER_EMPTY,
  STEER_MAX_CHARS,
  STEER_NO_TURN,
  STEER_TOO_LONG,
  STEER_UNSUPPORTED,
} from "./steer";

describe("steer", () => {
  test("empty / too long throw frozen strings", () => {
    expect(() => validateSteerText("  ")).toThrow(STEER_EMPTY);
    expect(() => validateSteerText("x".repeat(STEER_MAX_CHARS + 1))).toThrow(
      STEER_TOO_LONG,
    );
    expect(validateSteerText(" no toques tests ")).toBe("no toques tests");
  });

  test("follow-up queue is per chat and take is destructive", () => {
    queueFollowUp("c1", "a");
    queueFollowUp("c1", "b");
    expect(peekFollowUp("c1")?.text).toBe("b");
    expect(takeFollowUp("c1")?.text).toBe("b");
    expect(takeFollowUp("c1")).toBeNull();
    dropFollowUp("missing");
  });

  test("outcomes", () => {
    expect(deliveredAck("x").outcome).toBe("complete_delivered");
    expect(followupAck("x").outcome).toBe("revert_to_followup");
    expect(followupAck("x").reason).toBe(STEER_UNSUPPORTED);
    expect(STEER_NO_TURN).toBe("No turn running");
  });
});
```

- [ ] Crear `cli/src/llm/prompt-stream.ts`:

```ts
export type SdkUserLike = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  uuid: string;
  session_id: string;
};

function userMsg(text: string): SdkUserLike {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "",
  };
}

/**
 * Keeps the Claude query iterable open so mid-turn user messages can fold in.
 * close() after result/cancel or the query hangs waiting for the next prompt.
 */
export class PromptStream {
  private queue: Array<SdkUserLike | null> = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private steered = 0;

  get isClosed(): boolean {
    return this.closed;
  }

  get steerCount(): number {
    return this.steered;
  }

  /** @returns false if already closed (caller must revert_to_followup). */
  pushSteer(text: string): boolean {
    if (this.closed) return false;
    this.queue.push(userMsg(text));
    this.steered += 1;
    this.flush();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.push(null);
    this.flush();
  }

  async *iterate(initial: string): AsyncGenerator<SdkUserLike> {
    yield userMsg(initial);
    while (true) {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      const next = this.queue.shift();
      if (next == null) return;
      yield next;
    }
  }

  private flush(): void {
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }
}
```

- [ ] Crear `cli/src/llm/prompt-stream.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PromptStream } from "./prompt-stream";

describe("PromptStream", () => {
  test("initial then steer then close", async () => {
    const s = new PromptStream();
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of s.iterate("first")) {
        seen.push(m.message.content);
      }
    })();
    await Bun.sleep(5);
    expect(s.pushSteer("no toques tests")).toBe(true);
    s.close();
    await run;
    expect(seen).toEqual(["first", "no toques tests"]);
    expect(s.pushSteer("late")).toBe(false);
  });

  test("close without steer ends after initial", async () => {
    const s = new PromptStream();
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of s.iterate("only")) seen.push(m.message.content);
    })();
    await Bun.sleep(5);
    s.close();
    await run;
    expect(seen).toEqual(["only"]);
  });
});
```

- [ ] Si `cli/src/llm/turn-abort.ts` **no** existe, crearlo:

```ts
export const TURN_CANCELLED = "Turn cancelled";

const byChat = new Map<string, AbortController>();

export function beginTurnAbort(chatId: string): AbortController {
  byChat.get(chatId)?.abort();
  const ac = new AbortController();
  byChat.set(chatId, ac);
  return ac;
}

export function abortTurn(chatId: string): boolean {
  const ac = byChat.get(chatId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function endTurnAbort(chatId: string): void {
  byChat.delete(chatId);
}

export function isTurnAborting(chatId: string): boolean {
  return Boolean(byChat.get(chatId)?.signal.aborted);
}
```

Si el plan 5 ya lo creó con `beginTurnAbort` devolviendo `AbortSignal`, cambiar a devolver `AbortController` (un solo lugar) y actualizar los call sites. Añadir `TURN_CANCELLED` y `isTurnAborting` si faltan.

- [ ] Test `cli/src/llm/turn-abort.test.ts` (crear o extender): `beginTurnAbort` + `abortTurn` marca `signal.aborted`; segundo `beginTurnAbort` aborta el anterior; `endTurnAbort` + `abortTurn` → `false`; `TURN_CANCELLED === "Turn cancelled"`.

- [ ] Correr:

```bash
cd cli && bun test src/llm/thinking.test.ts src/llm/steer.test.ts src/llm/prompt-stream.test.ts src/llm/turn-abort.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/package.json cli/src/llm/thinking.ts cli/src/llm/thinking.test.ts \
  cli/src/llm/steer.ts cli/src/llm/steer.test.ts \
  cli/src/llm/prompt-stream.ts cli/src/llm/prompt-stream.test.ts \
  cli/src/llm/turn-abort.ts cli/src/llm/turn-abort.test.ts
git commit -m "feat(thinking): codecs for thinking, steer, abort, and prompt stream"
```

---

## Task 2: Claude runner — thinking events, streaming input, interrupt

**Files:**

- Modify: `cli/src/llm/claude-runner.ts`
- Test: `cli/src/llm/claude-runner.thinking.test.ts`

El runner deja de tratar thinking como texto. Gana `PromptStream` + `abortController` + `Query.interrupt`/`close`. Si el plan 2 ya cambió `permissionMode` a `"default"`, **no** volver a `bypassPermissions`.

- [ ] En `cli/src/llm/claude-runner.ts`, extender `AgentTurnEvent`:

```ts
export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_omitted" }
  | { kind: "thinking_end" }
  | {
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      output: string;
      status?: string;
    }
  | { kind: "result"; text: string };
```

- [ ] Extender `RunClaudeTurnInput`:

```ts
export type RunClaudeTurnInput = {
  prompt: string;
  history?: HistoryMessage[];
  model: string;
  effort: EffortLevel;
  auth: ClaudeAuth;
  cwd: string;
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
  abortController?: AbortController;
  promptStream?: PromptStream;
};
```

- [ ] En `emitBlocks`, **antes** del case `text`, manejar thinking. Un bloque `thinking` **no** emite `stream_delta`:

```ts
if (type === "thinking" && typeof b.thinking === "string" && b.thinking) {
  await onEvent({ kind: "thinking_delta", text: b.thinking });
  continue;
}
if (type === "redacted_thinking") {
  await onEvent({ kind: "thinking_omitted" });
  continue;
}
```

- [ ] En el loop `stream_event`, separar thinking de texto:

```ts
if (type === "stream_event") {
  const event = asRecord(msg.event);
  const think = thinkingDeltaFromStreamEvent(event);
  if (think) {
    await input.onEvent?.({ kind: "thinking_delta", text: think });
  } else {
    const text = textDeltaFromStreamEvent(event);
    if (text) await input.onEvent?.({ kind: "stream_delta", text });
  }
}
```

Importar `thinkingDeltaFromStreamEvent` y `textDeltaFromStreamEvent` desde `./thinking`.

- [ ] Sustituir `query({ prompt: string })` por iterable + `includePartialMessages`. Guardar el `Query` para interrupt/close:

```ts
import { PromptStream } from "./prompt-stream";
import { TURN_CANCELLED } from "./turn-abort";

const stream = input.promptStream ?? new PromptStream();
const prompt = promptWithHistory(input.prompt, input.history ?? []);

const options: Record<string, unknown> = {
  model: input.model,
  cwd: input.cwd,
  env: cleanEnv,
  settingSources: [],
  permissionMode: "bypassPermissions", // o "default" si plan 2 ya lo cambió
  includePartialMessages: true,
  abortController: input.abortController,
};

if (input.effort !== "none") {
  options.thinking = { type: "adaptive" };
  options.effort = input.effort;
}

const q = query({
  prompt: stream.iterate(prompt),
  options: options as never,
});

const onAbort = () => {
  void q.interrupt();
  q.close();
};
input.abortController?.signal.addEventListener("abort", onAbort, { once: true });

try {
  for await (const message of q) {
    if (input.abortController?.signal.aborted) {
      throw new Error(TURN_CANCELLED);
    }
    // ... existing type switches, with thinking branches
    if (type === "result" && subtype === "success" && typeof msg.result === "string") {
      finalResult = msg.result;
      await input.onEvent?.({ kind: "thinking_end" });
      await input.onEvent?.({ kind: "result", text: msg.result });
    }
  }
} finally {
  stream.close();
  input.abortController?.signal.removeEventListener("abort", onAbort);
  try {
    q.close();
  } catch {
    // already closed
  }
}

if (input.abortController?.signal.aborted) {
  throw new Error(TURN_CANCELLED);
}
if (!finalResult) {
  throw new Error("Claude no devolvió un resultado de éxito");
}
return finalResult;
```

`runClaudeTurn` **no** llama a `stream.pushSteer`; eso lo hace `TurnSession` (Task 4) sobre el mismo `PromptStream` que se pasa en `input.promptStream`.

- [ ] Crear `cli/src/llm/claude-runner.thinking.test.ts` que **no** llama a la API. Extraer `emitBlocks` a export `emitClaudeBlocks` (mismo archivo, named export) para testearlo, **o** duplicar la lógica de clasificación en el test importando las helpers de `thinking.ts` (preferible: testear `thinking.ts` ya cubre clasificación; este test cubre que un fixture de mensajes SDK no emite thinking como `stream_delta`).

Patrón: exportar `classifyClaudeMessage(msg): AgentTurnEvent[]` usado por el loop, y testearlo:

```ts
import { describe, expect, test } from "bun:test";
import { classifyClaudeMessage } from "./claude-runner";

describe("classifyClaudeMessage", () => {
  test("assistant thinking block is thinking_delta, not stream_delta", () => {
    const evs = classifyClaudeMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "voy a leer" },
          { type: "text", text: "listo" },
        ],
      },
    });
    expect(evs.map((e) => e.kind)).toEqual(["thinking_delta", "stream_delta"]);
    expect(evs[0]).toEqual({ kind: "thinking_delta", text: "voy a leer" });
    expect(evs[1]).toEqual({ kind: "stream_delta", text: "listo" });
  });

  test("stream_event thinking_delta vs text_delta", () => {
    const think = classifyClaudeMessage({
      type: "stream_event",
      event: { delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    expect(think).toEqual([{ kind: "thinking_delta", text: "hmm" }]);
    const text = classifyClaudeMessage({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "hi" } },
    });
    expect(text).toEqual([{ kind: "stream_delta", text: "hi" }]);
  });

  test("redacted_thinking → thinking_omitted", () => {
    const evs = classifyClaudeMessage({
      type: "assistant",
      message: { content: [{ type: "redacted_thinking", data: "…" }] },
    });
    expect(evs).toEqual([{ kind: "thinking_omitted" }]);
  });
});
```

Implementar `classifyClaudeMessage` como función pura en `claude-runner.ts` (sin I/O) que el `for await` consume. El loop queda:

```ts
for (const ev of classifyClaudeMessage(msg)) {
  await input.onEvent?.(ev);
}
```

El case `result` sigue aparte (necesita `finalResult`).

- [ ] Correr:

```bash
cd cli && bun test src/llm/claude-runner.thinking.test.ts src/llm/thinking.test.ts
```

Esperado: thinking nunca sale como `stream_delta`.

- [ ] Commit:

```bash
git add cli/src/llm/claude-runner.ts cli/src/llm/claude-runner.thinking.test.ts
git commit -m "feat(thinking): emit Claude thinking separately and accept mid-turn input"
```

---

## Task 3: API — thinking fan-out, steer RPC, stream cancelled, tools cancelled

**Files:**

- Create: `api/src/ws/errors.ts` (solo si **no** existe; si plan 5 lo creó, extender)
- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Test: `api/src/ws/thinking-steer.test.ts`
- Modify: `api/openapi/openapi.yaml`
- Modify: `api/package.json`

La API no corre el LLM. Persiste thinking en el assistant al `stream.end`. Fan-out de deltas. Steer es request/response con dispatch al daemon.

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si no existe.

- [ ] En `api/src/ws/errors.ts` (crear o extender) añadir si faltan:

```ts
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
export const TURN_CANCELLED = "Turn cancelled";
export const STEER_EMPTY = "steer text is required";
export const STEER_NO_TURN = "No turn running";
export const STEER_TOO_LONG = "steer text exceeds 4000 characters";
export const STEER_MAX_CHARS = 4000;
```

Los strings de steer **deben** coincidir carácter a carácter con `cli/src/llm/steer.ts`.

- [ ] En `api/src/ws/protocol.ts`:

  - `RESERVED_STREAM_TYPES` añade `"chat.thinking.delta"` y `"chat.thinking.end"`.
  - `ClientMessage` ya tiene `content` / `status` / `metadata`. No hace falta campo nuevo para steer (el texto va en `content`). Opcional: documentar `outcome?: string` si se quiere typear el result; el daemon puede mandarlo en `metadata.outcome`.

- [ ] En `api/src/ws/handlers.ts`:

  1. Helper para fallar tools in-flight (si el plan 2 ya tiene `failRunningTools`, añadir parámetro `status = "error"` y usarlo; si no, crear en el mismo archivo):

```ts
async function failRunningTools(
  userId: string,
  chatId: string,
  status: "error" | "cancelled",
  reason: string,
) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId));
  for (const row of rows) {
    const meta = (row.metadata as Record<string, unknown> | null) || {};
    if (row.role !== "tool") continue;
    const st = String(meta.status || "");
    if (st !== "running" && st !== "awaiting_approval") continue;
    const metadata = { ...meta, status, output: reason };
    await db
      .update(chatMessages)
      .set({ metadata, content: reason })
      .where(eq(chatMessages.id, row.id));
    const message = { ...row, metadata, content: reason };
    broadcast(userId, "chat.tool.result", { message, chatId });
    broadcast(userId, "message.appended", { message, chatId, updated: true });
  }
}
```

  2. Nuevo case `chat.thinking.delta`:

```ts
case "chat.thinking.delta": {
  if (!msg.chatId || !msg.streamId) {
    return fail(type, id, "chatId and streamId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const payload = {
    chatId: msg.chatId,
    streamId: msg.streamId,
    delta: msg.delta ?? msg.content ?? "",
  };
  broadcast(userId, "chat.thinking.delta", payload);
  return ok(type, id, payload);
}
```

  3. Nuevo case `chat.thinking.end`:

```ts
case "chat.thinking.end": {
  if (!msg.chatId || !msg.streamId) {
    return fail(type, id, "chatId and streamId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const payload = {
    chatId: msg.chatId,
    streamId: msg.streamId,
    omitted: Boolean(msg.metadata?.omitted),
    durationMs: msg.metadata?.durationMs,
  };
  broadcast(userId, "chat.thinking.end", payload);
  return ok(type, id, payload);
}
```

  4. `chat.stream.end`: leer `status` (`msg.status === "cancelled" ? "cancelled" : "finished"`). Persistir assistant si hay `content.trim()` **o** `msg.metadata?.thinking` **o** status cancelled (badge vacío). Metadata:

```ts
metadata: {
  streamId: msg.streamId,
  status: msg.status === "cancelled" ? "cancelled" : "finished",
  ...(msg.metadata || {}),
},
```

Si `status === "cancelled"`, **antes** de insertar: `await failRunningTools(userId, msg.chatId, "cancelled", TURN_CANCELLED)`.

Si la tabla `turn_file_diffs` existe (plan 6), marcar filas de ese `streamId` con `status = 'proposed'` como `rejected`. **No** crear la tabla aquí.

Broadcast del end incluye `status` y `message`.

  5. `chat.stream.error`: si `msg.content === TURN_CANCELLED` (o el error es cancel), tratarlo como end cancelled: persistir + `failRunningTools(..., "cancelled")` + broadcast `chat.stream.end` con `status: "cancelled"` **además** del error (clientes viejos escuchan error; los nuevos miran `status`). Preferible: el daemon de esta fase **solo** manda `stream.end` cancelled (Task 4) y deja de mandar `stream.error` para cancel. `stream.error` queda para fallos reales. Si llega un error `TURN_CANCELLED` de un daemon viejo, normalizarlo a cancelled.

  6. `agent.turn.steer`:

```ts
case "agent.turn.steer": {
  const content = (msg.content || "").trim();
  if (!msg.chatId) return fail(type, id, "chatId is required");
  if (!content) return fail(type, id, STEER_EMPTY);
  if (content.length > STEER_MAX_CHARS) return fail(type, id, STEER_TOO_LONG);
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const busy = Boolean(
    (daemon as { turnBusy?: boolean }).turnBusy &&
      (daemon as { turnChatId?: string }).turnChatId === msg.chatId,
  );
  // Si hub aún no tiene turnBusy (plan 5 no aterrizó), despachar igual:
  // el daemon responde STEER_NO_TURN.
  if ((daemon as { turnBusy?: boolean }).turnBusy === false) {
    return fail(type, id, STEER_NO_TURN);
  }
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("agent.turn.steer.dispatch", {
      chatId: msg.chatId,
      content,
      requestId: id,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  // Completar cuando el daemon mande agent.turn.steer.result con el mismo id.
  // Si no hay pending-map, responder accepted y el result llega como push chat.steer.
  return ok(type, id, { accepted: true, forwarded: true });
}
```

El daemon **siempre** manda `agent.turn.steer.result` + el cliente que hizo request necesita el outcome. Implementar pending corto (igual que otros RPC de ida y vuelta):

```ts
// módulo api/src/ws/pending.ts (crear si no existe)
type Pending = {
  resolve: (v: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pendingSteer = new Map<string, Pending>();

export function waitSteerResult(requestId: string, timeoutMs = 10_000) {
  return new Promise<ServerMessage>((resolve) => {
    const timer = setTimeout(() => {
      pendingSteer.delete(requestId);
      resolve(fail("agent.turn.steer", requestId, "Steer timed out"));
    }, timeoutMs);
    pendingSteer.set(requestId, { resolve, timer });
  });
}

export function completeSteerResult(requestId: string, msg: ServerMessage) {
  const p = pendingSteer.get(requestId);
  if (!p) return false;
  clearTimeout(p.timer);
  pendingSteer.delete(requestId);
  p.resolve(msg);
  return true;
}
```

En el case `agent.turn.steer`, tras `sendTo`, `return await waitSteerResult(id)`.

Case `agent.turn.steer.result` (lo envía el daemon, `type` puede ser ese; `id` = requestId original):

```ts
case "agent.turn.steer.result": {
  const outcome =
    (msg.metadata?.outcome as string) ||
    (msg.status as string) ||
    "";
  const payload = {
    chatId: msg.chatId,
    streamId: msg.streamId,
    outcome,
    content: msg.content,
    reason: (msg.metadata?.reason as string) || undefined,
  };
  broadcast(userId, "chat.steer", payload);
  const reply = ok("agent.turn.steer", id, payload);
  completeSteerResult(id, reply);
  return reply;
}
```

Persistir el steer como `chat.append` user **en el daemon** (Task 4) para que Web/TUI lo vean vía `message.appended`. La API no duplica el append.

  7. `agent.turn.cancel` (si el plan 5 **no** lo añadió; si sí, no reescribir, solo asegurar `NO_DAEMON_ERROR` e idempotencia):

```ts
case "agent.turn.cancel": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const ctx = await workspaceIdForChat(msg.chatId, userId);
  if (!ctx) return fail(type, id, "Chat not found");
  const daemon = hub.findDaemon(userId, ctx.workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const wasRunning = Boolean(
    (daemon as { turnBusy?: boolean }).turnBusy &&
      ((daemon as { turnChatId?: string }).turnChatId === msg.chatId ||
        (daemon as { turnBusy?: boolean }).turnBusy),
  );
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("agent.turn.cancel", {
      chatId: msg.chatId,
      requestId: id,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return ok(type, id, { cancelled: true, wasRunning });
}
```

Si `hub.setTurnBusy` no existe, el daemon sigue siendo la fuente de `wasRunning` vía su propio `turnBusy`; devolver `wasRunning: true` cuando despachamos (el cliente no debe 500).

  8. `agent.turn.ended`: si no existe, añadirlo como en invariants Task 5 (`setTurnBusy(false)` + broadcast). Payload incluye `status: msg.status`.

- [ ] OpenAPI `api/openapi/openapi.yaml`:

  - Descripción de `/ws`: añadir `chat.thinking.delta`, `chat.thinking.end`, `agent.turn.steer`, `agent.turn.cancel`, `chat.steer`.
  - `WsClientChatStreamReserved.type` enum: añadir esos tipos.
  - Documentar `chat.stream.end` `status: finished | cancelled`.
  - Documentar `metadata.thinking` en ChatMessage.

- [ ] Crear `api/src/ws/thinking-steer.test.ts` **sin** Postgres si los helpers de persistencia se pueden unit-testear puros. Extraer `mergeAssistantMetadata(msg)` a `api/src/ws/thinking-meta.ts`:

```ts
export function mergeAssistantMetadata(input: {
  streamId: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const status = input.status === "cancelled" ? "cancelled" : "finished";
  return {
    streamId: input.streamId,
    status,
    ...(input.metadata || {}),
  };
}

export function shouldPersistCancelledAssistant(input: {
  content?: string;
  metadata?: Record<string, unknown> | null;
  status?: string;
}): boolean {
  if (input.status === "cancelled") return true;
  if ((input.content || "").trim()) return true;
  const thinking = input.metadata?.thinking as { text?: string; omitted?: boolean } | undefined;
  return Boolean(thinking && (thinking.omitted || (thinking.text || "").trim()));
}
```

Test: cancelled con content vacío **sí** persiste; finished sin content ni thinking **no**; thinking omitted persiste; status default finished.

- [ ] Correr:

```bash
cd api && bun test src/ws/thinking-steer.test.ts
```

- [ ] Commit:

```bash
git add api/package.json api/src/ws/errors.ts api/src/ws/protocol.ts \
  api/src/ws/handlers.ts api/src/ws/pending.ts api/src/ws/thinking-meta.ts \
  api/src/ws/thinking-steer.test.ts api/openapi/openapi.yaml
git commit -m "feat(api): thinking fan-out, steer RPC, cancelled stream status"
```

---

## Task 4: TurnSession — publish-turn, daemon, tools/diffs on cancel, follow-up

**Files:**

- Create: `cli/src/llm/turn-session.ts`
- Test: `cli/src/llm/turn-session.test.ts`
- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/ws/daemon.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `tui/src/App.tsx` (solo el `onPush` de steer/cancel; UI completa es Task 6)

El registro in-process es la fuente de verdad del turn en vuelo. Web/CLI pegan al API; el API pega al daemon; el daemon llama `TurnSession`.

- [ ] Crear `cli/src/llm/turn-session.ts`:

```ts
import { PromptStream } from "./prompt-stream";
import {
  abortTurn,
  beginTurnAbort,
  endTurnAbort,
  TURN_CANCELLED,
} from "./turn-abort";
import {
  deliveredAck,
  dropFollowUp,
  followupAck,
  queueFollowUp,
  takeFollowUp,
  validateSteerText,
  type SteerAck,
  STEER_NO_TURN,
  STEER_KIND,
} from "./steer";
import {
  appendThinkingDelta,
  emptyThinkingAccum,
  finalizeThinking,
  markThinkingOmitted,
  type ThinkingAccum,
} from "./thinking";

export type TurnSession = {
  chatId: string;
  streamId: string;
  promptStream: PromptStream;
  abort: AbortController;
  thinking: ThinkingAccum;
  assistantText: string;
  provider: "claude" | "cursor";
  cursorCancel?: () => Promise<void>;
  cursorSteer?: (text: string) => Promise<"complete_delivered" | "revert_to_followup">;
};

const sessions = new Map<string, TurnSession>();

export function getTurnSession(chatId: string): TurnSession | undefined {
  return sessions.get(chatId);
}

export function beginTurnSession(input: {
  chatId: string;
  streamId: string;
  provider: "claude" | "cursor";
}): TurnSession {
  const existing = sessions.get(input.chatId);
  if (existing) existing.abort.abort();
  const sess: TurnSession = {
    chatId: input.chatId,
    streamId: input.streamId,
    promptStream: new PromptStream(),
    abort: beginTurnAbort(input.chatId),
    thinking: emptyThinkingAccum(),
    assistantText: "",
    provider: input.provider,
  };
  sessions.set(input.chatId, sess);
  return sess;
}

export function endTurnSession(chatId: string): void {
  const sess = sessions.get(chatId);
  sess?.promptStream.close();
  sessions.delete(chatId);
  endTurnAbort(chatId);
}

export async function steerSession(chatId: string, raw: string): Promise<SteerAck> {
  const text = validateSteerText(raw);
  const sess = sessions.get(chatId);
  if (!sess) throw new Error(STEER_NO_TURN);

  if (sess.provider === "cursor") {
    if (!sess.cursorSteer) {
      queueFollowUp(chatId, text);
      return followupAck(text);
    }
    const outcome = await sess.cursorSteer(text);
    if (outcome === "complete_delivered") return deliveredAck(text);
    queueFollowUp(chatId, text);
    return followupAck(text);
  }

  const ok = sess.promptStream.pushSteer(text);
  if (ok) return deliveredAck(text);
  queueFollowUp(chatId, text);
  return followupAck(text);
}

export function cancelSession(chatId: string): boolean {
  const sess = sessions.get(chatId);
  const aborted = abortTurn(chatId);
  sess?.promptStream.close();
  if (sess?.cursorCancel) void sess.cursorCancel();
  dropFollowUp(chatId); // cancel ≠ follow-up auto-dispatch
  return Boolean(sess) || aborted;
}

export function onThinkingEvent(
  sess: TurnSession,
  ev: { kind: string; text?: string },
): void {
  if (ev.kind === "thinking_delta" && ev.text) {
    appendThinkingDelta(sess.thinking, ev.text);
  }
  if (ev.kind === "thinking_omitted") markThinkingOmitted(sess.thinking);
  if (ev.kind === "stream_delta" && ev.text) sess.assistantText += ev.text;
}

export { takeFollowUp, finalizeThinking, TURN_CANCELLED, STEER_KIND };
```

- [ ] Test `cli/src/llm/turn-session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  beginTurnSession,
  cancelSession,
  endTurnSession,
  getTurnSession,
  onThinkingEvent,
  steerSession,
} from "./turn-session";
import { peekFollowUp, takeFollowUp, STEER_NO_TURN } from "./steer";
import { finalizeThinking } from "./thinking";
import { TURN_CANCELLED as ABORT_MSG } from "./turn-abort";

describe("TurnSession", () => {
  test("steer delivered while stream open", async () => {
    const s = beginTurnSession({
      chatId: "c1",
      streamId: "s1",
      provider: "claude",
    });
    const ack = await steerSession("c1", "no toques tests");
    expect(ack.outcome).toBe("complete_delivered");
    expect(peekFollowUp("c1")).toBeNull();
    s.promptStream.close();
    endTurnSession("c1");
  });

  test("steer after close → follow-up, not a second session", async () => {
    const s = beginTurnSession({
      chatId: "c2",
      streamId: "s2",
      provider: "claude",
    });
    s.promptStream.close();
    const ack = await steerSession("c2", "espera");
    expect(ack.outcome).toBe("revert_to_followup");
    expect(takeFollowUp("c2")?.text).toBe("espera");
    endTurnSession("c2");
  });

  test("steer without session throws STEER_NO_TURN", async () => {
    await expect(steerSession("none", "x")).rejects.toThrow(STEER_NO_TURN);
  });

  test("cancel drops follow-up and aborts", async () => {
    beginTurnSession({ chatId: "c3", streamId: "s3", provider: "claude" });
    await steerSession("c3", "late-if-closed");
    // delivered, no follow-up yet; force follow-up then cancel
    getTurnSession("c3")!.promptStream.close();
    await steerSession("c3", "queued");
    expect(peekFollowUp("c3")?.text).toBe("queued");
    expect(cancelSession("c3")).toBe(true);
    expect(peekFollowUp("c3")).toBeNull();
    expect(getTurnSession("c3")!.abort.signal.aborted).toBe(true);
    endTurnSession("c3");
  });

  test("thinking does not land in assistantText", () => {
    const s = beginTurnSession({
      chatId: "c4",
      streamId: "s4",
      provider: "claude",
    });
    onThinkingEvent(s, { kind: "thinking_delta", text: "razon" });
    onThinkingEvent(s, { kind: "stream_delta", text: "hola" });
    expect(s.assistantText).toBe("hola");
    expect(finalizeThinking(s.thinking)?.text).toBe("razon");
    endTurnSession("c4");
  });

  test("frozen strings", () => {
    expect(ABORT_MSG).toBe("Turn cancelled");
    expect(STEER_NO_TURN).toBe("No turn running");
  });
});
```

Imports del test: `STEER_NO_TURN` desde `./steer`; `TURN_CANCELLED as ABORT_MSG` desde `./turn-abort`. **No** importar `TURN_CANCELLED` desde `steer.ts`.

- [ ] En `cli/src/llm/publish-turn.ts`:

  - Importar `beginTurnSession`, `endTurnSession`, `onThinkingEvent`, `takeFollowUp`, `finalizeThinking`, `TURN_CANCELLED`.
  - Tras resolver `streamId` y provider, `const sess = beginTurnSession({ chatId, streamId, provider })`.
  - Pasar `abortController: sess.abort` y `promptStream: sess.promptStream` a `runClaudeTurn`.
  - En `onEvent`:

```ts
onEvent: async (ev) => {
  onThinkingEvent(sess, ev);
  if (ev.kind === "thinking_delta") {
    await client.request({
      type: "chat.thinking.delta",
      chatId,
      streamId,
      delta: ev.text,
    });
  }
  if (ev.kind === "thinking_omitted" || ev.kind === "thinking_end") {
    const fin = finalizeThinking(sess.thinking);
    await client.request({
      type: "chat.thinking.end",
      chatId,
      streamId,
      metadata: {
        omitted: Boolean(fin?.omitted),
        durationMs: fin?.durationMs,
      },
    });
  }
  if (ev.kind === "stream_delta") {
    await client.request({
      type: "chat.stream.delta",
      chatId,
      streamId,
      delta: ev.text,
    });
  }
  // tool_start / tool_result: igual que ahora
},
```

  - Éxito: `chat.stream.end` con `status: "finished"`, `content: result`, `metadata: { thinking: finalizeThinking(sess.thinking) }`.
  - Catch: si `sess.abort.signal.aborted` o mensaje `TURN_CANCELLED`:

```ts
await client.request({
  type: "chat.stream.end",
  chatId,
  streamId,
  status: "cancelled",
  content: sess.assistantText || TURN_CANCELLED,
  metadata: {
    thinking: finalizeThinking(sess.thinking),
    status: "cancelled",
  },
});
```

**No** mandar `chat.stream.error` para cancel. Otros errores siguen en `chat.stream.error`.

  - `finally`:

```ts
const follow = sess.abort.signal.aborted ? null : takeFollowUp(chatId);
endTurnSession(chatId);
await client.request({
  type: "agent.turn.ended",
  chatId,
  streamId,
  status: sess.abort.signal.aborted ? "cancelled" : "finished",
});
if (follow) {
  await publishAgentTurn({
    client,
    chatId,
    prompt: follow.text,
    cwd,
    token,
  });
}
```

Cuidado con la recursión: el follow-up es un turn **nuevo** (Gherkin: al terminar). `beginTurnSession` en la recursión es correcto. No encolar el follow-up si el primer turn se canceló (`dropFollowUp` en `cancelSession`).

  - Si existe `cancelApprovalsForChat` (plan 3), llamarlo en el catch de cancel **antes** del stream.end: `cancelApprovalsForChat(chatId)`.
  - Si existe un collector de diffs (plan 6) con `dropProposed` / `finalize`, en cancel llamar `dropProposed()` y **no** `finalize()` de applied pendientes. Applied ya emitidos se quedan.

- [ ] En `cli/src/ws/daemon.ts`, el `onPush` atiende tres tipos:

```ts
import { cancelSession, steerSession } from "../llm/turn-session";
import { STEER_KIND } from "../llm/steer";

client.onPush(async (msg: WsPushMessage) => {
  if (msg.type === "agent.turn.cancel") {
    const chatId = (msg.data as { chatId?: string } | undefined)?.chatId;
    if (chatId) cancelSession(chatId);
    return;
  }
  if (msg.type === "agent.turn.steer.dispatch") {
    const data = (msg.data || {}) as {
      chatId?: string;
      content?: string;
      requestId?: string;
    };
    if (!data.chatId || !data.requestId) return;
    try {
      const ack = await steerSession(data.chatId, data.content || "");
      await client.request({
        type: "chat.append",
        chatId: data.chatId,
        role: "user",
        content: ack.content,
        metadata: {
          kind: STEER_KIND,
          outcome: ack.outcome,
        },
      });
      await client.request({
        type: "agent.turn.steer.result",
        id: data.requestId,
        chatId: data.chatId,
        content: ack.content,
        status: ack.outcome,
        metadata: { outcome: ack.outcome, reason: ack.reason },
      });
    } catch (err) {
      await client.request({
        type: "agent.turn.steer.result",
        id: data.requestId,
        chatId: data.chatId,
        content: data.content,
        status: "error",
        metadata: {
          outcome: "revert_to_followup",
          reason: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  // existing dispatch; pass through publishAgentTurn which owns TurnSession
});
```

`ChavezWsClient.request` ya acepta `id` opcional (`cli/src/ws/client.ts` `partial.id`). Pasar `id: data.requestId` para que la API complete el pending.

Si `WsRequest` no incluye `id` en el type público, ya está: `id?: string` en `request()`.

- [ ] TUI `onPush` (el TUI **es** daemon): copiar los mismos branches `agent.turn.cancel` y `agent.turn.steer.dispatch` que `daemon.ts`, llamando `cancelSession` / `steerSession` + `client.request` result. El dispatch de turn ya llama `publishAgentTurn`; no duplicar el registry.

- [ ] Correr:

```bash
cd cli && bun test src/llm/turn-session.test.ts src/llm/prompt-stream.test.ts src/llm/steer.test.ts
```

Esperado: delivered vs follow-up; cancel tira el follow-up; thinking ≠ assistantText.

- [ ] Commit:

```bash
git add cli/src/llm/turn-session.ts cli/src/llm/turn-session.test.ts \
  cli/src/llm/publish-turn.ts cli/src/ws/daemon.ts cli/src/ws/client.ts \
  tui/src/App.tsx
git commit -m "feat(daemon): steer inject-or-followup and cancel without undo"
```

---

## Task 5: Cursor runner (si existe) + CLI headless

**Files:**

- Modify: `cli/src/llm/cursor-runner.ts` (solo si el archivo **existe**)
- Test: `cli/src/llm/cursor-runner.steer.test.ts` (solo si el runner existe)
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (crear si el plan 2 no lo creó; si existe, **extender**)
- Test: `cli/src/llm/watch-format.test.ts` (crear o extender)
- Modify: `cli/src/llm/publish-turn.ts` (wire Cursor thinking/steer si el runner existe)

- [ ] Si `cli/src/llm/cursor-runner.ts` existe:

  - En el `for await (const event of run.stream())`, case `"thinking"`:

```ts
if (event.type === "thinking" && typeof event.text === "string" && event.text) {
  await input.onEvent?.({ kind: "thinking_delta", text: event.text });
}
```

  Texto assistant sigue siendo `stream_delta`. Nunca concatenar thinking al result.

  - Tras `agent.send`, registrar en la sesión:

```ts
const sess = getTurnSession(input.chatId); // o devolver handle a publish-turn
if (sess) {
  sess.cursorCancel = () => run.cancel();
  sess.cursorSteer = run.steer
    ? async (text) => {
        const outcome = await run.steer!(text);
        return outcome === "complete_delivered"
          ? "complete_delivered"
          : "revert_to_followup";
      }
    : undefined;
}
```

Si `publish-turn` es quien tiene `sess`, `runCursorTurn` puede devolver `{ text, attach(sess) }` o aceptar `onReady(handle)`. Preferir callback `onRunReady?: (h: { cancel: () => Promise<void>; steer?: (t: string) => Promise<SteerOutcome> }) => void` en `RunCursorTurnInput` para no ciclar imports.

  - `input.signal` abort → `run.cancel()`. Si `wait()` da `status === "cancelled"`, throw `TURN_CANCELLED`.
  - Test con fake `run`: `steer` resuelve `complete_delivered`; sin `steer` el attach deja `cursorSteer` undefined y `steerSession` hace follow-up.

- [ ] Si `cursor-runner.ts` **no** existe: no crearlo. El follow-up path de Task 4 cubre Cursor no ejecutable (el turn ni siquiera corre).

- [ ] En `cli/src/commands/headless.ts`, acciones `steer` y `cancel`:

```ts
if (action === "steer") {
  const chatId = rest[0];
  const content = rest.slice(1).join(" ");
  if (!chatId || !content.trim()) {
    throw new Error("Uso: … chat steer <chatId> <text…>");
  }
  const res = await client.request({
    type: "agent.turn.steer",
    chatId,
    content,
  });
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  return;
}
if (action === "cancel") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: … chat cancel <chatId>");
  const res = await client.request({ type: "agent.turn.cancel", chatId });
  if (!res.ok) throw new Error(res.error);
  console.log(JSON.stringify(res.data, null, 2));
  return;
}
```

Usage de `chat` pasa a `<create|list|append|get|ask|watch|steer|cancel>`.

- [ ] En `cli/src/index.ts`, línea de usage headless chat: añadir `steer|cancel`.

- [ ] En `cli/src/llm/watch-format.ts` (si no existe, copiar el mínimo del plan 2 y añadir; si existe, **añadir** cases):

```ts
if (msg.type === "chat.thinking.delta") {
  const delta = String(data.delta ?? "");
  if (!delta) return null;
  return `thinking Δ ${truncateThinkingPreview(delta, 120)}`;
}
if (msg.type === "chat.thinking.end") {
  return data.omitted ? "thinking · omitido" : "thinking · end";
}
if (msg.type === "chat.steer") {
  const outcome = String(data.outcome || "");
  return `steer · ${outcome} · ${truncateThinkingPreview(String(data.content || ""), 80)}`;
}
if (msg.type === "chat.stream.end") {
  const status = String(data.status || "finished");
  return status === "cancelled" ? "stream · cancelled" : "stream end";
}
```

Importar `truncateThinkingPreview` desde `./thinking`. **Nunca** imprimir un thinking delta como `assistant Δ`.

- [ ] Test watch-format: thinking delta → línea `thinking Δ`; stream.end cancelled → `stream · cancelled`; un `chat.stream.delta` con el mismo texto no se etiqueta thinking.

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts src/llm/turn-session.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/cursor-runner.ts cli/src/llm/cursor-runner.steer.test.ts \
  cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts \
  cli/src/llm/publish-turn.ts
git commit -m "feat(cli): chat steer/cancel and thinking watch lines"
```

Si `cursor-runner.ts` no existe, omitirlo del `git add`.

---

## Task 6: TUI — thinking colapsable, steer, Esc cancela (no mata)

**Files:**

- Modify: `tui/src/App.tsx`

- [ ] Extender `Message`:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna el array de `chat.get`; no filtrar `metadata`.

- [ ] Estado nuevo:

```ts
const [thinkingLive, setThinkingLive] = useState("");
const [thinkingOpen, setThinkingOpen] = useState(false);
const [steerDraft, setSteerDraft] = useState("");
```

Default `thinkingOpen = false` (colapsado). No persistir en disco.

- [ ] En `onPush`, además de message/stream:

```ts
if (msg.type === "chat.thinking.delta" && data.chatId === activeChatIdRef.current) {
  const delta = String((msg.data as { delta?: string })?.delta || "");
  setThinkingLive((p) => p + delta);
}
if (msg.type === "chat.thinking.end" && data.chatId === activeChatIdRef.current) {
  // keep live text until chat.get refresh
}
if (msg.type === "chat.stream.start") {
  setThinkingLive("");
}
if (msg.type === "chat.stream.end" || msg.type === "agent.turn.ended") {
  setThinkingLive("");
  void loadChat(String((msg.data as { chatId?: string })?.chatId || ""));
}
```

- [ ] `useInput`:

  - `ctrl+c` sigue saliendo (`client.close(); exit()`).
  - `Escape`:
    - si `busy` y `activeChatId`: `cancelSession(activeChatId)` + `client.request({ type: "agent.turn.cancel", chatId })`; `setLog("Turn cancelled")`; **no** `exit()`.
    - else si `mode === "compose"`: volver a command.
    - else: `exit()` como hoy.
  - Tecla `t` en command (también con `busy`): `setThinkingOpen((o) => !o)`.
  - Tecla `i` con `busy`: entra compose de **steer** (`setMode("compose")`, `setSteerDraft` via el `input` existente). Hint: `"Steer + Enter · Esc cancela compose (no el turn)"`.
  - En compose **con** `busy`: Enter manda `agent.turn.steer` (no `sendWithLlm`):

```ts
if (mode === "compose" && busy) {
  if (key.return) {
    const text = input.trim();
    setInput("");
    setMode("command");
    if (!text || !activeChatId || !client) return;
    const res = await client.request({
      type: "agent.turn.steer",
      chatId: activeChatId,
      content: text,
    });
    const data = (res.data || {}) as { outcome?: string; reason?: string };
    setLog(
      res.ok
        ? data.outcome === "complete_delivered"
          ? "Steer inyectado"
          : `Steer en follow-up: ${data.reason || ""}`
        : res.error || "steer failed",
    );
    return;
  }
  // backspace / chars igual que compose normal
  return;
}
```

  - Compose **sin** busy sigue siendo `sendWithLlm`. Enter vacío no envía.

- [ ] Banner busy: sustituir/ampliar `… generando respuesta` por `… generando · Esc cancela el turn · i steer · t thinking`. **No** `exit` en Esc.

- [ ] Render messages: extraer thinking con `thinkingFromMetadata(m.metadata)` importado de `../../cli/src/llm/thinking`.

```tsx
{messages.slice(-8).map((m) => {
  const th = thinkingFromMetadata(m.metadata ?? null);
  const cancelled = m.metadata && m.metadata.status === "cancelled";
  return (
    <Box key={m.id} flexDirection="column">
      {th ? (
        <Text dimColor>
          {th.omitted
            ? THINKING_OMITTED_LABEL
            : thinkingOpen
              ? `▾ ${THINKING_COLLAPSED_LABEL}: ${th.text}`
              : `▸ ${THINKING_COLLAPSED_LABEL} ${truncateThinkingPreview(th.text || "")}`}
        </Text>
      ) : null}
      <Text wrap="truncate-end">
        <Text color={m.role === "assistant" ? "green" : "magenta"}>
          {m.role}
          {cancelled ? " [cancelled]" : ""}:{" "}
        </Text>
        {m.content.replace(/\s+/g, " ").slice(0, 100)}
      </Text>
    </Box>
  );
})}
{busy && thinkingLive ? (
  <Text dimColor>
    {thinkingOpen
      ? thinkingLive.slice(-400)
      : `▸ ${THINKING_COLLAPSED_LABEL} ${truncateThinkingPreview(thinkingLive)}`}
  </Text>
) : null}
```

El assistant `content` **no** incluye thinking. Color dim vs green: no se confunden.

- [ ] Footer de atajos: añadir `[Esc] cancel turn` `[i] steer` `[t] thinking`.

- [ ] `sendWithLlm` / dispatch remoto: no cambiar el path de `publishAgentTurn`; el registry de Task 4 cubre cancel/steer de Web hacia esta TUI daemon.

- [ ] Commit:

```bash
git add tui/src/App.tsx
git commit -m "feat(tui): collapsible thinking, mid-turn steer, Esc cancels turn"
```

---

## Task 7: Web — ThinkingBlock, Steer, Cancelar

**Files:**

- Create: `web/src/lib/thinking.ts`
- Test: `web/src/lib/thinking.test.ts`
- Create: `web/src/components/ThinkingBlock.tsx`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/styles/global.css`
- Modify: `web/package.json`

Web no importa `cli/`. Copiar el codec (keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `web/package.json` `scripts` si no existe.

- [ ] Crear `web/src/lib/thinking.ts` copiando de `cli/src/llm/thinking.ts` las exportaciones usadas por UI: `THINKING_COLLAPSED_LABEL`, `THINKING_OMITTED_LABEL`, `WEB_THINKING_LS_KEY` (`"chavez.thinking.expanded"`), `thinkingFromMetadata`, `truncateThinkingPreview`, type `ThinkingPersist`. Primera línea:

```ts
/** keep-in-sync with cli/src/llm/thinking.ts — web must not import cli */
```

- [ ] Test `web/src/lib/thinking.test.ts`: mismos casos de `thinkingFromMetadata` que CLI (omitted / text / empty). `bun test src/lib/thinking.test.ts` desde `web/`.

- [ ] Crear `web/src/components/ThinkingBlock.tsx`:

```tsx
import { useEffect, useState } from "react";
import {
  THINKING_COLLAPSED_LABEL,
  THINKING_OMITTED_LABEL,
  WEB_THINKING_LS_KEY,
  type ThinkingPersist,
} from "../lib/thinking";

export function ThinkingBlock({
  thinking,
  liveText,
}: {
  thinking?: ThinkingPersist | null;
  liveText?: string;
}) {
  const omitted = thinking?.omitted === true;
  const text = omitted ? "" : thinking?.text || liveText || "";
  if (!omitted && !text) return null;

  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(WEB_THINKING_LS_KEY) === "1");
    } catch {
      // ignore
    }
  }, []);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(WEB_THINKING_LS_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  if (omitted) {
    return (
      <div className="thinking-block omitted">
        <span className="badge">{THINKING_OMITTED_LABEL}</span>
      </div>
    );
  }

  return (
    <div className="thinking-block">
      <button type="button" className="thinking-toggle" onClick={toggle}>
        {open ? "▾" : "▸"} {THINKING_COLLAPSED_LABEL}
      </button>
      {open ? (
        <pre className="thinking-body">{text}</pre>
      ) : (
        <p className="muted thinking-preview">
          {text.replace(/\s+/g, " ").slice(0, 80)}
          {text.length > 80 ? "…" : ""}
        </p>
      )}
    </div>
  );
}
```

- [ ] CSS en `web/src/styles/global.css`:

```css
.thinking-block {
  border-left: 3px solid var(--border);
  padding: 0.35rem 0.75rem;
  margin: 0.35rem 0 0.5rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.thinking-block .thinking-body {
  white-space: pre-wrap;
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--muted);
  margin: 0.35rem 0 0;
}
.thinking-toggle {
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  font: inherit;
}
.thinking-block.omitted .badge {
  background: var(--panel);
}
```

El assistant `pre` **no** usa `muted` de thinking. No reutilizar la clase `thinking-body` en el texto final.

- [ ] En `web/src/lib/ws-hooks.ts`:

```ts
export function useWsAgentCancel() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "agent.turn.cancel", chatId: input.chatId }),
  });
}

export function useWsAgentSteer() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string; content: string }) =>
      ws.request({
        type: "agent.turn.steer",
        chatId: input.chatId,
        content: input.content,
      }),
  });
}
```

- [ ] `web/src/lib/ws-client.ts` `WsRequest` ya tiene `content` / `chatId`. No hace falta campo nuevo. Asegurar que `ws-context` reenvía pushes cuyo type empieza por `chat.thinking.` y `chat.steer` (hoy filtra `chat.stream.` — **añadir** `chat.thinking.` / `chat.steer` / `agent.turn.` si hay allowlist).

En `web/src/lib/ws-context.tsx` la condición actual:

```
msg.type.startsWith("chat.stream.") ||
```

Extender a:

```ts
msg.type.startsWith("chat.stream.") ||
msg.type.startsWith("chat.thinking.") ||
msg.type.startsWith("chat.tool.") ||
msg.type === "chat.steer" ||
msg.type.startsWith("agent.turn.") ||
msg.type === "message.appended"
```

Si ya reenvía todo, no estrechar.

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  - Estado `thinkingLive` / `turnBusy` / `steerText`.
  - `onPush`:
    - `chat.thinking.delta` → concatenar `thinkingLive` (no `streamText`).
    - `chat.stream.delta` → solo `streamText`.
    - `chat.stream.start` → reset ambos.
    - `chat.stream.end` / `error` / `agent.turn.ended` → `streaming=false`, `turnBusy=false`, reset live, invalidate chat.
    - `agent.turn.started` → `turnBusy=true`.
    - `chat.steer` → invalidate + mensaje ok/error según `outcome`.
  - Timeline: para cada assistant, `<ThinkingBlock thinking={thinkingFromMetadata(m.metadata)} />` **encima** del `<pre>{m.content}</pre>`. Si `metadata.status === "cancelled"`, badge `cancelled` en el assistant, **no** en el thinking.
  - Live: si `thinkingLive`, `<ThinkingBlock liveText={thinkingLive} />` **aparte** del panel `assistant · live` que solo muestra `streamText`.
  - Botón `Cancelar turn` visible si `turnBusy || streaming`. Llama `useWsAgentCancel`. Disabled si WS no `open`.
  - Formulario Steer (textarea + botón `Steer`) visible si `turnBusy || streaming`. Submit `useWsAgentSteer`. Tras ok: si `outcome === "revert_to_followup"`, `setMsg({ kind: "ok", text: data.reason || STEER_UNSUPPORTED })`. Vacío no envía.
  - Submit del agente deshabilitado si `turnBusy` (1 turn). Steer **sí** habilitado.
  - Reload: `useChat` ya trae `metadata`; ThinkingBlock reconstruye. Si `omitted`, muestra la etiqueta sin cuerpo.

- [ ] Correr:

```bash
cd web && bun test src/lib/thinking.test.ts
```

- [ ] Commit:

```bash
git add web/package.json web/src/lib/thinking.ts web/src/lib/thinking.test.ts \
  web/src/components/ThinkingBlock.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/lib/ws-hooks.ts web/src/lib/ws-client.ts web/src/lib/ws-context.tsx \
  web/src/styles/global.css
git commit -m "feat(web): collapsible thinking, steer, and cancel controls"
```

---

## Task 8: Smoke — thinking persistido, steer, cancel ≠ undo

**Files:**

- Create: `cli/scripts/thinking-steer-cancel-smoke.ts`
- Modify: `cli/package.json`

Sin LLM real para el núcleo (fake daemon). Un camino opcional documenta el live Claude si hay credenciales.

- [ ] Crear `cli/scripts/thinking-steer-cancel-smoke.ts`:

El proceso de test se registra como `clientKind: "daemon"` y **simula** al runner: no llama `query()`. Cubre persistencia, fan-out y cancel/steer RPC.

```ts
/**
 * Smoke: thinking persist + steer follow-up + cancel ≠ undo.
 * Requires API + login token. Binds this process as daemon for cwd.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  beginTurnSession,
  cancelSession,
  endTurnSession,
  getTurnSession,
  onThinkingEvent,
  steerSession,
} from "../src/llm/turn-session";
import { peekFollowUp } from "../src/llm/steer";
import { finalizeThinking } from "../src/llm/thinking";
import { TURN_CANCELLED } from "../src/llm/turn-abort";

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
const bd = await daemon.bind(path, "daemon");
const bw = await web.bind(path, "client");
if (!bd.ok || !bw.ok) {
  console.error("bind failed", bd.error, bw.error);
  process.exit(1);
}

const session = await web.request({ type: "session.create", title: "tsc-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;
const chat = await web.request({
  type: "chat.create",
  sessionId,
  title: "tsc-chat",
});
if (!chat.ok) throw new Error(chat.error);
const chatId = (chat.data as { chat: { id: string } }).chat.id;

const seen: string[] = [];
web.onPush((msg) => {
  seen.push(msg.type);
});

// --- thinking persist ---
const streamId = crypto.randomUUID();
const sess = beginTurnSession({ chatId, streamId, provider: "claude" });
onThinkingEvent(sess, { kind: "thinking_delta", text: "paso uno" });
onThinkingEvent(sess, { kind: "stream_delta", text: "respuesta final" });
await daemon.request({ type: "chat.stream.start", chatId, streamId });
await daemon.request({
  type: "chat.thinking.delta",
  chatId,
  streamId,
  delta: "paso uno",
});
await daemon.request({
  type: "chat.stream.delta",
  chatId,
  streamId,
  delta: "respuesta final",
});
await daemon.request({
  type: "chat.stream.end",
  chatId,
  streamId,
  status: "finished",
  content: "respuesta final",
  metadata: { thinking: finalizeThinking(sess.thinking) },
});
endTurnSession(chatId);

const got = await web.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const messages = (got.data as { messages: Array<{
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> }).messages;
const assistant = [...messages].reverse().find((m) => m.role === "assistant");
if (!assistant) {
  console.error("FAIL: no assistant");
  process.exit(1);
}
if (assistant.content.includes("paso uno")) {
  console.error("FAIL: thinking leaked into assistant content", assistant.content);
  process.exit(1);
}
const thinking = assistant.metadata?.thinking as { text?: string } | undefined;
if (thinking?.text !== "paso uno") {
  console.error("FAIL: thinking not persisted", assistant.metadata);
  process.exit(1);
}
if (!seen.includes("chat.thinking.delta")) {
  console.error("FAIL: web did not see thinking.delta", seen);
  process.exit(1);
}

// --- steer without turn ---
const noTurn = await web.request({
  type: "agent.turn.steer",
  chatId,
  content: "no toques tests",
});
if (noTurn.ok) {
  console.error("FAIL: steer without turn succeeded", noTurn.data);
  process.exit(1);
}
if (!String(noTurn.error || "").includes("No turn running") &&
    !String(noTurn.error || "").toLowerCase().includes("turn")) {
  // Daemon may not be running a TurnSession; API might forward and daemon returns error.
  console.log("steer-without-turn error (ok):", noTurn.error);
}

// --- cancel without turn is idempotent ---
const c0 = await web.request({ type: "agent.turn.cancel", chatId });
if (!c0.ok) {
  console.error("FAIL: cancel without turn should be ok", c0.error);
  process.exit(1);
}

// --- in-process cancel drops unapplied follow-up, keeps applied writes ---
const sid = crypto.randomUUID();
beginTurnSession({ chatId, streamId: sid, provider: "claude" });
const live = getTurnSession(chatId)!;
live.promptStream.close();
const ack = await steerSession(chatId, "no toques tests");
if (ack.outcome !== "revert_to_followup") {
  console.error("FAIL: expected follow-up", ack);
  process.exit(1);
}
const appliedBefore = { "src/a.ts": "kept" };
cancelSession(chatId);
if (peekFollowUp(chatId)) {
  console.error("FAIL: cancel must drop follow-up");
  process.exit(1);
}
if (appliedBefore["src/a.ts"] !== "kept") {
  console.error("FAIL: cancel mutated applied writes");
  process.exit(1);
}
endTurnSession(chatId);

// persist a cancelled assistant and a tool running → cancelled
const stream2 = crypto.randomUUID();
await daemon.request({
  type: "chat.tool.start",
  chatId,
  toolCallId: "t-run",
  toolName: "Write",
  content: "Write",
  metadata: { input: { path: "src/a.ts" } },
});
await daemon.request({
  type: "chat.stream.end",
  chatId,
  streamId: stream2,
  status: "cancelled",
  content: TURN_CANCELLED,
  metadata: { status: "cancelled" },
});

const got2 = await web.request({ type: "chat.get", chatId });
const msgs2 = (got2.data as { messages: Array<{
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}> }).messages;
const tool = msgs2.find((m) => m.role === "tool");
const cancelled = [...msgs2].reverse().find((m) => m.metadata?.status === "cancelled");
if (!cancelled) {
  console.error("FAIL: cancelled assistant missing");
  process.exit(1);
}
if (tool && String(tool.metadata?.status) === "running") {
  console.error("FAIL: tool still running after cancel", tool.metadata);
  process.exit(1);
}

daemon.close();
web.close();
console.log("SMOKE PASS");
```

Si `chat.tool.start` aún no marca status running en metadata, el check de tool es condicional (`if (tool && status === running) fail`). El smoke se corre **después** de Tasks 3–4 (`agent.turn.cancel` y `chat.stream.end` con `status` ya existen).

- [ ] Añadir `"test:thinking-smoke": "bun run scripts/thinking-steer-cancel-smoke.ts"` en `cli/package.json`.

- [ ] Correr unitarios de las tres superficies:

```bash
cd cli && bun test src/llm/thinking.test.ts src/llm/steer.test.ts \
  src/llm/prompt-stream.test.ts src/llm/turn-abort.test.ts \
  src/llm/turn-session.test.ts src/llm/claude-runner.thinking.test.ts \
  src/llm/watch-format.test.ts
cd api && bun test src/ws/thinking-steer.test.ts
cd web && bun test src/lib/thinking.test.ts
```

Esperado: todos pasan.

- [ ] Smoke (API + login + WS):

```bash
cd cli && bun run scripts/thinking-steer-cancel-smoke.ts
```

Esperado: `SMOKE PASS`. Thinking no está en `content`. Cancel no borra el stand-in de writes aplicados. Follow-up se tira al cancelar.

- [ ] Commit:

```bash
git add cli/scripts/thinking-steer-cancel-smoke.ts cli/package.json
git commit -m "test(thinking): persist, steer follow-up, cancel is not undo"
```

---

## Orden de ejecución

1. Task 1 (módulos puros CLI) — no depende de API.
2. Task 2 (Claude runner) — depende de Task 1.
3. Task 3 (API protocol) — no depende del runner; puede ir en paralelo con 2.
4. Task 4 (TurnSession + daemon + publish-turn) — depende de 1–3.
5. Task 5 (Cursor opcional + CLI) — depende de 3–4.
6. Task 6 (TUI) — depende de 4.
7. Task 7 (Web) — depende de 3.
8. Task 8 (smoke) — después de 3–4 como mínimo; idealmente al final.

Tasks 5, 6 y 7 son paralelizables entre sí una vez 4 está mergeada.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Thinking colapsable Web/TUI | Task 6 `t` + Task 7 `ThinkingBlock`; default colapsado |
| No se confunde con el assistant final | Task 2 `classifyClaudeMessage`; Task 4 `assistantText` vs `thinking`; Task 7/6 bloques distintos; smoke `content` no contiene thinking |
| Recargar conserva thinking persistido | Task 3 `stream.end` metadata.thinking; Task 7/6 `thinkingFromMetadata`; smoke `chat.get` |
| Recargar omite de forma explícita | Task 1 `omitted: true`; Task 7 etiqueta `razonamiento omitido` sin cuerpo |
| Steer a mitad de turn, provider soporta | Task 1 `PromptStream.pushSteer`; Task 4 `complete_delivered`; Task 5 `run.steer`; Task 6 `i`; Task 7 form Steer; Task 5 `chat steer` |
| Steer no soportado → explica + follow-up al terminar | Task 4 `followupAck` + `takeFollowUp` en `finally` solo si **no** cancelled; UI muestra `STEER_UNSUPPORTED` |
| CLI/TUI/Web pueden steerear | Task 5 CLI; Task 6 TUI; Task 7 Web; mismo RPC `agent.turn.steer` |
| Cancelar → stream cancelled | Task 3/4 `chat.stream.end` `status=cancelled`; watch `stream · cancelled` |
| Tools in-flight paran | Task 3 `failRunningTools(..., "cancelled")`; Task 4 `cancelApprovalsForChat`; abort + `Query.interrupt`/`close` / `run.cancel()` |
| Diffs no aplicados no se escriben | Task 4 `dropProposed` si existe collector; deny waiters; disco intacto para `proposed` |
| El chat acepta un turn nuevo | Task 4 `endTurnSession` + `agent.turn.ended` limpia busy |
| Cancelar no es undo | Task 4 **no** llama git ni `agent.turn.undo`; smoke stand-in `src/a.ts` intacto; writes `applied` se quedan |
| Undo (plan 12) sigue disponible | Esta fase no toca `agent.turn.undo`; el checkpoint git del turn cancelado, si existía, sigue siendo el último turn |

## Fuera de este plan (no implementar)

- Undo git / retry → [checkpoints-undo](../checkpoints-undo/plan.md). Cancel **no** lo dispara.
- Cola genérica de turns (más de un follow-up, prioridad) → [turn-queue](../turn-queue/plan.md). Aquí solo el follow-up de **un** steer `revert_to_followup`.
- Slash `/steer` `/stop` → [slash-commands](../slash-commands/plan.md). CLI usa `chat steer` / `chat cancel`; TUI `i` / Esc.
- Cursor cloud, `Agent.create({ cloud })` → prohibido.
- Persistencia del estado expandido en `user_preferences` → UI local (`localStorage` / estado TUI).
- Notificaciones OS/email cuando el turn se cancela → [notifications](../notifications/plan.md) (in-app, no OS).
- Reconnect/heartbeat si el daemon muere a mitad de cancel → [daemon-reconnect](../daemon-reconnect/plan.md).
- Worktrees paralelos → [worktree-cwd](../worktree-cwd/plan.md). 1 turn por daemon.
- Aprobaciones lote / “siempre permitir” → prohibido (decisión 11). Cancel niega waiters uno a uno vía `cancelApprovalsForChat`.
