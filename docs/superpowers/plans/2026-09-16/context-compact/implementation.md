# Context compact Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, slash picker genérico (plan 11 — aquí solo el comando `/compact` exacto), artefacto editable de plan (plan 14 — aquí solo **conservar** el último plan si ya existe en el chat), usage/cost panel (plan 15), memoria entre chats (plan 31), cola de turns (plan 29), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Si un sibling (`attach-files`, `agent-tools`, `diffs-review`, `cursor-provider`, `plan-artifact`) ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El usuario ve cuándo el chat se acerca al límite de contexto del **modelo activo**, puede compactar a mano (slash `/compact`, tecla TUI, CLI headless) y no pierde el turn siguiente en silencio. Compactar resume el historial de **ese chat Chavez**, stubbea tools viejas (sin reenviar megabytes de grep y **sin re-ejecutarlas**), conserva el último diff y el último plan si existen, deja los `@` del mensaje **actual** hidratados enteros (con su tope) y, si un turn no cabe, compacta y reintenta **una** vez o falla con un mensaje de compactar a mano. El algoritmo es de Chavez: Claude y Cursor no traen una API de compact distinta; solo cambia el `contextWindowTokens` del modelo activo.

**Architecture:** El filesystem y el runner del LLM viven en el daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). Compactar **no** lee el disco para resumir: solo lee `chat_messages` ya persistidos. La API no llama al modelo: reenvía `chat.compact` al daemon bound, persiste el marcador `role=system` + `metadata.kind="compact_marker"` y hace fan-out de `chat.compact.done` / `chat.context.usage`. Web / TUI / CLI `watch` observan el mismo marcador y el mismo presupuesto.

```
Composer | TUI [C] | CLI chat compact | overflow en publishAgentTurn
        |
        v
  chat.compact  --WS-->  API hub.findDaemon
        |                   | no daemon → "No daemon bound…"
        |                   | turnBusy  → "Turn already running on this daemon"
        v                   v
  chat.compact.dispatch --> daemon / TUI
        |
        v
  compactChat(chatId, { trigger, compactedUntilMessageId })
        |  chat.get
        |  splitCompactWindow: head (a resumir) / tail (se queda)
        |  stub tool rows del head a TOOL_STUB_MAX_CHARS
        |  NO hydrate, NO grep, NO write, NO bash
        |  extractLastDiff + extractLastPlan (si hay)
        |  summarizeForCompact (LLM, tools: []  — o extractive si no hay provider runnable)
        |  chat.append system { kind: compact_marker, summary, pins, compactedUntilMessageId }
        |  chat.compact.done + chat.context.usage
        v
  historyFromChatMessages
        |  último compact_marker → system(summary + lastDiff + lastPlan)
        |  + mensajes DESPUÉS de compactedUntilMessageId (sin el marcador)
        |  + prompt actual con attaches FULL (topes de attach-files)
        |  tools históricas: stub o drop; nunca tool_use rehidratado
        v
  publishAgentTurn
        |  measurePromptBudget(model.contextWindowTokens)
        |  warn/critical → broadcast chat.context.usage  (el turn NO se traga el error)
        |  over budget o SDK overflow → compact + retry UNA vez
        |  sigue overflow → chat.stream.error COMPACT_OVERFLOW_ERROR
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/history.ts` recorta en silencio a `MAX_HISTORY_MESSAGES=40` y `MAX_HISTORY_CHARS=100_000`, **tira** `role=tool`, ignora `metadata`. Eso es el fallo silencioso que Gherkin prohíbe. Esta fase lo sustituye por presupuesto + marcador.
- `cli/src/llm/publish-turn.ts` arma history y llama `runClaudeTurn`. **No** estima tokens, **no** compacta, **no** reintenta overflow.
- `cli/src/llm/claude-runner.ts` si el SDK no devuelve `result/success` lanza `"Claude no devolvió un resultado de éxito"` — no clasifica `prompt is too long`.
- `cli/src/llm/catalog.ts` y `api/src/llm/catalog.ts`: `ModelInfo` **no** tiene `contextWindowTokens`.
- `api/src/ws/handlers.ts` despacha `agent.turn.request`. **No** hay `chat.compact` ni `chat.context.usage`. `chat.get` (WS + HTTP `GET /chats/:chatId` en `api/src/routes/workspaces.ts`) devuelve `{ chat, messages }` sin presupuesto.
- `cli/src/ws/daemon.ts` y TUI `tui/src/App.tsx` solo atienden `agent.turn.dispatch`. `turnBusy` / `turnBusyRef` ya existen.
- CLI `chavez headless chat`: `create|list|append|get|ask|watch`. **No** hay `compact`.
- TUI teclas: `c` crea chat. Compacto = **`C`** (mayúscula). Compose no intercepta `/compact`.
- Web `ChatDetailPanel.tsx`: textarea plano, sin banner de contexto, sin marcador, sin botón Compactar.
- `chat_messages.metadata` jsonb **ya existe**. No hay migración. No hay tabla nueva.
- Attach (plan 1): hidrata en el daemon **antes** del LLM; snapshot en `metadata.attachments`. Compact **no** resume el attach del prompt actual.
- Tools (plan 2): output ya se trunca a `TOOL_OUTPUT_MAX_CHARS=8000` para la timeline. Compact stubbea a `TOOL_STUB_MAX_CHARS=400` **en el prompt**. No re-ejecuta.
- Diffs (plan 6): si existe `turn_file_diffs` / `metadata.diffs`, se pinnea el último set `applied`. Si no, se omite el pin (no se falla).
- Plan artifact (plan 14): si existe `metadata.kind === "plan_artifact"` o un assistant con `metadata.executionMode === "plan"`, se pinnea. Si no, se omite.
- Cursor (plan 4): si `runnable: false`, el compact **extractivo** o Claude (si está linked) igual escribe el marcador. El presupuesto usa el `contextWindowTokens` del modelo **activo**.
- Slash genérico (plan 11) **no** se implementa: esta fase trata el string exacto `/compact` en el compositor y el subcomando CLI. El picker `/` vendrá después y reutilizará `chat.compact`.

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (sin migración), Claude Agent SDK `query` (`tools: []`, `allowedTools: []`, `settingSources: []`), Ink TUI, Astro/React web. Estimación de tokens = `ceil(chars / 4)` (sin tokenizer nativo). Duplicar el módulo de presupuesto en API (Web no importa CLI).

**Global Constraints:**

1. El filesystem se lee y escribe **solo** en el daemon, y **compact no lo toca**. Resumir es texto ya persistido. API y browser no hidratan, no grepean, no llaman al LLM para compactar.
2. Sin daemon bound, `chat.compact` y `agent.turn.request` fallan con el string existente: `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. 1 turn por daemon. Compact RPC usa el mismo lock (`turnBusy`). Overflow-compact **dentro** de `publishAgentTurn` reutiliza el lock ya tomado; no dispara un segundo RPC.
4. Compact es del **chat Chavez** (filas `chat_messages`). No se llama a una Compact Conversation API de Anthropic ni de Cursor. El único input por-provider es `contextWindowTokens` del modelo activo.
5. El marcador se **appendea**; no se borran mensajes. La timeline sigue mostrando el pasado. El LLM, a partir del marcador, recibe summary + pins + cola posterior a `compactedUntilMessageId`.
6. Tools históricas: solo texto. Compact **nunca** vuelve a correr grep/write/bash/read. El summarizer se invoca con `tools: []` y `allowedTools: []`. Un `canUseTool` que se dispare igual **deny**.
7. Attaches del **mensaje actual** (el `prompt` del turn en curso, o el último user si aún no hay turn) se hidratan con los topes de attach-files (`TEXT_ATTACH_MAX_BYTES=100_000`, listing ≤10, imagen/binario según plan 1). Compact del pasado no los pisa ni los mete al summary.
8. Último diff y último plan se conservan **si hay**. Si no hay, el compact sigue (pins `null`).
9. Overflow: compacta y reintenta **una** vez. Si sigue sin caber → `chat.stream.error` con `COMPACT_OVERFLOW_ERROR`. Nunca un throw sin stream error. Nunca recortar el prompt en silencio.
10. Aviso de contexto alto en Web, TUI y CLI `watch` (y `chat get` / `chat compact` en stdout). Umbral warn 70%, critical 90% del presupuesto de **input** (ventana − reserva de output).
11. Lecturas no piden confirmación. Compact no es una tool del modelo y no entra en modos `plan`/`auto`/`ask`.
12. Claude es el provider ejecutable hoy. Cursor vinculado no ejecuta turns hasta el plan 4; el marcador y el presupuesto aplican igual. Cuando Cursor sea runnable, el mismo `compactChat` alimenta `runCursorTurn` vía `historyFromChatMessages`.
13. Web, TUI y `watch` ven el mismo contrato: marcador `contexto compactado` + `chat.context.usage`.
14. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, slash picker, cost panel, memoria global (compact de un chat **no** borra memoria — plan 31; aquí no hay tabla de memoria que tocar).

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `CHARS_PER_TOKEN` | `4` |
| `DEFAULT_CONTEXT_WINDOW_TOKENS` | `200_000` |
| `RESERVED_OUTPUT_TOKENS` | `8_192` |
| `CONTEXT_WARN_RATIO` | `0.70` |
| `CONTEXT_CRITICAL_RATIO` | `0.90` |
| `KEEP_RECENT_MESSAGES` | `6` |
| `COMPACT_MIN_MESSAGES` | `4` |
| `TOOL_STUB_MAX_CHARS` | `400` |
| `SUMMARY_MAX_CHARS` | `8_000` |
| `PINNED_DIFF_MAX_CHARS` | `8_000` |
| `PINNED_PLAN_MAX_CHARS` | `8_000` |
| `COMPACT_SOURCE_MAX_CHARS` | `120_000` |
| `COMPACT_TIMEOUT_MS` | `90_000` |
| `COMPACT_MARKER_KIND` | `"compact_marker"` |
| `COMPACT_MARKER_LABEL` | `"contexto compactado"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |
| `COMPACT_OVERFLOW_ERROR` | `"Context overflow: compact manually (/compact or chavez headless chat compact) and retry."` |
| `COMPACT_NO_HISTORY` | `"Nothing to compact — chat is already short."` |
| `CONTEXT_WARN_TEXT` | `` `Contexto alto (${pct}%) — considera compactar` `` |
| `CONTEXT_CRITICAL_TEXT` | `` `Contexto casi lleno (${pct}%) — compacta antes del próximo turn` `` |

Presupuesto de input:

```
budgetTokens = max(1024, contextWindowTokens - RESERVED_OUTPUT_TOKENS)
ratio        = usedTokens / budgetTokens
level        = ratio ≥ 0.90 → "critical" | ≥ 0.70 → "warn" | else "ok"
```

Ventanas por modelo (añadir `contextWindowTokens` a cada entrada; no inventar 1M):

| id | `contextWindowTokens` |
|---|---|
| `claude-opus-4-6` | `200000` |
| `claude-sonnet-4-6` | `200000` |
| `claude-haiku-4-5-20251001` | `200000` |
| `claude-opus-4-5-20251101` | `200000` |
| `claude-sonnet-4-5-20250929` | `200000` |
| `composer-2.5` (stub Cursor) | `200000` |

Si el catálogo crudo de Cursor (plan 4) trae `context_window` / `contextWindow` / `max_input_tokens`, deserializarlo; si no, `DEFAULT_CONTEXT_WINDOW_TOKENS`.

Nombres de events WS:

| Tipo | Dirección | Payload |
|---|---|---|
| `chat.compact` | cliente → API | `{ chatId }` |
| `chat.compact.dispatch` | API → daemon (push) | `{ chatId, requestId, requesterConnectionId, path, trigger: "manual" }` |
| `chat.compact.result` | daemon → API (RPC) | `{ requestId, ok, metadata: CompactResult }` |
| `chat.compact.done` | API → broadcast | `{ chatId, message, context }` |
| `chat.context.usage` | API → broadcast | `{ chatId, context }` |

`context` (mismo objeto en `chat.get`, HTTP y broadcast):

```ts
type ContextUsage = {
  usedTokens: number;
  budgetTokens: number;
  windowTokens: number;
  ratio: number;
  level: "ok" | "warn" | "critical";
  modelId: string;
  providerId: string;
  pct: number; // 0–100, floor(ratio * 100)
};
```

Marcador persistido:

```ts
type CompactMarkerMeta = {
  kind: "compact_marker";
  trigger: "manual" | "overflow";
  summary: string;
  compactedUntilMessageId: string;
  lastDiff: string | null;
  lastPlan: string | null;
  compactedMessageCount: number;
  usedTokensBefore: number;
  usedTokensAfter: number;
  modelId: string;
  providerId: string;
};
```

`content` del mensaje system = `contexto compactado` (label visible). El summary vive en `metadata.summary`, no duplicado en `content`.

---

## Task 1: Presupuesto de tokens y ventanas de modelo

**Files:**

- Create: `cli/src/llm/context-budget.ts`
- Test: `cli/src/llm/context-budget.test.ts`
- Create: `api/src/llm/context-budget.ts` (copia del CLI; import de catálogo API)
- Test: `api/src/llm/context-budget.test.ts`
- Modify: `cli/src/llm/catalog.ts`
- Modify: `api/src/llm/catalog.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`

Módulo puro. TUI importa `cli/src/llm/context-budget.ts`. Web **no** importa CLI: Task 8 duplica solo el formateo de banner.

- [ ] Añadir `"test": "bun test"` en `cli/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin` intactos):

```json
"scripts": {
  "start": "bun run src/index.ts",
  "dev": "bun run src/index.ts",
  "test": "bun test"
}
```

- [ ] Añadir `"test": "bun test"` en `api/package.json` `scripts` si aún no existe (dejar `dev`/`start`/`db:*`/`test:e2e` intactos).

- [ ] En `cli/src/llm/catalog.ts` y `api/src/llm/catalog.ts`, extender `ModelInfo`:

```ts
export type ModelInfo = {
  id: string;
  label: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  effortLevels: EffortLevel[];
  contextWindowTokens: number;
};
```

Añadir `contextWindowTokens: 200_000` a **cada** modelo de `CLAUDE_MODELS` y `CURSOR_MODELS`. No cambiar ids, labels, precios ni effort.

Añadir helper (ambos catálogos):

```ts
export function modelContextWindow(
  providerId: string,
  modelId: string | null | undefined,
): number {
  const model = modelId ? getModel(providerId, modelId) : undefined;
  return model?.contextWindowTokens ?? 200_000;
}
```

Si `getModel` no existe en el catálogo API, copiar las funciones `getCatalog` / `getModel` del CLI (ya están en `cli/src/llm/catalog.ts`). No aplanar el catálogo Cursor del plan 4: si `ModelInfo` allá ya es nativo, leer `contextWindowTokens` con fallback `200_000`.

- [ ] Crear `cli/src/llm/context-budget.ts`:

```ts
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const RESERVED_OUTPUT_TOKENS = 8_192;
export const CONTEXT_WARN_RATIO = 0.7;
export const CONTEXT_CRITICAL_RATIO = 0.9;

export type ContextLevel = "ok" | "warn" | "critical";

export type ContextUsage = {
  usedTokens: number;
  budgetTokens: number;
  windowTokens: number;
  ratio: number;
  level: ContextLevel;
  modelId: string;
  providerId: string;
  pct: number;
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function inputBudgetTokens(windowTokens: number): number {
  const w =
    Number.isFinite(windowTokens) && windowTokens > 0
      ? windowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(1024, w - RESERVED_OUTPUT_TOKENS);
}

export function contextLevel(ratio: number): ContextLevel {
  if (ratio >= CONTEXT_CRITICAL_RATIO) return "critical";
  if (ratio >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}

export function measureContextUsage(input: {
  usedTokens: number;
  windowTokens: number;
  modelId: string;
  providerId: string;
}): ContextUsage {
  const windowTokens =
    input.windowTokens > 0 ? input.windowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const budgetTokens = inputBudgetTokens(windowTokens);
  const usedTokens = Math.max(0, Math.floor(input.usedTokens));
  const ratio = budgetTokens > 0 ? usedTokens / budgetTokens : 0;
  const level = contextLevel(ratio);
  return {
    usedTokens,
    budgetTokens,
    windowTokens,
    ratio,
    level,
    modelId: input.modelId,
    providerId: input.providerId,
    pct: Math.min(999, Math.floor(ratio * 100)),
  };
}

export function formatContextBanner(usage: ContextUsage): string | null {
  if (usage.level === "critical") {
    return `Contexto casi lleno (${usage.pct}%) — compacta antes del próximo turn`;
  }
  if (usage.level === "warn") {
    return `Contexto alto (${usage.pct}%) — considera compactar`;
  }
  return null;
}

const OVERFLOW_RE =
  /prompt is too long|context[_ ]length|max[_ ]tokens|too many tokens|exceeds.*context|input is too long|context window|maximum context/i;

export function isContextOverflowError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? "");
  return OVERFLOW_RE.test(m);
}

export const COMPACT_OVERFLOW_ERROR =
  "Context overflow: compact manually (/compact or chavez headless chat compact) and retry.";

export const COMPACT_NO_HISTORY =
  "Nothing to compact — chat is already short.";

export const COMPACT_MARKER_KIND = "compact_marker";
export const COMPACT_MARKER_LABEL = "contexto compactado";
```

- [ ] Copiar el mismo archivo a `api/src/llm/context-budget.ts` (sin importar CLI). No importar el catálogo aquí: el módulo es puro.

- [ ] Crear `cli/src/llm/context-budget.test.ts` (el de API es idéntico cambiando el import):

```ts
import { describe, expect, test } from "bun:test";
import {
  COMPACT_OVERFLOW_ERROR,
  contextLevel,
  estimateTokens,
  formatContextBanner,
  inputBudgetTokens,
  isContextOverflowError,
  measureContextUsage,
} from "./context-budget";

describe("estimateTokens", () => {
  test("empty is 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  test("4 chars → 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });
  test("5 chars → 2 tokens", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("inputBudgetTokens", () => {
  test("200k window reserves 8192", () => {
    expect(inputBudgetTokens(200_000)).toBe(200_000 - 8_192);
  });
  test("tiny window still ≥ 1024", () => {
    expect(inputBudgetTokens(100)).toBe(1024);
  });
});

describe("measureContextUsage", () => {
  test("ok under 70%", () => {
    const u = measureContextUsage({
      usedTokens: 10_000,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(u.level).toBe("ok");
    expect(formatContextBanner(u)).toBeNull();
  });
  test("warn at 70%", () => {
    const budget = inputBudgetTokens(200_000);
    const u = measureContextUsage({
      usedTokens: Math.ceil(budget * 0.7),
      windowTokens: 200_000,
      modelId: "m",
      providerId: "claude",
    });
    expect(u.level).toBe("warn");
    expect(formatContextBanner(u)).toMatch(/Contexto alto/);
    expect(formatContextBanner(u)).toMatch(/%/);
  });
  test("critical at 90%", () => {
    const budget = inputBudgetTokens(200_000);
    const u = measureContextUsage({
      usedTokens: Math.ceil(budget * 0.9),
      windowTokens: 200_000,
      modelId: "m",
      providerId: "claude",
    });
    expect(u.level).toBe("critical");
    expect(formatContextBanner(u)).toMatch(/casi lleno/);
  });
  test("level helper matches", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(0.69)).toBe("ok");
    expect(contextLevel(0.7)).toBe("warn");
    expect(contextLevel(0.9)).toBe("critical");
  });
});

describe("isContextOverflowError", () => {
  test("detects common SDK strings", () => {
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    expect(isContextOverflowError("context_length_exceeded")).toBe(true);
    expect(isContextOverflowError("max_tokens")).toBe(true);
    expect(isContextOverflowError("input is too long")).toBe(true);
    expect(isContextOverflowError(new Error("ECONNRESET"))).toBe(false);
    expect(isContextOverflowError(COMPACT_OVERFLOW_ERROR)).toBe(false);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/context-budget.test.ts
cd api && bun test src/llm/context-budget.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/context-budget.ts cli/src/llm/context-budget.test.ts \
  cli/src/llm/catalog.ts cli/package.json \
  api/src/llm/context-budget.ts api/src/llm/context-budget.test.ts \
  api/src/llm/catalog.ts api/package.json
git commit -m "feat(context): token budget helpers and model context windows"
```

---

## Task 2: Fuente de compact, stubs de tools, pins, history con marcador

**Files:**

- Create: `cli/src/llm/compact.ts`
- Test: `cli/src/llm/compact.test.ts`
- Modify: `cli/src/llm/history.ts`
- Test: `cli/src/llm/history.test.ts` (crear si no existe; si attach-files ya lo creó, **añadir** casos, no borrar los de attachments)

El compact **no** llama al LLM todavía (Task 3). Aquí: qué se resume, qué se conserva, qué ve el siguiente turn.

- [ ] Crear `cli/src/llm/compact.ts`:

```ts
import { COMPACT_MARKER_KIND } from "./context-budget";

export const KEEP_RECENT_MESSAGES = 6;
export const COMPACT_MIN_MESSAGES = 4;
export const TOOL_STUB_MAX_CHARS = 400;
export const SUMMARY_MAX_CHARS = 8_000;
export const PINNED_DIFF_MAX_CHARS = 8_000;
export const PINNED_PLAN_MAX_CHARS = 8_000;
export const COMPACT_SOURCE_MAX_CHARS = 120_000;

export type CompactTrigger = "manual" | "overflow";

export type ChatRow = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CompactMarkerMeta = {
  kind: "compact_marker";
  trigger: CompactTrigger;
  summary: string;
  compactedUntilMessageId: string;
  lastDiff: string | null;
  lastPlan: string | null;
  compactedMessageCount: number;
  usedTokensBefore: number;
  usedTokensAfter: number;
  modelId: string;
  providerId: string;
};

export function isCompactMarker(m: ChatRow | null | undefined): boolean {
  const kind = m?.metadata && typeof m.metadata === "object"
    ? (m.metadata as { kind?: unknown }).kind
    : undefined;
  return kind === COMPACT_MARKER_KIND;
}

export function lastCompactMarker(messages: ChatRow[]): ChatRow | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactMarker(messages[i])) return messages[i]!;
  }
  return null;
}

export function stubToolContent(content: string, max = TOOL_STUB_MAX_CHARS): string {
  const s = content ?? "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars — omitted after compact]`;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars]`;
}

/**
 * Last applied diff preview. Reads (in order):
 * 1. sidecar `diffs` array passed by the caller (plan 6 GET /chats)
 * 2. message.metadata.diffs
 * 3. assistant metadata.diffPreview
 * Never shells out to git. Never reads the cwd.
 */
export function extractLastDiff(
  messages: ChatRow[],
  sidecarDiffs?: Array<Record<string, unknown>> | null,
): string | null {
  const fromSide = formatDiffSet(sidecarDiffs);
  if (fromSide) return clip(fromSide, PINNED_DIFF_MAX_CHARS);

  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = rec(messages[i]?.metadata);
    if (!meta) continue;
    const nested = formatDiffSet(
      (Array.isArray(meta.diffs) ? meta.diffs : null) as
        | Array<Record<string, unknown>>
        | null,
    );
    if (nested) return clip(nested, PINNED_DIFF_MAX_CHARS);
    if (typeof meta.diffPreview === "string" && meta.diffPreview.trim()) {
      return clip(meta.diffPreview, PINNED_DIFF_MAX_CHARS);
    }
  }
  return null;
}

function formatDiffSet(
  diffs: Array<Record<string, unknown>> | null | undefined,
): string | null {
  if (!diffs?.length) return null;
  const applied = diffs.filter((d) => {
    const st = String(d.status || "applied");
    return st === "applied" || st === "proposed";
  });
  if (!applied.length) return null;
  const lines = applied.map((d) => {
    const p = String(d.path || "?");
    const kind = String(d.kind || "modified");
    const add = Number(d.additions || 0);
    const del = Number(d.deletions || 0);
    const preview = typeof d.preview === "string" ? d.preview : "";
    return `${p} (${kind}, +${add} −${del})\n${preview}`.trim();
  });
  return `Last turn diffs:\n${lines.join("\n\n")}`;
}

/**
 * Last plan text. Reads metadata.kind === "plan_artifact" (plan 14)
 * or the last assistant with metadata.executionMode === "plan".
 */
export function extractLastPlan(messages: ChatRow[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const meta = rec(m.metadata);
    if (!meta) continue;
    if (meta.kind === "plan_artifact" && typeof m.content === "string" && m.content.trim()) {
      return clip(m.content, PINNED_PLAN_MAX_CHARS);
    }
    if (
      m.role === "assistant" &&
      meta.executionMode === "plan" &&
      typeof m.content === "string" &&
      m.content.trim()
    ) {
      return clip(m.content, PINNED_PLAN_MAX_CHARS);
    }
    if (typeof meta.plan === "string" && meta.plan.trim()) {
      return clip(meta.plan, PINNED_PLAN_MAX_CHARS);
    }
  }
  return null;
}

export type CompactWindow = {
  head: ChatRow[];
  tail: ChatRow[];
  compactedUntilMessageId: string;
  compactedMessageCount: number;
  tooShort: boolean;
};

/**
 * Split messages into head (summarize) and tail (keep verbatim).
 * `excludeIds` = current user message (overflow) — never summarized.
 * Attachments on excludeIds are NOT in the head.
 */
export function splitCompactWindow(
  messages: ChatRow[],
  opts: { excludeIds?: Set<string>; keepRecent?: number } = {},
): CompactWindow {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_MESSAGES;
  const exclude = opts.excludeIds ?? new Set<string>();
  const usable = messages.filter((m) => !isCompactMarker(m) && !exclude.has(String(m.id || "")));

  const textish = usable.filter((m) => {
    const role = String(m.role || "");
    return role === "user" || role === "assistant" || role === "system" || role === "tool";
  });

  if (textish.length < COMPACT_MIN_MESSAGES) {
    return {
      head: [],
      tail: textish,
      compactedUntilMessageId: textish[textish.length - 1]?.id
        ? String(textish[textish.length - 1]!.id)
        : "",
      compactedMessageCount: 0,
      tooShort: true,
    };
  }

  const cut = Math.max(0, textish.length - keepRecent);
  const head = textish.slice(0, cut);
  const tail = textish.slice(cut);
  const lastHead = head[head.length - 1];
  return {
    head,
    tail,
    compactedUntilMessageId: lastHead?.id ? String(lastHead.id) : String(textish[0]!.id || ""),
    compactedMessageCount: head.length,
    tooShort: head.length === 0,
  };
}

function attachmentStub(meta: Record<string, unknown> | null | undefined): string {
  const atts = Array.isArray(meta?.attachments) ? meta!.attachments : [];
  if (!atts.length) return "";
  return atts
    .map((a) => {
      const recA = rec(a) ?? {};
      const p = String(recA.path || "?");
      const kind = String(recA.kind || "file");
      return `[attached ${kind} ${p} — omitted after compact]`;
    })
    .join("\n");
}

/** Render one row for the summarizer. Tools stubbed. Historical attaches stubbed. */
export function renderRowForCompact(m: ChatRow): string {
  const role = String(m.role || "user");
  const content = typeof m.content === "string" ? m.content : "";
  if (role === "tool") {
    const meta = rec(m.metadata);
    const name = String(meta?.toolName || meta?.sdkName || "tool");
    const status = String(meta?.status || "done");
    return `TOOL ${name} (${status}):\n${stubToolContent(content)}`;
  }
  const att = attachmentStub(rec(m.metadata));
  const body = att ? `${content}\n${att}` : content;
  return `${role.toUpperCase()}:\n${body}`;
}

export function buildCompactSource(head: ChatRow[]): string {
  const parts = head.map(renderRowForCompact);
  let joined = parts.join("\n\n");
  if (joined.length > COMPACT_SOURCE_MAX_CHARS) {
    joined = `${joined.slice(0, COMPACT_SOURCE_MAX_CHARS)}\n[truncated compact source]`;
  }
  return joined;
}

export const COMPACT_SUMMARY_PREAMBLE = [
  "Summarize this coding-agent chat for a future turn of the same chat.",
  "Preserve: user goals, decisions, file paths touched, remaining tasks, errors, constraints.",
  "Do not invent files, commands, or outcomes.",
  "Do not call tools. Do not re-run grep, write, or bash.",
  "Output markdown only. No preamble like 'Here is the summary'.",
].join(" ");

export function buildSummarizerPrompt(source: string, pins: {
  lastDiff: string | null;
  lastPlan: string | null;
}): string {
  const pinBlocks: string[] = [];
  if (pins.lastDiff) pinBlocks.push(`PINNED LAST DIFF (keep as-is in your summary's 'Last diff' section):\n${pins.lastDiff}`);
  if (pins.lastPlan) pinBlocks.push(`PINNED LAST PLAN (keep as-is in your summary's 'Last plan' section):\n${pins.lastPlan}`);
  return [
    COMPACT_SUMMARY_PREAMBLE,
    "",
    "Conversation to compress:",
    source || "(empty)",
    "",
    ...pinBlocks,
  ].join("\n");
}

export function extractiveSummary(head: ChatRow[]): string {
  const lines = head.map((m) => {
    const role = String(m.role || "");
    const content = typeof m.content === "string" ? m.content : "";
    const one = (role === "tool" ? stubToolContent(content, 160) : content)
      .replace(/\s+/g, " ")
      .slice(0, 240);
    return `- ${role}: ${one}`;
  });
  const body = `Extractive compact (no LLM available):\n${lines.join("\n")}`;
  return clip(body, SUMMARY_MAX_CHARS);
}

export function formatPinnedHistory(pins: {
  summary: string;
  lastDiff: string | null;
  lastPlan: string | null;
}): string {
  const chunks = [
    "Compacted conversation summary (source of truth for earlier turns; do not ask the user to repeat it):",
    clip(pins.summary.trim() || "(empty summary)", SUMMARY_MAX_CHARS),
  ];
  if (pins.lastDiff) {
    chunks.push("", "Last diff (preserved through compact):", pins.lastDiff);
  }
  if (pins.lastPlan) {
    chunks.push("", "Last plan (preserved through compact):", pins.lastPlan);
  }
  return chunks.join("\n");
}

export function messagesAfterCompactedUntil(
  messages: ChatRow[],
  compactedUntilMessageId: string,
): ChatRow[] {
  if (!compactedUntilMessageId) {
    return messages.filter((m) => !isCompactMarker(m));
  }
  const idx = messages.findIndex((m) => String(m.id || "") === compactedUntilMessageId);
  if (idx < 0) return messages.filter((m) => !isCompactMarker(m));
  return messages.slice(idx + 1).filter((m) => !isCompactMarker(m));
}

export function estimateMessagesTokens(rows: ChatRow[]): number {
  let chars = 0;
  for (const m of rows) {
    if (isCompactMarker(m)) {
      const meta = rec(m.metadata);
      chars += String(meta?.summary || "").length;
      chars += String(meta?.lastDiff || "").length;
      chars += String(meta?.lastPlan || "").length;
      continue;
    }
    const role = String(m.role || "");
    const content = typeof m.content === "string" ? m.content : "";
    if (role === "tool") chars += Math.min(content.length, TOOL_STUB_MAX_CHARS);
    else chars += content.length;
  }
  return Math.ceil(chars / 4);
}
```

- [ ] Crear `cli/src/llm/compact.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildCompactSource,
  extractLastDiff,
  extractLastPlan,
  extractiveSummary,
  isCompactMarker,
  messagesAfterCompactedUntil,
  renderRowForCompact,
  splitCompactWindow,
  stubToolContent,
  TOOL_STUB_MAX_CHARS,
} from "./compact";

const rows = [
  { id: "1", role: "user", content: "hola" },
  { id: "2", role: "assistant", content: "ok" },
  { id: "3", role: "tool", content: "g".repeat(5000), metadata: { toolName: "grep", status: "done" } },
  { id: "4", role: "user", content: "sigue", metadata: { attachments: [{ path: "old.ts", kind: "text", hydratedText: "OLDSECRET" }] } },
  { id: "5", role: "assistant", content: "plan x", metadata: { executionMode: "plan" } },
  { id: "6", role: "user", content: "aplica @src/a.ts", metadata: { attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "CURRENT_FULL" }] } },
];

describe("stubToolContent", () => {
  test("does not send megabytes of grep", () => {
    const s = stubToolContent("x".repeat(50_000));
    expect(s.length).toBeLessThan(TOOL_STUB_MAX_CHARS + 80);
    expect(s).toMatch(/omitted after compact/);
  });
});

describe("splitCompactWindow", () => {
  test("excludes current user message from head (attaches stay out of summary)", () => {
    const w = splitCompactWindow(rows, { excludeIds: new Set(["6"]), keepRecent: 2 });
    expect(w.head.some((m) => m.id === "6")).toBe(false);
    expect(w.tooShort).toBe(false);
    const src = buildCompactSource(w.head);
    expect(src).not.toMatch(/CURRENT_FULL/);
    expect(src).toMatch(/omitted after compact|OLDSECRET|sigue/);
  });
  test("too short chat", () => {
    const w = splitCompactWindow(rows.slice(0, 2));
    expect(w.tooShort).toBe(true);
    expect(w.head).toEqual([]);
  });
});

describe("renderRowForCompact", () => {
  test("stubs tools and historical attaches", () => {
    const tool = renderRowForCompact(rows[2]!);
    expect(tool).toMatch(/^TOOL grep/);
    expect(tool.length).toBeLessThan(600);
    const old = renderRowForCompact(rows[3]!);
    expect(old).toMatch(/omitted after compact/);
    expect(old).not.toMatch(/OLDSECRET/);
  });
});

describe("pins", () => {
  test("last plan from executionMode", () => {
    expect(extractLastPlan(rows)).toBe("plan x");
  });
  test("last diff from sidecar", () => {
    const d = extractLastDiff(rows, [
      { path: "src/a.ts", kind: "modified", status: "applied", additions: 3, deletions: 1, preview: "+ hi" },
    ]);
    expect(d).toMatch(/src\/a\.ts/);
    expect(d).toMatch(/\+ hi/);
  });
  test("missing pins are null, compact still possible", () => {
    expect(extractLastDiff([{ id: "1", role: "user", content: "x" }])).toBeNull();
    expect(extractLastPlan([{ id: "1", role: "user", content: "x" }])).toBeNull();
  });
});

describe("marker window", () => {
  test("messages after compactedUntil keep the current attach", () => {
    const tail = messagesAfterCompactedUntil(rows, "5");
    expect(tail.map((m) => m.id)).toEqual(["6"]);
    expect(String(tail[0]!.metadata?.attachments?.[0]?.hydratedText)).toBe("CURRENT_FULL");
  });
  test("isCompactMarker", () => {
    expect(isCompactMarker({ metadata: { kind: "compact_marker" } })).toBe(true);
    expect(isCompactMarker({ role: "system", content: "contexto compactado" })).toBe(false);
  });
});

describe("extractiveSummary", () => {
  test("does not include full grep", () => {
    const s = extractiveSummary([rows[2]!]);
    expect(s.length).toBeLessThan(500);
    expect(s).not.toMatch(/g{1000}/);
  });
});
```

Corregir el acceso a `attachments` en el test `messages after compactedUntil` si TS se queja: leer `metadata` como `Record<string, unknown>`.

- [ ] Reescribir `cli/src/llm/history.ts` para respetar el marcador. Conservar `formatUserContentForHistory` **si attach-files ya la añadió**; si no existe, incluirla aquí (snapshot, no releer disco). Sustituir el recorte silencioso `while (sliced.length > 1 && total > MAX_HISTORY_CHARS)` como camino principal.

Dejar `MAX_HISTORY_MESSAGES` / `MAX_HISTORY_CHARS` exportados pero **ya no** recortar en silencio cuando hay marcador. Sin marcador, `historyFromChatMessages` sigue devolviendo el texto (el caller en Task 4 compacta si el presupuesto se pasa). Un backstop duro: si un único mensaje de cola supera `MAX_HISTORY_CHARS`, recortar **ese** mensaje de cola con marca `[truncated: showing N of M chars]` — nunca borrar el summary ni los pins.

```ts
import { formatPinnedHistory, isCompactMarker, lastCompactMarker, messagesAfterCompactedUntil, stubToolContent } from "./compact";

export const MAX_HISTORY_MESSAGES = 40;
export const MAX_HISTORY_CHARS = 100_000;

export type HistoryRole = "user" | "assistant" | "system";
export type HistoryMessage = { role: HistoryRole; content: string };

type DbMessage = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

const TEXT_ROLES = new Set<HistoryRole>(["user", "assistant", "system"]);

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

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
    if ((kind === "text" || kind === "directory") && typeof a.hydratedText === "string") {
      return `\n\n[attached ${attPath} — snapshot, not re-read from disk]\n${a.hydratedText}`;
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

function rowToHistory(m: DbMessage): HistoryMessage | null {
  if (isCompactMarker(m)) return null;
  const role = String(m.role || "");
  if (role === "tool") {
    const content = stubToolContent(typeof m.content === "string" ? m.content : "");
    if (!content.trim()) return null;
    return { role: "system", content: `Earlier tool result (stubbed, not re-executed):\n${content}` };
  }
  if (!TEXT_ROLES.has(role as HistoryRole)) return null;
  const raw = typeof m.content === "string" ? m.content : "";
  const content =
    role === "user" ? formatUserContentForHistory(raw, m.metadata) : raw;
  if (!content.trim()) return null;
  return { role: role as HistoryRole, content };
}

export function historyFromChatMessages(
  messages: DbMessage[],
  currentPrompt: string,
): HistoryMessage[] {
  const marker = lastCompactMarker(messages);
  const meta = rec(marker?.metadata);
  const until =
    typeof meta?.compactedUntilMessageId === "string"
      ? meta.compactedUntilMessageId
      : "";

  const tailRows = marker
    ? messagesAfterCompactedUntil(messages, until)
    : messages.filter((m) => !isCompactMarker(m));

  const text: HistoryMessage[] = [];
  if (marker && typeof meta?.summary === "string") {
    text.push({
      role: "system",
      content: formatPinnedHistory({
        summary: meta.summary,
        lastDiff: typeof meta.lastDiff === "string" ? meta.lastDiff : null,
        lastPlan: typeof meta.lastPlan === "string" ? meta.lastPlan : null,
      }),
    });
  }

  for (const m of tailRows) {
    const row = rowToHistory(m);
    if (row) text.push(row);
  }

  if (
    text.length > 0 &&
    text[text.length - 1]!.role === "user" &&
    (text[text.length - 1]!.content === currentPrompt ||
      text[text.length - 1]!.content.startsWith(currentPrompt))
  ) {
    text.pop();
  }

  return text;
}

export function promptWithHistory(prompt: string, history: HistoryMessage[]): string {
  if (history.length === 0) return prompt;
  const prior = history.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
  return [
    "Previous conversation in this chat (source of truth; use it to stay consistent):",
    "",
    prior,
    "",
    "---",
    "",
    "Current user message:",
    prompt,
  ].join("\n");
}

export function composedPromptTokens(prompt: string, history: HistoryMessage[]): {
  text: string;
  chars: number;
} {
  const text = promptWithHistory(prompt, history);
  return { text, chars: text.length };
}
```

Nota: incluir tools de la **cola** como stub `system` (no `tool_use`). Gherkin: no se reenvían enteras y no se re-ejecutan. Si el plan 2 dependía de tirar tools por completo, este stub de 400 chars es estrictamente más chico que reenviar el grep y no dispara el SDK. No reconstruir bloques `tool_use`/`tool_result`.

- [ ] Tests de history (`cli/src/llm/history.test.ts`), **añadir**:

```ts
import { describe, expect, test } from "bun:test";
import { historyFromChatMessages, promptWithHistory } from "./history";

describe("historyFromChatMessages compact", () => {
  test("after marker, old tools and old attaches are not in the prompt; current attach is", () => {
    const hist = historyFromChatMessages(
      [
        { id: "1", role: "user", content: "old", metadata: { attachments: [{ path: "old.ts", kind: "text", hydratedText: "OLD_BODY" }] } },
        { id: "2", role: "tool", content: "MEGAGREP".repeat(2000), metadata: { toolName: "grep" } },
        { id: "3", role: "assistant", content: "did grep" },
        {
          id: "c",
          role: "system",
          content: "contexto compactado",
          metadata: {
            kind: "compact_marker",
            summary: "User asked to search. Grep already ran.",
            compactedUntilMessageId: "3",
            lastDiff: "src/a.ts +3 −1",
            lastPlan: "1. apply patch",
          },
        },
        {
          id: "4",
          role: "user",
          content: "usa @src/a.ts",
          metadata: {
            attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "CURRENT_FULL" }],
          },
        },
      ],
      "next",
    );
    const blob = hist.map((h) => h.content).join("\n");
    expect(blob).toMatch(/User asked to search/);
    expect(blob).toMatch(/src\/a\.ts \+3/);
    expect(blob).toMatch(/1\. apply patch/);
    expect(blob).toMatch(/CURRENT_FULL/);
    expect(blob).not.toMatch(/OLD_BODY/);
    expect(blob).not.toMatch(/MEGAGREPMEGAGREP/);
  });

  test("current prompt is not duplicated", () => {
    const hist = historyFromChatMessages(
      [
        { id: "1", role: "user", content: "hola" },
        { id: "2", role: "assistant", content: "ok" },
        { id: "3", role: "user", content: "ahora" },
      ],
      "ahora",
    );
    expect(hist.map((h) => h.content)).not.toContain("ahora");
    expect(promptWithHistory("ahora", hist)).toMatch(/Current user message:\nahora/);
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/compact.test.ts src/llm/history.test.ts
```

Esperado: todos pasan. El caso de attach-files (snapshot, no disk reread) sigue verde si existía.

- [ ] Commit:

```bash
git add cli/src/llm/compact.ts cli/src/llm/compact.test.ts \
  cli/src/llm/history.ts cli/src/llm/history.test.ts
git commit -m "feat(context): compact window, tool stubs, pinned diff/plan, marker-aware history"
```

---

## Task 3: Runner de compact — resumen LLM sin tools

**Files:**

- Create: `cli/src/llm/compact-run.ts`
- Test: `cli/src/llm/compact-run.test.ts`
- Modify: `cli/src/llm/claude-runner.ts`

El summarizer es un `query()` **aislado**: no es un turn de producto, no appendea user/assistant, no ejecuta tools, no toca el cwd.

- [ ] En `cli/src/llm/claude-runner.ts`, cuando `type === "result"` y `subtype !== "success"`, lanzar con el texto de error del SDK (no tragárselo como `"Claude no devolvió un resultado de éxito"`). Conservar el throw actual si no hay `finalResult` **y** no hubo error tipado:

```ts
if (type === "result" && subtype && subtype !== "success") {
  const errText = String(
    (msg as { errors?: unknown; error?: unknown; result?: unknown }).error ??
      (msg as { result?: unknown }).result ??
      subtype,
  );
  throw new Error(errText || "Claude result error");
}
```

- [ ] Crear `cli/src/llm/compact-run.ts`. Importar `query` igual que `claude-runner.ts`. Reutilizar `buildEnv` **no** está exportado: duplicar las 15 líneas de env (oauth vs api_key) o extraer `buildClaudeEnv` en `claude-runner.ts` y exportarlo. Preferir extraer para no divergir.

Si extraes, en `claude-runner.ts`:

```ts
export function buildClaudeEnv(auth: ClaudeAuth): Record<string, string> {
  // mismo cuerpo que buildEnv actual + filtro undefined
}
```

`runClaudeTurn` pasa a usar `buildClaudeEnv`.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAuth } from "./claude-runner";
import { buildClaudeEnv } from "./claude-runner";
import {
  buildCompactSource,
  buildSummarizerPrompt,
  extractLastDiff,
  extractLastPlan,
  extractiveSummary,
  splitCompactWindow,
  SUMMARY_MAX_CHARS,
  type ChatRow,
  type CompactTrigger,
} from "./compact";

export type CompactRunInput = {
  messages: ChatRow[];
  trigger: CompactTrigger;
  /** Current user message id — overflow path. Never summarized. */
  excludeMessageIds?: string[];
  sidecarDiffs?: Array<Record<string, unknown>> | null;
  model: string;
  cwd: string;
  auth: ClaudeAuth | null;
  /** When false, skip LLM and use extractiveSummary. */
  llmEnabled: boolean;
};

function denyAllTools(): { behavior: "deny"; message: string } {
  return {
    behavior: "deny",
    message: "Compact summarizer cannot run tools",
  };
}

export async function summarizeForCompact(input: CompactRunInput): Promise<{
  summary: string;
  lastDiff: string | null;
  lastPlan: string | null;
  compactedUntilMessageId: string;
  compactedMessageCount: number;
  tooShort: boolean;
  method: "llm" | "extractive";
}> {
  const window = splitCompactWindow(input.messages, {
    excludeIds: new Set(input.excludeMessageIds ?? []),
  });
  const lastDiff = extractLastDiff(input.messages, input.sidecarDiffs);
  const lastPlan = extractLastPlan(input.messages);
  if (window.tooShort) {
    return {
      summary: "",
      lastDiff,
      lastPlan,
      compactedUntilMessageId: window.compactedUntilMessageId,
      compactedMessageCount: 0,
      tooShort: true,
      method: "extractive",
    };
  }

  const source = buildCompactSource(window.head);
  let summary = extractiveSummary(window.head);
  let method: "llm" | "extractive" = "extractive";

  if (input.llmEnabled && input.auth) {
    const prompt = buildSummarizerPrompt(source, { lastDiff, lastPlan });
    const env = buildClaudeEnv(input.auth);
    let text = "";
    try {
      for await (const message of query({
        prompt,
        options: {
          model: input.model,
          cwd: input.cwd,
          env,
          settingSources: [],
          tools: [],
          allowedTools: [],
          permissionMode: "default",
          canUseTool: async () => denyAllTools(),
        } as never,
      })) {
        const msg = message as Record<string, unknown>;
        if (String(msg.type || "") === "result" && String(msg.subtype || "") === "success") {
          if (typeof msg.result === "string") text = msg.result;
        }
      }
    } catch {
      text = "";
    }
    if (text.trim()) {
      summary = text.trim().slice(0, SUMMARY_MAX_CHARS);
      method = "llm";
    }
  }

  return {
    summary,
    lastDiff,
    lastPlan,
    compactedUntilMessageId: window.compactedUntilMessageId,
    compactedMessageCount: window.compactedMessageCount,
    tooShort: false,
    method,
  };
}
```

Cursor: **no** importar `./cursor-runner` en estático. Si el plan 4 ya existe y exporta `summarizeCursorCompact`, se puede añadir **después** del bloque Claude, con dynamic import:

```ts
if (method === "extractive" && input.llmEnabled) {
  try {
    const mod = await import("./cursor-runner");
    const fn = (mod as { summarizeCursorCompact?: Function }).summarizeCursorCompact;
    if (typeof fn === "function") {
      const t = await fn({ prompt: buildSummarizerPrompt(source, { lastDiff, lastPlan }), cwd: input.cwd, model: input.model });
      if (typeof t === "string" && t.trim()) {
        summary = t.trim().slice(0, SUMMARY_MAX_CHARS);
        method = "llm";
      }
    }
  } catch {
    // cursor-runner absent — keep extractive/claude
  }
}
```

Solo si el archivo `cli/src/llm/cursor-runner.ts` existe. Si no, omitir el bloque. Nunca `Agent.create({ cloud })`.

- [ ] Crear `cli/src/llm/compact-run.test.ts`. **No** pegarse a la red. Mockear `query`:

```ts
import { describe, expect, mock, test } from "bun:test";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: async function* () {
    yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", id: "t1", input: { pattern: "x" } }] } };
    yield { type: "result", subtype: "success", result: "SUMMARY_OK: searched src/ and planned apply." };
  },
}));

mock.module("./claude-runner", () => ({
  buildClaudeEnv: () => ({ ANTHROPIC_API_KEY: "x" }),
}));

import { summarizeForCompact } from "./compact-run";

const messages = [
  { id: "1", role: "user", content: "busca foo" },
  { id: "2", role: "tool", content: "match".repeat(5000), metadata: { toolName: "grep" } },
  { id: "3", role: "assistant", content: "encontré foo" },
  { id: "4", role: "user", content: "sigue" },
  { id: "5", role: "assistant", content: "ok" },
  {
    id: "6",
    role: "user",
    content: "mira @src/a.ts",
    metadata: { attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "CURRENT_FULL" }] },
  },
];

describe("summarizeForCompact", () => {
  test("LLM path returns summary and does not include current attach in source window", async () => {
    const out = await summarizeForCompact({
      messages,
      trigger: "manual",
      excludeMessageIds: ["6"],
      sidecarDiffs: [
        { path: "src/a.ts", kind: "modified", status: "applied", additions: 1, deletions: 0, preview: "+ x" },
      ],
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      auth: { authKind: "api_key", secret: "sk-test" },
      llmEnabled: true,
    });
    expect(out.tooShort).toBe(false);
    expect(out.summary).toMatch(/SUMMARY_OK/);
    expect(out.lastDiff).toMatch(/src\/a\.ts/);
    expect(out.compactedUntilMessageId).not.toBe("6");
  });

  test("extractive path when llm disabled — still no tool re-exec (no fs)", async () => {
    const out = await summarizeForCompact({
      messages,
      trigger: "overflow",
      excludeMessageIds: ["6"],
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      auth: null,
      llmEnabled: false,
    });
    expect(out.method).toBe("extractive");
    expect(out.summary).toMatch(/Extractive compact/);
    expect(out.summary).not.toMatch(/CURRENT_FULL/);
  });
});
```

El mock de `query` **no** ejecuta Grep: el runner no procesa `tool_use` del stream para compact (ignora bloques; solo lee `result`). Añadir un test extra si querés: spy de `canUseTool` — si el SDK lo llamara, `denyAllTools` niega. No hace falta un spy de `fs.writeFile`: el módulo no lo importa.

Si `mock.module` de `claude-runner` rompe el type `ClaudeAuth`, importar el type desde un `types` inline en el test (`auth: { authKind: "api_key", secret: "sk-test" } as const` y castear).

- [ ] Correr:

```bash
cd cli && bun test src/llm/compact-run.test.ts src/llm/claude-runner.ts
```

(`claude-runner.ts` puede no tener tests; el comando no debe fallar el resto.) Esperado: compact-run tests pasan.

- [ ] Commit:

```bash
git add cli/src/llm/compact-run.ts cli/src/llm/compact-run.test.ts \
  cli/src/llm/claude-runner.ts
git commit -m "feat(context): compact summarizer with tools denied and extractive fallback"
```

---

## Task 4: `publishAgentTurn` — aviso, auto-compact, retry una vez

**Files:**

- Modify: `cli/src/llm/publish-turn.ts`
- Create: `cli/src/llm/publish-turn-compact.test.ts`
- Modify: `cli/src/ws/daemon.ts`

El turn siguiente **no falla en silencio**. Overflow → compact + un retry o `COMPACT_OVERFLOW_ERROR` persistido en `chat.stream.error`.

- [ ] Añadir en `cli/src/llm/publish-turn.ts` (extender, no reescribir el stream/tool loop):

Importar `historyFromChatMessages`, `composedPromptTokens` / `promptWithHistory`, `estimateTokens`, `measureContextUsage`, `isContextOverflowError`, `COMPACT_OVERFLOW_ERROR`, `modelContextWindow` (catálogo), `summarizeForCompact`, `COMPACT_MARKER_KIND`, `COMPACT_MARKER_LABEL`, `formatContextBanner`.

Leer `activeProvider` / `activeModel` como ya se hace. `windowTokens = modelContextWindow(provider, model)`.

Helpers internos (mismo archivo o `cli/src/llm/compact-apply.ts` si supera ~80 líneas extra; preferir `compact-apply.ts` para testear sin WS):

Crear `cli/src/llm/compact-apply.ts`:

```ts
import {
  COMPACT_MARKER_KIND,
  COMPACT_MARKER_LABEL,
  COMPACT_NO_HISTORY,
  estimateTokens,
  measureContextUsage,
  type ContextUsage,
} from "./context-budget";
import type { CompactMarkerMeta, CompactTrigger } from "./compact";
import { summarizeForCompact } from "./compact-run";
import { historyFromChatMessages, promptWithHistory } from "./history";
import { modelContextWindow } from "./catalog";
import type { ClaudeAuth } from "./claude-runner";

export type CompactClient = {
  request: (msg: Record<string, unknown>, timeoutMs?: number) => Promise<{
    ok: boolean;
    error?: string;
    data?: unknown;
  }>;
};

export async function loadChatRows(client: CompactClient, chatId: string): Promise<{
  messages: Array<{
    id?: string;
    role?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
  }>;
  diffs?: Array<Record<string, unknown>>;
}> {
  const chatRes = await client.request({ type: "chat.get", chatId });
  if (!chatRes.ok) throw new Error(chatRes.error || "chat.get failed");
  const data = (chatRes.data || {}) as {
    messages?: Array<{ id?: string; role?: string; content?: string; metadata?: Record<string, unknown> | null }>;
    diffs?: Array<Record<string, unknown>>;
  };
  return { messages: data.messages ?? [], diffs: data.diffs };
}

export function usageFromPrompt(input: {
  prompt: string;
  messages: Array<{ id?: string; role?: string; content?: string; metadata?: Record<string, unknown> | null }>;
  modelId: string;
  providerId: string;
}): { usage: ContextUsage; composed: string } {
  const history = historyFromChatMessages(input.messages, input.prompt);
  const composed = promptWithHistory(input.prompt, history);
  const usedTokens = estimateTokens(composed);
  const windowTokens = modelContextWindow(input.providerId, input.modelId);
  return {
    composed,
    usage: measureContextUsage({
      usedTokens,
      windowTokens,
      modelId: input.modelId,
      providerId: input.providerId,
    }),
  };
}

export async function applyCompact(input: {
  client: CompactClient;
  chatId: string;
  cwd: string;
  trigger: CompactTrigger;
  excludeMessageIds?: string[];
  model: string;
  providerId: string;
  auth: ClaudeAuth | null;
  llmEnabled: boolean;
  usedTokensBefore?: number;
}): Promise<{
  skipped: boolean;
  reason?: string;
  message?: Record<string, unknown>;
  usage: ContextUsage;
}> {
  const { messages, diffs } = await loadChatRows(input.client, input.chatId);
  const result = await summarizeForCompact({
    messages,
    trigger: input.trigger,
    excludeMessageIds: input.excludeMessageIds,
    sidecarDiffs: diffs ?? null,
    model: input.model,
    cwd: input.cwd,
    auth: input.auth,
    llmEnabled: input.llmEnabled,
  });
  const afterMessages = messages; // marker not yet appended
  const dummyPrompt = "";
  const before = usageFromPrompt({
    prompt: dummyPrompt,
    messages: afterMessages,
    modelId: input.model,
    providerId: input.providerId,
  }).usage;

  if (result.tooShort) {
    return { skipped: true, reason: COMPACT_NO_HISTORY, usage: before };
  }

  const meta: CompactMarkerMeta = {
    kind: COMPACT_MARKER_KIND,
    trigger: input.trigger,
    summary: result.summary,
    compactedUntilMessageId: result.compactedUntilMessageId,
    lastDiff: result.lastDiff,
    lastPlan: result.lastPlan,
    compactedMessageCount: result.compactedMessageCount,
    usedTokensBefore: input.usedTokensBefore ?? before.usedTokens,
    usedTokensAfter: 0,
    modelId: input.model,
    providerId: input.providerId,
  };

  const append = await input.client.request({
    type: "chat.append",
    chatId: input.chatId,
    role: "system",
    content: COMPACT_MARKER_LABEL,
    metadata: meta,
  });
  if (!append.ok) throw new Error(append.error || "chat.append compact marker failed");

  const reloaded = await loadChatRows(input.client, input.chatId);
  const after = usageFromPrompt({
    prompt: dummyPrompt,
    messages: reloaded.messages,
    modelId: input.model,
    providerId: input.providerId,
  }).usage;

  const message = (append.data as { message?: Record<string, unknown> })?.message;
  if (message && message.metadata && typeof message.metadata === "object") {
    (message.metadata as CompactMarkerMeta).usedTokensAfter = after.usedTokens;
  }
  return { skipped: false, message, usage: after };
}
```

- [ ] En `publishAgentTurn`, **después** de `chat.get` + history y **antes** de `runClaudeTurn`:

1. `const { usage } = usageFromPrompt({ prompt, messages: dbMessages, modelId: model, providerId: providers.activeProvider || "claude" })`.
2. `await client.request({ type: "chat.context.report", chatId, metadata: usage })` — si el tipo aún no existe en API (Task 5), **también** emitir vía `chat.append` no: no ensuciar el chat. Si `chat.context.report` falla con unknown type, ignorar (`ok === false` no aborta el turn). Task 5 lo implementa.
3. Si `usage.level === "critical" || usage.usedTokens > usage.budgetTokens`: `await applyCompact({ trigger: "overflow", excludeMessageIds: [lastUserId], ... })` con `lastUserId` = id del último `role=user` (el prompt actual ya appendeado). Recargar messages. `compactedThisTurn = true`.
4. Reconstruir history / prompt.
5. `try { runClaudeTurn(...) } catch (err)`:
   - si `isContextOverflowError(err) && !compactedThisTurn`: `applyCompact` overflow, recargar, `compactedThisTurn = true`, **un** `runClaudeTurn` más.
   - si `isContextOverflowError(err)` ya compactado: `throw new Error(COMPACT_OVERFLOW_ERROR)`.
   - else rethrow.
6. El `catch` existente que hace `chat.stream.error` se queda: el mensaje será `COMPACT_OVERFLOW_ERROR` u otro. Nunca `return` sin `stream.error` en fallo.

Cursor: si `publishAgentTurn` ya ramifica a `runCursorTurn` (plan 4), el mismo `try/catch` envuelve ambas llamadas. No duplicar la política de retry.

Auth para compact: el mismo `creds` Claude si está linked; si el provider activo es cursor y no hay Claude, `auth: null` + `llmEnabled: false` (extractive). No fallar el compact por falta de Claude si se puede extraer.

- [ ] Tests `cli/src/llm/publish-turn-compact.test.ts` contra `usageFromPrompt` + `applyCompact` con un fake client:

```ts
import { describe, expect, mock, test } from "bun:test";

mock.module("./compact-run", () => ({
  summarizeForCompact: async () => ({
    summary: "sum",
    lastDiff: "d",
    lastPlan: "p",
    compactedUntilMessageId: "3",
    compactedMessageCount: 3,
    tooShort: false,
    method: "extractive",
  }),
}));

import { applyCompact, usageFromPrompt } from "./compact-apply";
import { COMPACT_NO_HISTORY } from "./context-budget";

describe("applyCompact", () => {
  test("appends compact_marker and does not call tools", async () => {
    const calls: string[] = [];
    const messages = [
      { id: "1", role: "user", content: "a" },
      { id: "2", role: "assistant", content: "b" },
      { id: "3", role: "user", content: "c" },
      { id: "4", role: "assistant", content: "d" },
    ];
    const client = {
      request: async (msg: Record<string, unknown>) => {
        calls.push(String(msg.type));
        if (msg.type === "chat.get") return { ok: true, data: { messages } };
        if (msg.type === "chat.append") {
          messages.push({
            id: "c1",
            role: "system",
            content: String(msg.content),
            metadata: msg.metadata as never,
          });
          return { ok: true, data: { message: messages[messages.length - 1] } };
        }
        return { ok: true, data: {} };
      },
    };
    const out = await applyCompact({
      client,
      chatId: "chat",
      cwd: "/tmp",
      trigger: "manual",
      model: "claude-sonnet-4-6",
      providerId: "claude",
      auth: null,
      llmEnabled: false,
    });
    expect(out.skipped).toBe(false);
    expect(calls).toContain("chat.append");
    expect(calls.every((t) => t === "chat.get" || t === "chat.append")).toBe(true);
    expect(String((messages.at(-1) as { content?: string }).content)).toBe("contexto compactado");
  });
});

describe("usageFromPrompt", () => {
  test("grows with history", () => {
    const small = usageFromPrompt({
      prompt: "hi",
      messages: [],
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    const big = usageFromPrompt({
      prompt: "hi",
      messages: [{ role: "user", content: "x".repeat(20_000) }, { role: "assistant", content: "y".repeat(20_000) }],
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(big.usage.usedTokens).toBeGreaterThan(small.usage.usedTokens);
  });
});
```

Añadir un test `tooShort → skipped` con 2 mensajes y `expect(out.reason).toBe(COMPACT_NO_HISTORY)`.

- [ ] En `cli/src/ws/daemon.ts`, el `onPush` debe atender **también** `chat.compact.dispatch` (el cuerpo se completa en Task 5 junto al handler API; aquí dejar el branch que setea `turnBusy`, llama `applyCompact`, y envía `chat.compact.result`). Si `turnBusy` → log y `chat.compact.result` con `ok: false, error: "Turn already running on this daemon"`.

Esqueleto (usar `config.accessToken`, `path`, `client` existentes):

```ts
if (msg.type === "chat.compact.dispatch") {
  const data = (msg.data || {}) as {
    chatId?: string;
    requestId?: string;
    path?: string;
    trigger?: "manual" | "overflow";
  };
  if (!data.chatId || !data.requestId) return;
  if (turnBusy) {
    await client.request({
      type: "chat.compact.result",
      requestId: data.requestId,
      chatId: data.chatId,
      metadata: { ok: false, error: "Turn already running on this daemon" },
    });
    return;
  }
  turnBusy = true;
  try {
    const providers = await apiFetch<ProvidersResponse>("/providers", {}, config.accessToken);
    // creds Claude si linked; si no, auth null
    const out = await applyCompact({
      client,
      chatId: data.chatId,
      cwd: data.path || path,
      trigger: data.trigger || "manual",
      model: providers.activeModel || "claude-sonnet-4-6",
      providerId: providers.activeProvider || "claude",
      auth: /* creds or null */,
      llmEnabled: Boolean(/* claude linked */),
    });
    await client.request({
      type: "chat.compact.result",
      requestId: data.requestId,
      chatId: data.chatId,
      metadata: { ok: true, skipped: out.skipped, reason: out.reason, context: out.usage },
    });
  } catch (err) {
    await client.request({
      type: "chat.compact.result",
      requestId: data.requestId,
      chatId: data.chatId,
      metadata: { ok: false, error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    turnBusy = false;
  }
  return;
}
```

Importar `apiFetch` y el type de providers (ya usados en `publish-turn.ts`). No copiar el secret a logs.

- [ ] Correr:

```bash
cd cli && bun test src/llm/publish-turn-compact.test.ts src/llm/compact.test.ts src/llm/history.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/compact-apply.ts cli/src/llm/publish-turn.ts \
  cli/src/llm/publish-turn-compact.test.ts cli/src/ws/daemon.ts
git commit -m "feat(context): auto-compact on overflow with single retry and daemon compact dispatch"
```

---

## Task 5: API — `chat.compact`, `chat.context.usage`, `chat.get` con presupuesto

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Create: `api/src/ws/pending.ts` (solo si attach-files **no** lo creó; idéntico a attach-files Task 3)
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/routes/providers.ts` (exponer `contextWindowTokens` en cada modelo del GET `/providers` — ya viaja si el catálogo lo tiene)
- Test: `api/src/llm/context-chat.test.ts`

- [ ] En `api/src/ws/protocol.ts`, extender `ClientMessage` con `requestId?: string` si no está. No quitar campos.

- [ ] Si `api/src/ws/pending.ts` no existe, crearlo **idéntico** al de attach-files (`createPendingMap(timeoutMs)`). En `handlers.ts`:

```ts
const compactPending = createPendingMap(90_000);
```

Timeout 90s = `COMPACT_TIMEOUT_MS`. El fail de timeout usa el string no-daemon de `createPendingMap` **solo si** el mapa clava ese string; es aceptable (el cliente ve que el daemon no contestó). Si preferís un mapa que acepte el error, no lo cambies: no inventar un tercer helper.

- [ ] Helper `contextForMessages` en `api/src/llm/context-chat.ts` (para no importar CLI):

```ts
import {
  COMPACT_MARKER_KIND,
  measureContextUsage,
  type ContextUsage,
} from "./context-budget";
import { modelContextWindow } from "./catalog";

type Row = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

function isMarker(m: Row): boolean {
  return Boolean(m.metadata && (m.metadata as { kind?: string }).kind === COMPACT_MARKER_KIND);
}

function addRowChars(m: Row): number {
  const role = String(m.role || "");
  const content = typeof m.content === "string" ? m.content : "";
  return role === "tool" ? Math.min(content.length, 400) : content.length;
}

export function contextForMessages(
  messages: Row[],
  providerId: string,
  modelId: string,
): ContextUsage {
  let chars = 0;
  const lastMarker = [...messages].reverse().find(isMarker);
  if (lastMarker?.metadata && typeof lastMarker.metadata === "object") {
    const meta = lastMarker.metadata as Record<string, unknown>;
    chars += String(meta.summary || "").length;
    chars += String(meta.lastDiff || "").length;
    chars += String(meta.lastPlan || "").length;
    const until = String(meta.compactedUntilMessageId || "");
    const start = until ? messages.findIndex((m) => m.id === until) : -1;
    const tail = start >= 0 ? messages.slice(start + 1) : messages;
    for (const m of tail) {
      if (isMarker(m)) continue;
      chars += addRowChars(m);
    }
  } else {
    for (const m of messages) chars += addRowChars(m);
  }
  return measureContextUsage({
    usedTokens: Math.ceil(chars / 4),
    windowTokens: modelContextWindow(providerId, modelId),
    modelId,
    providerId,
  });
}
```

Cargar prefs del user en handlers/HTTP: `user_preferences.activeProvider` / `activeModel`, default `claude` + primer modelo del catálogo. `estimateTokens` del módulo es `ceil(chars/4)`; aquí se usa el equivalente directo para no materializar un string enorme.

Cargar prefs del user en handlers/HTTP: `user_preferences.activeProvider` / `activeModel`, default `claude` + primer modelo del catálogo.

- [ ] Test `api/src/llm/context-chat.test.ts`: mensajes cortos → `level === "ok"`; un tool de 200k chars no dispara `critical` porque se stubbea a 400.

- [ ] En `api/src/ws/handlers.ts`:

  1. `chat.get`: además de `{ chat, messages }`, incluir `context: contextForMessages(...)` y `diffs` **solo si** el handler de diffs-review ya los añade (no inventar la tabla).
  2. Nuevo case `chat.context.report` (lo manda el daemon): `{ chatId, metadata: ContextUsage }`. Validar chat del user. `broadcast(userId, "chat.context.usage", { chatId, context: msg.metadata })`. Responder `ok`.
  3. Nuevo case `chat.compact` **antes** de `agent.turn.request`:
     - `chatId` obligatorio.
     - `workspaceIdForChat`; chat missing → `Chat not found`.
     - `hub.findDaemon`; si no → `fail` con `NO_DAEMON_ERROR` (el string exacto).
     - `daemon.turnBusy` **no existe en el hub hoy**. No inventar un flag en el hub: el daemon responde `TURN_BUSY_ERROR` en `chat.compact.result`.
     - `hub.sendTo(daemon.connectionId, hub.pushEvent("chat.compact.dispatch", { chatId, requestId: id, requesterConnectionId: connectionId, path: workspace?.path || daemon.path, trigger: "manual" }))`.
     - Si `!sent` → `Daemon connection unavailable`.
     - `return await compactPending.wait(id, type)`.
  4. Nuevo case `chat.compact.result`:
     - Requiere `msg.requestId`.
     - `meta = msg.metadata || {}`.
     - Si `meta.ok === false`: `compactPending.complete(requestId, fail("chat.compact", requestId, String(meta.error || "compact failed")))`.
     - Si skipped: `complete` con `ok(true, { skipped: true, reason, context })` **sin** broadcast de marcador.
     - Si éxito: recargar último system compact_marker del chat (el daemon ya hizo `chat.append`, que ya broadcast `message.appended`). Broadcast extra `chat.compact.done` `{ chatId, context: meta.context }` y `chat.context.usage`.
     - `complete` con `ok("chat.compact", requestId, { skipped: false, context: meta.context })`.
     - Responder al daemon `ok(type, id, { forwarded: true })`.

- [ ] En `api/src/routes/workspaces.ts` `GET /chats/:chatId`: incluir `context` con `contextForMessages` + prefs. Dejar `messages` igual. Si diffs-review ya añade `diffs`, no quitarlos.

- [ ] GET `/providers` ya serializa `models` del catálogo: al tener `contextWindowTokens` en `ModelInfo`, sale solo. Verificar que no hay un `map` que omita campos; si hay un pick explícito (`id`, `label`, `effortLevels`, …), **añadir** `contextWindowTokens`.

- [ ] Correr:

```bash
cd api && bun test src/llm/context-budget.test.ts src/llm/context-chat.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/handlers.ts api/src/ws/pending.ts \
  api/src/llm/context-chat.ts api/src/llm/context-chat.test.ts \
  api/src/routes/workspaces.ts api/src/routes/providers.ts
git commit -m "feat(context): chat.compact RPC and context usage on chat.get"
```

---

## Task 6: CLI headless `chat compact` + `watch`

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Modify: `cli/src/llm/watch-format.ts` (crear si agent-tools **no** lo creó; si existe, **añadir** branches)
- Test: `cli/src/llm/watch-format.test.ts` (crear o extender)

- [ ] En `cli/src/index.ts` `usage()`, añadir la línea:

```
  chavez headless chat compact <chatId>
```

junto a `ask|watch`.

- [ ] En `cli/src/commands/headless.ts`, grupo `chat`, nuevo action `compact`:

```ts
if (action === "compact") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: … chat compact <chatId>");
  const res = await client.request(
    { type: "chat.compact", chatId },
    90_000,
  );
  if (!res.ok) throw new Error(res.error);
  const data = (res.data || {}) as {
    skipped?: boolean;
    reason?: string;
    context?: { pct?: number; level?: string; usedTokens?: number; budgetTokens?: number };
  };
  if (data.skipped) {
    console.log(data.reason || "Nothing to compact — chat is already short.");
  } else {
    console.log("contexto compactado");
  }
  if (data.context) {
    console.log(
      `context ${data.context.usedTokens}/${data.context.budgetTokens} (${data.context.pct}%) ${data.context.level}`,
    );
  }
  return;
}
```

Timeout 90s. Sin TTY. El `finally` que cierra el client aplica (no es `watch`).

Actualizar el `throw new Error("Uso: chavez headless chat <create|list|append|get|ask|watch> …")` para incluir `compact`.

- [ ] `chat get`: si `res.data.context` existe, imprimir **además** del JSON (stderr o una línea antes):

```
context 12/191808 (0%) ok
```

y si `level !== "ok"` la línea de banner (`formatContextBanner`). El JSON completo se queda (scripts). El aviso no es silencio: stderr visible.

- [ ] Watch: si `cli/src/llm/watch-format.ts` **existe**, añadir:

```ts
if (msg.type === "chat.context.usage") {
  const ctx = rec(data.context) ?? rec(data.metadata) ?? data;
  const pct = ctx.pct ?? 0;
  const level = String(ctx.level || "");
  return `context · ${pct}% · ${level}`;
}
if (msg.type === "chat.compact.done") {
  return "compact · contexto compactado";
}
if (msg.type === "message.appended") {
  const message = rec(data.message);
  const meta = rec(message?.metadata);
  if (meta?.kind === "compact_marker") return "compact · contexto compactado";
}
```

Si `formatWatchLine` **no** existe, en `headless.ts` `watch` `onPush`, **además** del JSON (o en su lugar si plan 2 ya sustituyó), imprimir esas dos líneas cuando el type coincida. No volver a volcar megabytes: si plan 2 ya recorta, no revertirlo.

- [ ] Test mínimo de las líneas nuevas (en `watch-format.test.ts`):

```ts
test("context usage line", () => {
  expect(
    formatWatchLine({
      type: "chat.context.usage",
      data: { chatId: "c", context: { pct: 72, level: "warn" } },
    }),
  ).toBe("context · 72% · warn");
});
test("compact marker", () => {
  expect(
    formatWatchLine({
      type: "chat.compact.done",
      data: { chatId: "c" },
    }),
  ).toBe("compact · contexto compactado");
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/watch-format.test.ts src/llm/publish-turn-compact.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/llm/watch-format.ts cli/src/llm/watch-format.test.ts
git commit -m "feat(context): headless chat compact and watch context lines"
```

---

## Task 7: TUI — tecla `C`, `/compact`, banner, marcador

**Files:**

- Modify: `tui/src/App.tsx`

La TUI **es daemon**: debe ejecutar `applyCompact` en `chat.compact.dispatch` (igual que el headless) **y** disparar compact local con `C`.

- [ ] Ampliar `Message`:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna el array de `chat.get`; no filtrar `metadata`.

- [ ] Estado:

```ts
const [contextBanner, setContextBanner] = useState<string | null>(null);
```

Tras `chat.get`, si `data.context` existe, `setContextBanner(formatContextBanner(data.context))` (import desde `../../cli/src/llm/context-budget`).

- [ ] Importar `applyCompact` desde `../../cli/src/llm/compact-apply` y `apiFetch` (ya está). Extraer `runCompact(chatId: string)`:

```ts
const runCompact = useCallback(async (chatId: string) => {
  if (turnBusyRef.current) {
    setLog("Turn already running on this daemon");
    return;
  }
  turnBusyRef.current = true;
  setBusy(true);
  setLog("Compactando contexto…");
  try {
    const providers = await apiFetch<ProvidersResponse>("/providers", {}, token);
    const out = await applyCompact({
      client: client!,
      chatId,
      cwd,
      trigger: "manual",
      model: providers.activeModel || modelId,
      providerId: providers.activeProvider || provider,
      auth: null, // se rellena abajo si claude linked
      llmEnabled: Boolean(providers.providers?.claude?.linked),
    });
    if (out.skipped) setLog(out.reason || "Nothing to compact — chat is already short.");
    else setLog("contexto compactado");
    setContextBanner(formatContextBanner(out.usage));
    await loadChat(chatId);
  } catch (e) {
    setLog(e instanceof Error ? e.message : String(e));
  } finally {
    turnBusyRef.current = false;
    setBusy(false);
  }
}, [client, cwd, token, modelId, provider, loadChat]);
```

Rellenar `auth` igual que `publishAgentTurn` si Claude está linked (GET `/providers/claude/credentials`). Si el GET falla, `auth: null` + extractive; no crashear la TUI.

Si `applyCompact` exige `ClaudeAuth | null` y las credenciales, copiar el fetch de creds de `publish-turn.ts` a un helper interno de 10 líneas en el callback. No loguear el secret.

- [ ] `onPush`:
  - `chat.compact.dispatch`: si `data.chatId`, llamar `runCompact` **solo si** el dispatch no lo originó esta misma TUI (evitar doble compact). Distinguir: dispatch siempre viene de la API cuando *otro* cliente (Web/CLI) pidió compact. Esta TUI **es** el daemon: debe correrlo. `runCompact` ya toma el lock.
  - Tras compact por dispatch, responder `chat.compact.result` como el daemon headless (mismo payload). Extraer una función `handleCompactDispatch` compartida… no hay módulo TUI extra: duplicar el `client.request({ type: "chat.compact.result", ... })` al final de este branch. Alternativa más limpia: **mover** el handler de compact de `daemon.ts` a `cli/src/llm/compact-dispatch.ts` (`export async function handleCompactDispatch(client, data, cwd, token, busy)`) y llamarlo desde daemon **y** TUI. Hacer eso si ambos archivos crecerían igual. Firma:

```ts
export async function handleCompactDispatch(input: {
  client: CompactClient;
  data: { chatId?: string; requestId?: string; path?: string; trigger?: "manual" | "overflow" };
  cwd: string;
  token?: string;
  isBusy: () => boolean;
  setBusy: (v: boolean) => void;
}): Promise<void>
```

Usar `isBusy`/`setBusy` para `turnBusy` (daemon) y `turnBusyRef` (TUI). Un solo sitio con `applyCompact` + `chat.compact.result`.

- [ ] `onPush` `chat.context.usage` / `chat.compact.done` / `message.appended` con `kind === "compact_marker"`: `loadChat` + banner. Filtrar por `chatId === activeChatIdRef.current`.

- [ ] Teclado, modo command, **después** de las mutaciones bloqueadas por `busy` (compact **también** se bloquea si busy):

```ts
if (ch === "C" && activeChatId) {
  await runCompact(activeChatId);
  return;
}
```

`c` minúscula sigue creando chat. No cambiar eso.

- [ ] Compose `key.return`: si `text === "/compact"` (trim, case-insensitive):

```ts
setInput("");
setMode("command");
if (activeChatId) await runCompact(activeChatId);
return;
```

No llamar `sendWithLlm("/compact")`.

- [ ] Overflow: `sendWithLlm` ya pasa por `publishAgentTurn` (Task 4) — la TUI no duplica el retry. Tras el turn, `loadChat` refresca banner.

- [ ] Render:
  - Help line: añadir `[C] compact`.
  - Si `contextBanner`: `<Text color="yellow">{contextBanner}</Text>`.
  - Messages: si `m.metadata?.kind === "compact_marker"` (cast), pintar:

```
system: contexto compactado
```

en cyan, no el summary entero (el summary es para el LLM). `content` ya es `contexto compactado`.

- [ ] Commit:

```bash
git add tui/src/App.tsx cli/src/llm/compact-dispatch.ts cli/src/ws/daemon.ts
git commit -m "feat(context): TUI compact key, /compact, banner and marker"
```

Si no extrajiste `compact-dispatch.ts`, no lo listes en `git add`.

---

## Task 8: Web — banner, botón, marcador, `/compact`

**Files:**

- Create: `web/src/lib/context-budget.ts`
- Test: no hay runner de test en `web/package.json`; no añadir framework. La lógica duplicada es solo UI strings + `isCompactMarker`.
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`

Web **no** importa CLI. El presupuesto llega en `chat.get` / push; Web no estima.

- [ ] Crear `web/src/lib/context-budget.ts`:

```ts
export const COMPACT_MARKER_KIND = "compact_marker";
export const COMPACT_MARKER_LABEL = "contexto compactado";

export type ContextUsage = {
  usedTokens: number;
  budgetTokens: number;
  windowTokens: number;
  ratio: number;
  level: "ok" | "warn" | "critical";
  modelId: string;
  providerId: string;
  pct: number;
};

export function isCompactMarker(m: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  return m.metadata?.kind === COMPACT_MARKER_KIND;
}

export function formatContextBanner(usage: ContextUsage | null | undefined): string | null {
  if (!usage) return null;
  if (usage.level === "critical") {
    return `Contexto casi lleno (${usage.pct}%) — compacta antes del próximo turn`;
  }
  if (usage.level === "warn") {
    return `Contexto alto (${usage.pct}%) — considera compactar`;
  }
  return null;
}
```

Los strings **deben** coincidir con `cli/src/llm/context-budget.ts` (`CONTEXT_WARN_TEXT` / `CONTEXT_CRITICAL_TEXT`).

- [ ] En `web/src/lib/hooks.ts`, el query `useChat` ya pega a `GET /chats/:id`. Extender el type de retorno:

```ts
export type ChatDetail = {
  chat: Chat;
  messages: ChatMessage[];
  context?: ContextUsage;
  diffs?: unknown;
};
```

Importar `ContextUsage` desde `./context-budget`. No romper callers que leen `.messages`.

- [ ] En `web/src/lib/ws-hooks.ts`:

```ts
export function useWsChatCompact() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: { chatId: string }) =>
      ws.request({ type: "chat.compact", chatId: input.chatId }),
  });
}
```

Timeout: si `ws.request` acepta timeout, pasar `90_000`. Si no, el default del cliente; no bloquear el resto.

- [ ] `ChatDetailPanel.tsx`:

  1. `const compact = useWsChatCompact()`.
  2. Banner encima de `.messages`:

```tsx
{formatContextBanner(chat.data?.context) && (
  <p className="error" role="status">
    {formatContextBanner(chat.data?.context)}
  </p>
)}
```

Usar `error` para critical y una clase `muted`/`ok` no: warn y critical deben ser visibles. Si `level === "warn"` usar `className` que ya exista para avisos (p.ej. el `badge` amarillo no existe: `style={{ color: "var(--warn, #b45309)" }}` + `role="status"`). Critical: `className="error"`.

  3. En el `map` de messages, si `isCompactMarker(m)`:

```tsx
<div key={m.id} className="panel" style={{ marginBottom: "0.5rem" }}>
  <span className="badge ok">contexto compactado</span>
</div>
```

No pintar `metadata.summary` (puede ser largo). Title tooltip opcional `title={`${m.metadata.compactedMessageCount} msgs`}`.

  4. Botón en el panel “Enviar al agente”, al lado del submit, `type="button"`:

```tsx
<button
  type="button"
  className="secondary"
  disabled={compact.isPending || ws.status !== "open" || streaming}
  onClick={async () => {
    setMsg(null);
    try {
      const res = await compact.mutateAsync({ chatId });
      const data = (res.data || {}) as { skipped?: boolean; reason?: string };
      setMsg({
        kind: "ok",
        text: data.skipped
          ? data.reason || "Nothing to compact — chat is already short."
          : "contexto compactado",
      });
      void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }}
>
  {compact.isPending ? "Compactando…" : "Compactar contexto"}
</button>
```

  5. `onAgent`: si `prompt.trim().toLowerCase() === "/compact"`:

```ts
e.preventDefault();
// mismo cuerpo que onClick del botón; no agent.turn.request
setPrompt("");
return;
```

  6. `useEffect` onPush: invalidar chat también en `chat.context.usage` y `chat.compact.done` (mismo `queryKeys.chat(chatId)`). Si el push trae `context`, se puede `setQueryData` para no esperar el GET; no es obligatorio si invalidate ya refresca.

  7. `stream.error`: el texto `COMPACT_OVERFLOW_ERROR` se muestra en `setMsg({ kind: "error" })` — ya ocurre con `data.error`. Verificar que el handler de `chat.stream.error` lee `data.error` **o** `data.content` (el daemon hoy manda `content`). Aceptar ambos:

```ts
const errText = data?.error || data?.content;
```

Así el overflow no queda silencioso.

- [ ] Commit:

```bash
git add web/src/lib/context-budget.ts web/src/lib/hooks.ts \
  web/src/lib/ws-hooks.ts web/src/lib/ws-client.ts \
  web/src/components/ChatDetailPanel.tsx
git commit -m "feat(context): web banner, compact button, marker and /compact"
```

---

## Task 9: OpenAPI + contrato WS documentado

**Files:**

- Modify: `api/openapi/openapi.yaml`

- [ ] En `GET /chats/{chatId}` schema 200, añadir:

```yaml
context:
  $ref: "#/components/schemas/ContextUsage"
```

- [ ] En `components.schemas`, añadir `ContextUsage`:

```yaml
ContextUsage:
  type: object
  required: [usedTokens, budgetTokens, windowTokens, ratio, level, modelId, providerId, pct]
  properties:
    usedTokens: { type: integer }
    budgetTokens: { type: integer }
    windowTokens: { type: integer }
    ratio: { type: number }
    level: { type: string, enum: [ok, warn, critical] }
    modelId: { type: string }
    providerId: { type: string }
    pct: { type: integer }
```

- [ ] En la description de `/ws`, añadir a tipos implementados: `chat.compact`, `chat.compact.result`, `chat.context.report`. Push: `chat.compact.done`, `chat.context.usage`.

- [ ] Si existe schema `ModelInfo` en el yaml, añadir `contextWindowTokens: { type: integer }`.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml
git commit -m "docs(context): OpenAPI ContextUsage and chat.compact WS types"
```

---

## Task 10: Cierre Gherkin — tests de regresión de los 6 escenarios

**Files:**

- Create: `cli/src/llm/context-scenarios.test.ts`
- Modify: `cli/scripts/history-smoke.ts` (bloque unit **antes** del live; no exigir red para los asserts nuevos)

Un archivo que clava los escenarios del `plan.md` contra las funciones puras + fake client. Sin live LLM.

- [ ] Crear `cli/src/llm/context-scenarios.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  formatContextBanner,
  isContextOverflowError,
  measureContextUsage,
  COMPACT_OVERFLOW_ERROR,
} from "./context-budget";
import {
  buildCompactSource,
  extractLastDiff,
  extractLastPlan,
  splitCompactWindow,
} from "./compact";
import { historyFromChatMessages, promptWithHistory } from "./history";

describe("Gherkin: aviso de contexto alto", () => {
  test("Web/TUI/CLI share the same banner strings", () => {
    const u = measureContextUsage({
      usedTokens: 160_000,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(u.level).toBe("warn");
    expect(formatContextBanner(u)).toMatch(/Contexto alto/);
    const c = measureContextUsage({
      usedTokens: 190_000,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    expect(c.level).toBe("critical");
    expect(formatContextBanner(c)).toMatch(/casi lleno/);
  });
  test("overflow is classified — next turn cannot swallow it", () => {
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    expect(COMPACT_OVERFLOW_ERROR).toMatch(/compact manually/);
  });
});

describe("Gherkin: compact por comando", () => {
  test("history is summarized, old tools not resent whole, last diff+plan kept, marker label", () => {
    const hist = historyFromChatMessages(
      [
        { id: "1", role: "user", content: "haz X" },
        { id: "2", role: "tool", content: "GREP".repeat(10_000), metadata: { toolName: "grep" } },
        { id: "3", role: "assistant", content: "listo", metadata: { executionMode: "plan" } },
        {
          id: "m",
          role: "system",
          content: "contexto compactado",
          metadata: {
            kind: "compact_marker",
            summary: "Did X. Grep already ran on src/.",
            compactedUntilMessageId: "3",
            lastDiff: "foo.ts +1 −1",
            lastPlan: "1. apply",
          },
        },
      ],
      "sigue",
    );
    const blob = promptWithHistory("sigue", hist);
    expect(blob).toMatch(/Did X/);
    expect(blob).toMatch(/foo\.ts \+1/);
    expect(blob).toMatch(/1\. apply/);
    expect(blob).not.toMatch(/GREPGREPGREP/);
    expect(blob).toMatch(/Current user message:\nsigue/);
  });
});

describe("Gherkin: auto compact al desbordar", () => {
  test("retry policy constants", () => {
    expect(isContextOverflowError("context_length_exceeded")).toBe(true);
    expect(COMPACT_OVERFLOW_ERROR).toMatch(/\/compact/);
    expect(COMPACT_OVERFLOW_ERROR).toMatch(/chat compact/);
  });
  test("grep megabytes never enter compact source", () => {
    const w = splitCompactWindow(
      [
        { id: "1", role: "user", content: "a" },
        { id: "2", role: "tool", content: "z".repeat(2_000_000), metadata: { toolName: "grep" } },
        { id: "3", role: "assistant", content: "b" },
        { id: "4", role: "user", content: "c" },
        { id: "5", role: "assistant", content: "d" },
      ],
      { keepRecent: 2 },
    );
    const src = buildCompactSource(w.head);
    expect(src.length).toBeLessThan(20_000);
    expect(src).toMatch(/omitted after compact|TOOL grep/);
  });
});

describe("Gherkin: attaches del mensaje actual no se resumen", () => {
  test("current hydrated attach survives compact of the past", () => {
    const hist = historyFromChatMessages(
      [
        { id: "1", role: "user", content: "old @o.ts", metadata: { attachments: [{ path: "o.ts", kind: "text", hydratedText: "OLD" }] } },
        { id: "2", role: "assistant", content: "ok" },
        { id: "3", role: "user", content: "x" },
        { id: "4", role: "assistant", content: "y" },
        {
          id: "m",
          role: "system",
          content: "contexto compactado",
          metadata: {
            kind: "compact_marker",
            summary: "old work",
            compactedUntilMessageId: "4",
            lastDiff: null,
            lastPlan: null,
          },
        },
        {
          id: "5",
          role: "user",
          content: "lee @src/n.ts",
          metadata: {
            attachments: [{ path: "src/n.ts", kind: "text", hydratedText: "NEWFILE_FULL_BODY" }],
          },
        },
      ],
      "otro",
    );
    const blob = hist.map((h) => h.content).join("\n");
    expect(blob).toMatch(/NEWFILE_FULL_BODY/);
    expect(blob).not.toMatch(/\bOLD\b/);
  });
});

describe("Gherkin: tools históricas no se re-ejecutan", () => {
  test("compact source is text-only stubs", () => {
    const src = buildCompactSource([
      { id: "t", role: "tool", content: "hits", metadata: { toolName: "write" } },
    ]);
    expect(src).toMatch(/^TOOL write/);
    expect(src).not.toMatch(/canUseTool/);
  });
});

describe("Gherkin: ambos providers", () => {
  test("budget follows active model window, marker shape is provider-agnostic", () => {
    const claude = measureContextUsage({
      usedTokens: 10,
      windowTokens: 200_000,
      modelId: "claude-sonnet-4-6",
      providerId: "claude",
    });
    const cursor = measureContextUsage({
      usedTokens: 10,
      windowTokens: 200_000,
      modelId: "composer-2.5",
      providerId: "cursor",
    });
    expect(claude.budgetTokens).toBe(cursor.budgetTokens);
    expect(extractLastDiff([])).toBeNull();
    expect(extractLastPlan([])).toBeNull();
  });
});
```

- [ ] En `cli/scripts/history-smoke.ts`, bloque unit extra **antes** del live:

```ts
{
  const hist = historyFromChatMessages(
    [
      { id: "1", role: "user", content: "old" },
      { id: "2", role: "assistant", content: "ok" },
      {
        id: "c",
        role: "system",
        content: "contexto compactado",
        metadata: {
          kind: "compact_marker",
          summary: "ZEBRA-SUMMARY",
          compactedUntilMessageId: "2",
          lastDiff: null,
          lastPlan: null,
        },
      },
    ],
    "next",
  );
  assert.match(hist.map((h) => h.content).join("\n"), /ZEBRA-SUMMARY/);
  console.log("compact marker history OK");
}
```

El live smoke existente (dos turns) **no** se borra.

- [ ] Correr:

```bash
cd cli && bun test src/llm/context-budget.test.ts src/llm/compact.test.ts \
  src/llm/history.test.ts src/llm/compact-run.test.ts \
  src/llm/publish-turn-compact.test.ts src/llm/context-scenarios.test.ts
cd api && bun test src/llm/context-budget.test.ts src/llm/context-chat.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/context-scenarios.test.ts cli/scripts/history-smoke.ts
git commit -m "test(context): gherkin scenarios for compact, overflow, attaches and providers"
```

---

## Orden de ejecución y dependencias

```
Task 1  presupuesto + ventanas
  └─ Task 2  window/stubs/pins/history
       └─ Task 3  summarizer (tools deny)
            └─ Task 4  publish-turn + daemon dispatch
                 ├─ Task 5  API RPC + chat.get
                 │    ├─ Task 6  CLI
                 │    ├─ Task 7  TUI
                 │    └─ Task 8  Web
                 └─ Task 9  OpenAPI (puede ir en paralelo a 6–8)
                      └─ Task 10  escenarios Gherkin
```

Tasks 6, 7 y 8 dependen de Task 5 (el RPC `chat.compact` y el campo `context`). Task 7 también depende de Task 4 (`applyCompact` / `handleCompactDispatch`).

No implementar plan 11 (picker `/`), plan 14 (editor de plan), plan 15 (costo), plan 31 (memoria). Compact de un chat no tiene una tabla de memoria que borrar.

Verificación manual mínima tras las 10 tasks (no sustituye tests):

1. Chat largo → banner “Contexto alto” en Web y TUI; `chat watch` imprime `context · N% · warn`.
2. `/compact` (Web textarea y TUI compose) y `chavez headless chat compact <id>` insertan el badge `contexto compactado`.
3. Un turn que desborda compacta solo una vez y, si aún no cabe, el error visible es `COMPACT_OVERFLOW_ERROR` en las tres superficies.
4. `@archivo` en el prompt **posterior** al compact aparece entero en el siguiente `promptWithHistory`.
5. No hay procesos grep/write disparados por compact (el summarizer deniega tools).
6. Cambiar provider activo a Cursor cambia el `providerId` del `context` pero el marcador sigue siendo `compact_marker` de Chavez.
