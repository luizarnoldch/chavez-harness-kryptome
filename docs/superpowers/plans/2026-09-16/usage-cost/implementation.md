# Usage cost Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, slash picker genérico (plan 11 — aquí el **codec y la persistencia** que `/cost` lee; si `slash-cost.ts` ya existe, **extiéndelo**), presupuesto de ventana de contexto (plan 10 — `chat.context.usage` es **otro** objeto), cola de turns (plan 29), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Si un sibling (`cursor-provider`, `slash-commands`, `context-compact`) ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** Cada turn Claude o Cursor que termina guarda el **JSON crudo de usage** del provider (no un schema único). Web, TUI y `chavez headless chat cost` / `/cost` muestran input/output/cache y costo estimado cuando vienen; si no vienen, exactamente `sin datos` — no es error y **no** impide persistir assistant ni tools. El detalle del chat **suma turns** (por provider, sin aplanar). `whoami` lista usage reciente **sin keys**. Router/`optimize_for=cost` de Cursor **nunca** se etiqueta como effort de Claude.

**Architecture:** El runner vive en el daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). Usage se extrae **ahí** del mensaje `result` de Claude / `run.wait()` de Cursor, se adjunta a `chat.stream.end` `metadata`, y la API lo persiste en `chat_messages.metadata` (jsonb ya existe). No hay tabla nueva. El agregado del chat se **calcula al leer** (`chat.get` y GET `/chats/:chatId`) con el mismo codec que imprime `/cost`. Web no importa CLI: duplica `usage-codec.ts`.

```
runClaudeTurn / runCursorTurn
        |  result.usage  (Claude: usage + modelUsage + total_cost_usd)
        |  wait().usage  (Cursor: tokenUsage nativo — si viene)
        |  missing       → no emite usage; el turn SIGUE
        v
  onEvent({ kind: "usage", provider, raw })
        v
  publishAgentTurn
        |  chat.stream.end { content, metadata: { kind: turn_usage, provider, modelId, usage: raw } }
        |  parse/strip secrets en try/catch — un throw NO cancela stream.end
        v
  API chat.stream.end  →  insert assistant + metadata
        |  broadcast chat.stream.end { message, usage: ChatUsageView }
        v
  chat.get / GET /chats/:id  →  { chat, messages, usage: ChatUsageView }
        |
        +-- Web ChatUsagePanel          mismo `display`
        +-- TUI línea de costo          mismo `display`
        +-- /cost y `chat cost`         mismo `display`
        +-- GET /me/usage → whoami      últimos 5 turns, sin secrets
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/claude-runner.ts` ignora `result.usage` / `total_cost_usd` / `modelUsage`. `runClaudeTurn` devuelve `Promise<string>`. `AgentTurnEvent` no tiene `usage`.
- `cli/src/llm/publish-turn.ts` manda `chat.stream.end` **sin** `metadata`. Cursor activo lanza `"…solo claude"` (plan 4 lo cambia).
- `api/src/ws/handlers.ts` `chat.stream.end` ya mezcla `msg.metadata` en el assistant **si** `content.trim()` es truthy. Si el content está vacío, **no** inserta fila — usage se perdería. Esta fase persiste si hay content **o** hay usage.
- `chat.get` (WS) y GET `/chats/:chatId` (`api/src/routes/workspaces.ts`) devuelven `{ chat, messages }` sin sidecar de billing. `chat.context.usage` (plan 10) es presupuesto de **ventana**, no de factura — no reutilizar ese objeto ni ese event.
- `chat_messages.metadata` jsonb ya existe. `chats` **no** tiene columna de usage. **Sin migración.**
- TUI `tui/src/App.tsx`: `Message = { id, role, content }` — tira metadata. Header muestra `precios: $X/M in · $Y/M out` del catálogo, no el consumo del chat.
- Web `web/src/components/ChatDetailPanel.tsx`: timeline de role/content; no hay panel de costo.
- CLI `cli/src/commands/whoami.ts`: cwd, API, email, name. **No** usage. `headless chat` no tiene `cost` (lo añade slash-commands leyendo este codec).
- Catálogo Claude (`cli/src/llm/catalog.ts` / `api/src/llm/catalog.ts`) ya tiene `inputPricePerMTok` / `outputPricePerMTok`. Cursor stub tiene `0/0` — **no** inventar un USD 0.00 como si fuera dato real.
- [slash-commands](../slash-commands/implementation.md) Task 2 crea `cli/src/llm/slash-cost.ts` `formatChatCost` → `sin datos`. Si ese archivo **ya existe**, esta fase lo hace delegar al codec nativo. Si no, el CLI `chat cost` usa el codec directo.
- [cursor-provider](../cursor-provider/implementation.md) `runCursorTurn` hoy (si aterrizó) hace `run.wait()` y solo toma `result.result`. Esta fase extrae usage **si** viene; no exige un campo.
- [context-compact](../context-compact/implementation.md) `chat.context.usage` / `ContextUsage` (usedTokens/budgetTokens) **no** se toca. Billing ≠ ventana.

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (sin migración), Claude Agent SDK `query` mensaje `type: "result"` (`usage`, `modelUsage`, `total_cost_usd`), Cursor SDK `run.wait()` (opcional, plan 4), Ink TUI, Astro/React web. Tests: `bun test`. Web no importa CLI: copiar `usage-codec.ts` (comentario keep-in-sync).

**Global Constraints:**

1. El filesystem y el runner viven **solo** en el daemon. API y browser **no** llaman al LLM para pedir usage. Lo leen de filas ya persistidas.
2. Sin daemon bound, un turn no corre (string existente `"No daemon bound for this workspace. Run: chavez headless workspace open"`). Usage no introduce un RPC nuevo ni un path que salte el daemon.
3. JSON **crudo y nativo**. Se guarda el objeto de usage que mandó el provider (Claude ≠ Cursor). Un campo desconocido **no** se descarta del crudo. No se fuerza `input_tokens` sobre `inputTokens` en el blob persistido.
4. Deserializar con types de cada provider para **mostrar** (in/out/cache, USD). Si un campo no viene, se omite esa parte; no se inventa `0`.
5. Si el provider **no** manda usage: exactamente `sin datos`. No es error. Assistant, tools y stream se persisten igual. Un throw al parsear usage se traga y el turn termina normal.
6. Agregado del chat = suma de turns **por provider**. Un chat Claude+Cursor muestra dos bloques. No se suman `input_tokens` de Claude con `inputTokens` de Cursor como si fueran el mismo schema.
7. Cursor Router / `optimize_for` (`cost` | `balanced` | `intelligence`) es un **param de modelo** (plan 4), no effort de Claude y **no** es un token. Si aparece dentro del blob de usage, se imprime con su key nativa (`optimize_for=cost`), nunca como `effort`.
8. Costo = **estimado**. Preferir `total_cost_usd` / `costUSD` nativo. Si no viene, estimar con precios del catálogo **solo** para Claude (`inputPricePerMTok` / `outputPricePerMTok` sobre input+output; cache sin precio de catálogo → no inventar). Cursor sin precios reales → tokens sí, `$` no. Nunca mostrar `$0.00` cuando no hay dato.
9. `/cost`, el panel Web, la línea TUI y el sidecar `usage.display` de `chat.get` son **el mismo string** (misma función).
10. Secretos: whoami, logs del daemon, `console.log`, watch y el blob persistido **nunca** contienen API keys (`sk-ant-`, Cursor key, `Authorization`, `accessToken`). Strip **antes** de persistir.
11. Usage **no** entra al prompt del LLM. `historyFromChatMessages` sigue usando `content`; el blob vive en metadata.
12. 1 turn por daemon. Usage no cambia el lock.
13. Claude es ejecutable hoy. Cursor: si `cli/src/llm/cursor-runner.ts` existe, extraer usage ahí; si no, el codec y los tests de fixture quedan listos y `publish-turn` los usará cuando plan 4 aterrice. No simular un turn Cursor.
14. Web, TUI y CLI `watch` ven el mismo assistant con el mismo metadata. Un reload de `chat.get` reconstruye el panel.
15. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, invoice real, billing Anthropic/Cursor de cuenta, slash picker, compact de ventana.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `USAGE_META_KIND` | `"turn_usage"` |
| `NO_USAGE_TEXT` | `"sin datos"` |
| `RECENT_USAGE_LIMIT` | `5` |
| `USAGE_RECENT_SCAN` | `50` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TURN_BUSY_ERROR` | `"Turn already running on this daemon"` |

Reusar `NO_USAGE_TEXT` de `cli/src/llm/slash.ts` si el plan 11 ya lo exportó; **no** cambiar el string. Si no existe, definirlo en el codec y que slash lo importe después.

`ChatUsageView.display` (contrato entre superficies):

```
sin datos                                          # ningún turn con blob
chat claude: in 100 · out 40 · cache 10 · $0.0123  # un provider
turn: in 12 · out 4 · $0.0012
chat claude: in 100 · out 40 · $0.05               # mixto: un bloque por provider
chat cursor: in 20 · out 8
turn: in 3 · out 1
```

Reglas del string:

- Prefijo `chat <provider>:` para el agregado, `turn:` para el último turn con datos.
- Partes presentes nada más: `in N`, `out N`, `cache N` (cache = cache **read** si existe).
- USD con **4** decimales si `>= 0.0001`, si no `"<$0.0001"`. Nunca `$0.00` placeholder.
- Prohibido: la palabra `effort` en el output de Cursor. `optimize_for` se imprime crudo.

Nombres de events WS (ninguno nuevo de billing; reusar stream.end / chat.get):

| Tipo | Dirección | Qué cambia |
|---|---|---|
| `chat.stream.end` | daemon → API → broadcast | `metadata` del assistant incluye usage; payload `usage: ChatUsageView` |
| `chat.get` | RPC | `{ chat, messages, usage }` (`context` del plan 10 se conserva si ya está) |
| GET `/chats/:chatId` | HTTP | igual que `chat.get` |
| GET `/me/usage` | HTTP | últimos turns con usage del **usuario**, sin secrets |

Metadata persistida en el mensaje assistant:

```ts
type TurnUsageMeta = {
  kind: "turn_usage";
  provider: "claude" | "cursor";
  modelId: string;
  usage: Record<string, unknown>; // JSON crudo ya strippeado
};
```

Types nativos (deserializar; el crudo se guarda entero):

```ts
/** Claude Agent SDK result.usage (BetaUsage) + extras del result. */
type ClaudeUsageNative = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_cost_usd?: number;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
};

/** Cursor run.wait() — keys nativas, no effortLevels. */
type CursorUsageNative = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};
```

---

## Task 1: Codec nativo — parse, strip, format, agregado

**Files:**

- Create: `cli/src/llm/usage-codec.ts`
- Test: `cli/src/llm/usage-codec.test.ts`
- Create: `api/src/llm/usage-codec.ts`
- Test: `api/src/llm/usage-codec.test.ts`
- Create: `web/src/lib/usage-codec.ts`
- Test: `web/src/lib/usage-codec.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`
- Modify: `cli/src/llm/slash-cost.ts` (solo si ya existe)

Módulo puro. Sin I/O. TUI importa `cli/src/llm/usage-codec.ts`. API y Web **duplican** el archivo (keep-in-sync en la primera línea). No aplanar Claude y Cursor a un `Usage` único que se persista.

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`build` intactos).

- [ ] Crear `cli/src/llm/usage-codec.ts` con este contenido (copiar **idéntico** a `api/src/llm/usage-codec.ts` y `web/src/lib/usage-codec.ts`; primera línea: `/** keep-in-sync: cli/src/llm/usage-codec.ts */`):

```ts
/** keep-in-sync: cli/src/llm/usage-codec.ts */

export const USAGE_META_KIND = "turn_usage";
export const NO_USAGE_TEXT = "sin datos";
export const RECENT_USAGE_LIMIT = 5;
export const USAGE_RECENT_SCAN = 50;

export type UsageProvider = "claude" | "cursor";

export type TurnUsageMeta = {
  kind: typeof USAGE_META_KIND;
  provider: UsageProvider;
  modelId: string;
  usage: Record<string, unknown>;
};

export type CostRow = {
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
};

export type ChatUsageView = {
  hasData: boolean;
  display: string;
  turnsWithUsage: number;
  claude?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
};

const SECRET_KEY = /secret|api[_-]?key|authorization|access[_-]?token|password|bearer/i;
const SECRET_VALUE = /sk-ant-|sk-or-|crsr_|keysk-|ghp_|xox[baprs]-/i;

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Drop keys/values that look like credentials. Never persist those. */
export function stripUsageSecrets(raw: unknown): Record<string, unknown> | null {
  const src = rec(raw);
  if (!src) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "string" && SECRET_VALUE.test(v)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = stripUsageSecrets(v);
      if (nested && Object.keys(nested).length) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Claude result message → raw usage blob (usage + modelUsage + total_cost_usd).
 * Missing usage is null, not an empty object.
 */
export function extractClaudeUsageRaw(resultMsg: unknown): Record<string, unknown> | null {
  const m = rec(resultMsg);
  if (!m) return null;
  const blob: Record<string, unknown> = {};
  if (rec(m.usage)) blob.usage = m.usage;
  if (rec(m.modelUsage)) blob.modelUsage = m.modelUsage;
  if (num(m.total_cost_usd) != null) blob.total_cost_usd = m.total_cost_usd;
  return stripUsageSecrets(blob);
}

/**
 * Cursor run.wait() result → raw usage blob. Accepts usage | tokenUsage | top-level tokens.
 * Does not read optimize_for from model params — that is not usage.
 */
export function extractCursorUsageRaw(waitResult: unknown): Record<string, unknown> | null {
  const m = rec(waitResult);
  if (!m) return null;
  const nested = rec(m.usage) || rec(m.tokenUsage) || rec(m.cost);
  if (nested && Object.keys(nested).length) return stripUsageSecrets(nested);
  const blob: Record<string, unknown> = {};
  const input = num(m.inputTokens) ?? num(m.input_tokens);
  const output = num(m.outputTokens) ?? num(m.output_tokens);
  const cache = num(m.cacheReadTokens) ?? num(m.cache_read_input_tokens);
  if (input != null) blob.inputTokens = input;
  if (output != null) blob.outputTokens = output;
  if (cache != null) blob.cacheReadTokens = cache;
  const usd = num(m.costUsd) ?? num(m.total_cost_usd);
  if (usd != null) blob.costUsd = usd;
  return stripUsageSecrets(blob);
}

export function isTurnUsageMeta(meta: unknown): meta is TurnUsageMeta {
  const m = rec(meta);
  return Boolean(
    m &&
      m.kind === USAGE_META_KIND &&
      (m.provider === "claude" || m.provider === "cursor") &&
      rec(m.usage),
  );
}

export function usageBlobFromMeta(meta: unknown): {
  provider: UsageProvider;
  blob: Record<string, unknown>;
} | null {
  if (isTurnUsageMeta(meta)) {
    const blob = stripUsageSecrets(meta.usage);
    return blob ? { provider: meta.provider, blob } : null;
  }
  const m = rec(meta);
  if (!m) return null;
  for (const key of ["usage", "tokenUsage", "cursorUsage"] as const) {
    const blob = rec(m[key]);
    if (!blob || !Object.keys(blob).length) continue;
    const provider: UsageProvider =
      m.provider === "cursor" || key === "cursorUsage" ? "cursor" : "claude";
    const clean = stripUsageSecrets(blob);
    if (clean) return { provider, blob: clean };
  }
  return null;
}

function tokensFromClaude(blob: Record<string, unknown>): {
  input: number | null;
  output: number | null;
  cache: number | null;
  usd: number | null;
} {
  const u = rec(blob.usage) ?? blob;
  const mu = rec(blob.modelUsage);
  let input = num(u.input_tokens) ?? num(u.inputTokens);
  let output = num(u.output_tokens) ?? num(u.outputTokens);
  let cache =
    num(u.cache_read_input_tokens) ??
    num(u.cacheReadInputTokens) ??
    num(u.cacheReadTokens);
  let usd = num(blob.total_cost_usd) ?? num(u.total_cost_usd) ?? num(u.costUSD);
  if (mu) {
    let inSum = 0;
    let outSum = 0;
    let cacheSum = 0;
    let usdSum = 0;
    let any = false;
    for (const row of Object.values(mu)) {
      const r = rec(row);
      if (!r) continue;
      any = true;
      inSum += num(r.inputTokens) ?? 0;
      outSum += num(r.outputTokens) ?? 0;
      cacheSum += num(r.cacheReadInputTokens) ?? 0;
      usdSum += num(r.costUSD) ?? 0;
    }
    if (any) {
      if (input == null) input = inSum;
      if (output == null) output = outSum;
      if (cache == null && cacheSum) cache = cacheSum;
      if (usd == null && usdSum) usd = usdSum;
    }
  }
  return { input, output, cache, usd };
}

function tokensFromCursor(blob: Record<string, unknown>): {
  input: number | null;
  output: number | null;
  cache: number | null;
  usd: number | null;
} {
  return {
    input: num(blob.inputTokens) ?? num(blob.input_tokens) ?? num(blob.input),
    output:
      num(blob.outputTokens) ?? num(blob.output_tokens) ?? num(blob.output),
    cache:
      num(blob.cacheReadTokens) ??
      num(blob.cache_read_input_tokens) ??
      num(blob.cache_read),
    usd: num(blob.costUsd) ?? num(blob.total_cost_usd) ?? num(blob.costUSD),
  };
}

function tokensOf(provider: UsageProvider, blob: Record<string, unknown>) {
  return provider === "cursor" ? tokensFromCursor(blob) : tokensFromClaude(blob);
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.0001) return "<$0.0001";
  return `$${n.toFixed(4)}`;
}

export function formatTokenParts(
  t: {
    input: number | null;
    output: number | null;
    cache: number | null;
    usd: number | null;
  },
): string | null {
  const parts: string[] = [];
  if (t.input != null) parts.push(`in ${t.input}`);
  if (t.output != null) parts.push(`out ${t.output}`);
  if (t.cache != null) parts.push(`cache ${t.cache}`);
  if (t.usd != null) parts.push(formatUsd(t.usd));
  return parts.length ? parts.join(" · ") : null;
}

export type CatalogPrice = {
  inputPricePerMTok?: number | null;
  outputPricePerMTok?: number | null;
};

/** Estimate USD from catalog list prices. Cache is omitted (no catalog rate). */
export function estimateUsdFromCatalog(
  t: { input: number | null; output: number | null },
  price: CatalogPrice | null | undefined,
): number | null {
  if (!price) return null;
  const inP = num(price.inputPricePerMTok);
  const outP = num(price.outputPricePerMTok);
  if (inP == null || outP == null) return null;
  if (inP === 0 && outP === 0) return null;
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  if (t.input == null && t.output == null) return null;
  return (input / 1_000_000) * inP + (output / 1_000_000) * outP;
}

function addNative(
  acc: Record<string, unknown>,
  blob: Record<string, unknown>,
  provider: UsageProvider,
): void {
  const t = tokensOf(provider, blob);
  const inKey = provider === "cursor" ? "inputTokens" : "input_tokens";
  const outKey = provider === "cursor" ? "outputTokens" : "output_tokens";
  const cacheKey =
    provider === "cursor" ? "cacheReadTokens" : "cache_read_input_tokens";
  const usdKey = provider === "cursor" ? "costUsd" : "total_cost_usd";
  if (t.input != null) acc[inKey] = (num(acc[inKey]) ?? 0) + t.input;
  if (t.output != null) acc[outKey] = (num(acc[outKey]) ?? 0) + t.output;
  if (t.cache != null) acc[cacheKey] = (num(acc[cacheKey]) ?? 0) + t.cache;
  if (t.usd != null) acc[usdKey] = (num(acc[usdKey]) ?? 0) + t.usd;
}

export function aggregateChatUsage(
  messages: CostRow[],
  prices?: Partial<Record<UsageProvider, CatalogPrice | null>>,
): ChatUsageView {
  const claude: Record<string, unknown> = {};
  const cursor: Record<string, unknown> = {};
  let turns = 0;
  let last: { provider: UsageProvider; blob: Record<string, unknown> } | null =
    null;

  for (const row of messages) {
    const found = usageBlobFromMeta(row.metadata);
    if (!found) continue;
    turns += 1;
    last = found;
    if (found.provider === "cursor") addNative(cursor, found.blob, "cursor");
    else addNative(claude, found.blob, "claude");
  }

  const fillUsd = (provider: UsageProvider, acc: Record<string, unknown>) => {
    const usdKey = provider === "cursor" ? "costUsd" : "total_cost_usd";
    if (num(acc[usdKey]) != null) return;
    const t = tokensOf(provider, acc);
    const est = estimateUsdFromCatalog(t, prices?.[provider]);
    if (est != null) acc[usdKey] = est;
  };
  if (Object.keys(claude).length) fillUsd("claude", claude);
  if (Object.keys(cursor).length) fillUsd("cursor", cursor);

  const lines: string[] = [];
  if (Object.keys(claude).length) {
    const parts = formatTokenParts(tokensOf("claude", claude));
    if (parts) lines.push(`chat claude: ${parts}`);
  }
  if (Object.keys(cursor).length) {
    const parts = formatTokenParts(tokensOf("cursor", cursor));
    if (parts) lines.push(`chat cursor: ${parts}`);
  }
  if (last) {
    const t = tokensOf(last.provider, last.blob);
    if (t.usd == null) {
      t.usd = estimateUsdFromCatalog(t, prices?.[last.provider]);
    }
    const parts = formatTokenParts(t);
    if (parts) lines.push(`turn: ${parts}`);
    else {
      const keys = Object.keys(last.blob).filter(
        (k) => k.toLowerCase() !== "effort",
      );
      if (keys.length) {
        lines.push(
          `turn: ${keys.map((k) => `${k}=${String(last!.blob[k])}`).join(" · ")}`,
        );
      }
    }
  }

  const display = lines.length ? lines.join("\n") : NO_USAGE_TEXT;
  return {
    hasData: display !== NO_USAGE_TEXT,
    display,
    turnsWithUsage: turns,
    claude: Object.keys(claude).length ? claude : undefined,
    cursor: Object.keys(cursor).length ? cursor : undefined,
  };
}

export function formatChatUsage(
  messages: CostRow[],
  prices?: Partial<Record<UsageProvider, CatalogPrice | null>>,
): string {
  return aggregateChatUsage(messages, prices).display;
}

export function formatTurnUsageLine(meta: unknown): string | null {
  const found = usageBlobFromMeta(meta);
  if (!found) return null;
  const parts = formatTokenParts(tokensOf(found.provider, found.blob));
  if (parts) return parts;
  return null;
}

export function assertNoSecrets(text: string): void {
  if (SECRET_VALUE.test(text) || /Bearer\s+\S+/i.test(text)) {
    throw new Error("usage output leaked a secret");
  }
}
```

- [ ] Crear `cli/src/llm/usage-codec.test.ts` (copiar los mismos casos a `api/src/llm/usage-codec.test.ts` y `web/src/lib/usage-codec.test.ts`, ajustando el import):

```ts
import { describe, expect, test } from "bun:test";
import {
  NO_USAGE_TEXT,
  aggregateChatUsage,
  extractClaudeUsageRaw,
  extractCursorUsageRaw,
  formatChatUsage,
  formatTurnUsageLine,
  stripUsageSecrets,
} from "./usage-codec";

const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  result: "ok",
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 10,
  },
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      costUSD: 0.0123,
    },
  },
};

describe("extractClaudeUsageRaw", () => {
  test("keeps native keys and cost", () => {
    const raw = extractClaudeUsageRaw(CLAUDE_RESULT);
    expect(raw).toBeTruthy();
    expect((raw!.usage as { input_tokens: number }).input_tokens).toBe(100);
    expect(raw!.total_cost_usd).toBe(0.0123);
    expect(raw).not.toHaveProperty("result");
  });

  test("missing usage is null, not error", () => {
    expect(extractClaudeUsageRaw({ type: "result", subtype: "success", result: "ok" })).toBeNull();
    expect(extractClaudeUsageRaw(null)).toBeNull();
  });
});

describe("extractCursorUsageRaw", () => {
  test("native camelCase, optimize_for is not required", () => {
    const raw = extractCursorUsageRaw({
      status: "finished",
      result: "ok",
      usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 2 },
    });
    expect(raw).toEqual({ inputTokens: 3, outputTokens: 1, cacheReadTokens: 2 });
  });

  test("does not invent tokens", () => {
    expect(extractCursorUsageRaw({ status: "finished", result: "ok" })).toBeNull();
  });
});

describe("stripUsageSecrets", () => {
  test("drops api keys from blob", () => {
    const raw = stripUsageSecrets({
      input_tokens: 1,
      apiKey: "sk-ant-secret",
      nested: { authorization: "Bearer abc", output_tokens: 2 },
    });
    expect(JSON.stringify(raw)).not.toContain("sk-ant");
    expect(JSON.stringify(raw)).not.toContain("Bearer");
    expect(raw).toHaveProperty("input_tokens", 1);
  });
});

describe("formatChatUsage", () => {
  test("sin datos when provider reported nothing", () => {
    expect(formatChatUsage([])).toBe(NO_USAGE_TEXT);
    expect(
      formatChatUsage([{ role: "assistant", content: "hi", metadata: {} }]),
    ).toBe(NO_USAGE_TEXT);
  });

  test("Claude-shaped usage shows in/out/cache and usd", () => {
    const text = formatChatUsage([
      {
        role: "assistant",
        content: "ok",
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: CLAUDE_RESULT,
        },
      },
    ]);
    expect(text).toContain("in 100");
    expect(text).toContain("out 40");
    expect(text).toContain("cache 10");
    expect(text).toContain("$0.0123");
    expect(text).not.toBe(NO_USAGE_TEXT);
  });

  test("Cursor Router cost is not labeled effort", () => {
    const text = formatChatUsage([
      {
        role: "assistant",
        content: "ok",
        metadata: {
          kind: "turn_usage",
          provider: "cursor",
          modelId: "auto-smart",
          usage: {
            inputTokens: 3,
            outputTokens: 1,
            optimize_for: "cost",
          },
        },
      },
    ]);
    expect(text).toContain("in 3");
    expect(text.toLowerCase()).not.toContain("effort");
    expect(text).not.toMatch(/effort\s*=\s*cost/i);
  });

  test("chat aggregate sums turns per provider without flattening", () => {
    const view = aggregateChatUsage([
      {
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: { usage: { input_tokens: 10, output_tokens: 4 } },
        },
      },
      {
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: { usage: { input_tokens: 5, output_tokens: 1 } },
        },
      },
      {
        metadata: {
          kind: "turn_usage",
          provider: "cursor",
          modelId: "composer-2.5",
          usage: { inputTokens: 7, outputTokens: 2 },
        },
      },
    ]);
    expect(view.turnsWithUsage).toBe(3);
    expect(view.claude).toEqual({ input_tokens: 15, output_tokens: 5 });
    expect(view.cursor).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(view.display).toContain("chat claude:");
    expect(view.display).toContain("chat cursor:");
    expect(view.display).not.toContain("effort");
  });

  test("catalog estimate fills usd when provider omitted cost", () => {
    const text = formatChatUsage(
      [
        {
          metadata: {
            kind: "turn_usage",
            provider: "claude",
            modelId: "claude-sonnet-4-6",
            usage: { usage: { input_tokens: 1_000_000, output_tokens: 0 } },
          },
        },
      ],
      { claude: { inputPricePerMTok: 3, outputPricePerMTok: 15 } },
    );
    expect(text).toContain("$3.0000");
  });

  test("Cursor stub prices 0/0 do not print $0.00", () => {
    const text = formatChatUsage(
      [
        {
          metadata: {
            kind: "turn_usage",
            provider: "cursor",
            modelId: "composer-2.5",
            usage: { inputTokens: 9, outputTokens: 1 },
          },
        },
      ],
      { cursor: { inputPricePerMTok: 0, outputPricePerMTok: 0 } },
    );
    expect(text).toContain("in 9");
    expect(text).not.toContain("$0.00");
  });
});

describe("formatTurnUsageLine", () => {
  test("null when no blob", () => {
    expect(formatTurnUsageLine({})).toBeNull();
  });
});
```

En `api/` y `web/` el import es `./usage-codec` (web: mismo path relativo desde `web/src/lib/`).

- [ ] Si `cli/src/llm/slash-cost.ts` **existe**, no reescribirlo: hacer que `formatChatCost` delegue:

```ts
import { formatChatUsage, type CostRow } from "./usage-codec";
export type { CostRow };
export function formatChatCost(messages: CostRow[], _chatMeta?: unknown): string {
  return formatChatUsage(messages);
}
```

Dejar `extractUsageBlob` si otros tests lo importan, reexportando `usageBlobFromMeta` o adaptando. Correr los tests de slash-cost existentes: deben seguir pasando (`sin datos`, Claude in/out, Cursor sin `effort`).

- [ ] Correr:

```bash
cd cli && bun test src/llm/usage-codec.test.ts
cd api && bun test src/llm/usage-codec.test.ts
cd web && bun test src/lib/usage-codec.test.ts
```

Esperado: todos pasan. Si slash-cost existe: `cd cli && bun test src/llm/slash-cost.test.ts` también.

- [ ] Commit:

```bash
git add cli/src/llm/usage-codec.ts cli/src/llm/usage-codec.test.ts \
  api/src/llm/usage-codec.ts api/src/llm/usage-codec.test.ts \
  web/src/lib/usage-codec.ts web/src/lib/usage-codec.test.ts \
  cli/package.json api/package.json web/package.json \
  cli/src/llm/slash-cost.ts
git commit -m "feat(usage): native Claude/Cursor usage codec without flattening"
```

---

## Task 2: Claude runner emite usage sin bloquear el turn

**Files:**

- Modify: `cli/src/llm/claude-runner.ts`
- Test: `cli/src/llm/claude-runner.test.ts` (crear si no existe; si existe, **añadir** casos)
- Modify: `cli/src/llm/publish-turn.ts`
- Test: `cli/src/llm/publish-turn.test.ts` (crear si no existe)

`runClaudeTurn` sigue devolviendo `Promise<string>` (no romper callers de plan 4 / smokes). Usage sale por `onEvent`. Un result **sin** usage no lanza. Un parse que tire se traga.

- [ ] En `cli/src/llm/claude-runner.ts`, ampliar `AgentTurnEvent`:

```ts
export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
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
  | { kind: "result"; text: string }
  | {
      kind: "usage";
      provider: "claude" | "cursor";
      raw: Record<string, unknown>;
    };
```

Importar `extractClaudeUsageRaw` desde `./usage-codec`.

En el loop, **junto** al bloque existente `type === "result" && subtype === "success"` (no lo reescribas: **añade** la extracción). También extraer usage en **cualquier** `type === "result"` que traiga `usage` / `total_cost_usd` (un error de ejecución igual puede haber gastado tokens), **sin** cambiar la regla de `finalResult`:

```ts
if (type === "result") {
  try {
    const raw = extractClaudeUsageRaw(msg);
    if (raw) {
      await input.onEvent?.({ kind: "usage", provider: "claude", raw });
    }
  } catch {
    // usage is optional — never fail the turn
  }
}
```

El `if (type === "result" && subtype === "success" && typeof msg.result === "string")` existente se queda. Si no hay `usage` en el result, no se emite `kind: "usage"` y `finalResult` sigue igual.

- [ ] Crear o extender `cli/src/llm/claude-runner.test.ts`. Extraer la función pura de parseo del loop no es necesario: testear `extractClaudeUsageRaw` ya está en Task 1. Aquí testear un helper exportado `emitClaudeResultUsage(msg, onEvent)` para no mockear `query()`:

En `claude-runner.ts`:

```ts
export async function emitClaudeResultUsage(
  msg: unknown,
  onEvent?: RunClaudeTurnInput["onEvent"],
): Promise<void> {
  try {
    const raw = extractClaudeUsageRaw(msg);
    if (raw) await onEvent?.({ kind: "usage", provider: "claude", raw });
  } catch {
    // ignore
  }
}
```

El loop llama `await emitClaudeResultUsage(msg, input.onEvent)`.

Tests:

```ts
import { describe, expect, test } from "bun:test";
import { emitClaudeResultUsage, type AgentTurnEvent } from "./claude-runner";

test("emits usage from a Claude result message", async () => {
  const events: AgentTurnEvent[] = [];
  await emitClaudeResultUsage(
    {
      type: "result",
      subtype: "success",
      result: "hi",
      total_cost_usd: 0.01,
      usage: { input_tokens: 8, output_tokens: 2 },
    },
    async (ev) => {
      events.push(ev);
    },
  );
  expect(events[0]).toMatchObject({ kind: "usage", provider: "claude" });
  if (events[0]!.kind !== "usage") throw new Error("expected usage");
  expect((events[0].raw.usage as { input_tokens: number }).input_tokens).toBe(8);
});

test("missing usage emits nothing and does not throw", async () => {
  const events: AgentTurnEvent[] = [];
  await emitClaudeResultUsage(
    { type: "result", subtype: "success", result: "hi" },
    async (ev) => {
      events.push(ev);
    },
  );
  expect(events).toEqual([]);
});
```

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Importar `USAGE_META_KIND`, `stripUsageSecrets` desde `./usage-codec`.
  2. Antes de `runClaudeTurn`, `let usageMeta: Record<string, unknown> | null = null;`.
  3. En `onEvent`, añadir:

```ts
if (ev.kind === "usage") {
  const raw = stripUsageSecrets(ev.raw);
  if (raw) {
    usageMeta = {
      kind: USAGE_META_KIND,
      provider: ev.provider,
      modelId: model,
      usage: raw,
    };
  }
}
```

  4. `chat.stream.end` pasa metadata (y content vacío no debe perder usage — Task 3 cubre el handler; aquí **siempre** manda metadata si hay):

```ts
await client.request(
  {
    type: "chat.stream.end",
    chatId,
    streamId,
    content: result,
    metadata: usageMeta ?? undefined,
  },
  60_000,
);
```

  5. Envolver la asignación de `usageMeta` en try/catch local (además del del runner). El `catch` existente de `runClaudeTurn` **no** cambia: tools ya persistidas se quedan; se manda `chat.stream.error` como hoy.

- [ ] `cli/src/llm/publish-turn.test.ts` — inyectar un client fake. Si el archivo no existe, crear tests del **payload** extraído a una función pura para no levantar WS:

En `publish-turn.ts` exportar:

```ts
export function streamEndPayload(input: {
  chatId: string;
  streamId: string;
  content: string;
  usageMeta: Record<string, unknown> | null;
}): Record<string, unknown> {
  const req: Record<string, unknown> = {
    type: "chat.stream.end",
    chatId: input.chatId,
    streamId: input.streamId,
    content: input.content,
  };
  if (input.usageMeta) req.metadata = input.usageMeta;
  return req;
}
```

`publishAgentTurn` usa `streamEndPayload({ chatId, streamId, content: result, usageMeta })` como cuerpo del request.

Tests:

```ts
import { describe, expect, test } from "bun:test";
import { streamEndPayload } from "./publish-turn";
import { USAGE_META_KIND } from "./usage-codec";

test("stream.end includes usage metadata when present", () => {
  const p = streamEndPayload({
    chatId: "c1",
    streamId: "s1",
    content: "hello",
    usageMeta: {
      kind: USAGE_META_KIND,
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      usage: { usage: { input_tokens: 1 } },
    },
  });
  expect(p.content).toBe("hello");
  expect(p.metadata).toMatchObject({ kind: USAGE_META_KIND, provider: "claude" });
});

test("stream.end without usage still has assistant content", () => {
  const p = streamEndPayload({
    chatId: "c1",
    streamId: "s1",
    content: "hello",
    usageMeta: null,
  });
  expect(p.content).toBe("hello");
  expect(p).not.toHaveProperty("metadata");
});
```

- [ ] Correr:

```bash
cd cli && bun test src/llm/claude-runner.test.ts src/llm/publish-turn.test.ts src/llm/usage-codec.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add cli/src/llm/claude-runner.ts cli/src/llm/claude-runner.test.ts \
  cli/src/llm/publish-turn.ts cli/src/llm/publish-turn.test.ts
git commit -m "feat(usage): capture Claude result usage on stream.end"
```

---

## Task 3: Cursor runner (si existe) + stream.end persiste usage aunque el content esté vacío

**Files:**

- Modify: `cli/src/llm/cursor-runner.ts` (solo si el archivo existe)
- Test: `cli/src/llm/cursor-runner.test.ts` (añadir casos si el archivo existe)
- Create: `api/src/llm/usage-persist.ts`
- Modify: `api/src/ws/handlers.ts`
- Test: `api/src/ws/stream-end-usage.test.ts`

- [ ] Si `cli/src/llm/cursor-runner.ts` **no** existe (plan 4 no aterrizó): no crearlo. Saltar el patch del runner. Los tests de `extractCursorUsageRaw` (Task 1) cubren el contrato. Seguir con el handler de API.

- [ ] Si `cli/src/llm/cursor-runner.ts` **existe**, tras `const result = await run.wait();` y **antes** de `return text`, en try/catch:

```ts
try {
  const raw = extractCursorUsageRaw(result);
  if (raw) {
    await input.onEvent?.({ kind: "usage", provider: "cursor", raw });
  }
} catch {
  // usage optional
}
```

Importar `extractCursorUsageRaw`. No cambiar `Agent.create({ local: { cwd } })`. No leer `optimize_for` de `input.params` para armar usage.

Añadir test: fake `wait()` que resuelve `{ status: "finished", result: "ok", usage: { inputTokens: 3, outputTokens: 1 } }` → el `onEvent` recibe `kind: "usage"` `provider: "cursor"`. Fake **sin** usage → `kind: "result"` sí, `kind: "usage"` no, y el texto `"ok"` se persiste (el test del runner verifica que `wait()` sin usage no lanza).

- [ ] Crear `api/src/llm/usage-persist.ts` (funciones de decisión, testables sin Postgres):

```ts
import {
  isTurnUsageMeta,
  stripUsageSecrets,
  type TurnUsageMeta,
} from "./usage-codec";

export function prepareStreamEndMeta(
  metadata: unknown,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const meta = { ...(metadata as Record<string, unknown>) };
  try {
    if (isTurnUsageMeta(meta)) {
      const stripped = stripUsageSecrets(meta.usage);
      if (stripped) (meta as TurnUsageMeta).usage = stripped;
      else delete meta.usage;
    }
  } catch {
    delete meta.usage;
  }
  return meta;
}

export function shouldPersistAssistant(
  content: string,
  meta: Record<string, unknown>,
): boolean {
  return Boolean(content.trim()) || isTurnUsageMeta(meta);
}
```

- [ ] En `api/src/ws/handlers.ts`, import estático:

```ts
import { aggregateChatUsage } from "../llm/usage-codec";
import {
  prepareStreamEndMeta,
  shouldPersistAssistant,
} from "../llm/usage-persist";
```

Reemplazar el case `"chat.stream.end"` por:

```ts
case "chat.stream.end": {
  if (!msg.chatId || !msg.streamId) {
    return fail(type, id, "chatId and streamId are required");
  }
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  let message = null;
  const content = (msg.content ?? "").trim();
  const cleaned = prepareStreamEndMeta(msg.metadata);
  if (shouldPersistAssistant(content, cleaned)) {
    const now = new Date();
    message = {
      id: crypto.randomUUID(),
      chatId: msg.chatId,
      role: "assistant",
      content: content || "",
      metadata: {
        streamId: msg.streamId,
        ...cleaned,
      },
      createdAt: now,
    };
    await db.insert(chatMessages).values(message);
    await db
      .update(chats)
      .set({ updatedAt: now })
      .where(eq(chats.id, msg.chatId));
    broadcast(userId, "message.appended", {
      message,
      chatId: msg.chatId,
    });
  }
  let usageView = undefined;
  try {
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, msg.chatId))
      .orderBy(asc(chatMessages.createdAt));
    usageView = aggregateChatUsage(rows);
  } catch {
    usageView = undefined;
  }
  const payload = {
    chatId: msg.chatId,
    streamId: msg.streamId,
    message,
    usage: usageView,
  };
  broadcast(userId, "chat.stream.end", payload);
  return ok(type, id, payload);
}
```

Regla: assistant con texto se inserta aunque usage esté corrupto (el strip ya corrió). Assistant sin texto y sin usage **no** se inserta (comportamiento actual). `db.insert` que falle **sí** es error (como hoy). El catch cubre **solo** el agregado.

- [ ] Tests `api/src/ws/stream-end-usage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { prepareStreamEndMeta, shouldPersistAssistant } from "../llm/usage-persist";
import { USAGE_META_KIND } from "../llm/usage-codec";

test("persists assistant when usage exists even if content is empty", () => {
  const meta = prepareStreamEndMeta({
    kind: USAGE_META_KIND,
    provider: "claude",
    modelId: "claude-sonnet-4-6",
    usage: { usage: { input_tokens: 1 }, apiKey: "sk-ant-secret" },
  });
  expect(shouldPersistAssistant("", meta)).toBe(true);
  expect(JSON.stringify(meta)).not.toContain("sk-ant");
});

test("does not persist empty assistant without usage", () => {
  expect(shouldPersistAssistant("  ", {})).toBe(false);
});

test("persists assistant text without usage", () => {
  expect(shouldPersistAssistant("hello", {})).toBe(true);
});
```

Handlers: importar esas dos funciones. No cambiar `chat.tool.start` / `chat.tool.result`.

- [ ] Correr:

```bash
cd api && bun test src/ws/stream-end-usage.test.ts src/llm/usage-codec.test.ts
cd cli && bun test src/llm/cursor-runner.test.ts
```

El segundo comando: si el archivo no existe, no fallar el plan — omitirlo.

- [ ] Commit:

```bash
git add api/src/llm/usage-persist.ts api/src/ws/stream-end-usage.test.ts \
  api/src/ws/handlers.ts cli/src/llm/cursor-runner.ts cli/src/llm/cursor-runner.test.ts
git commit -m "feat(usage): persist native usage on stream.end without blocking tools"
```

---

## Task 4: `chat.get` y GET `/chats/:id` exponen el agregado; GET `/me/usage`

**Files:**

- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/index.ts`
- Test: `api/src/llm/usage-chat.test.ts`
- Modify: `api/openapi/openapi.yaml` (description de `/chats/{chatId}` y `/me/usage`)

El agregado se calcula con `aggregateChatUsage(messages)`. Precios Claude desde `CLAUDE_MODELS` del catálogo API. Cursor: pasar `null` o el modelo si tiene precios reales (`inputPricePerMTok > 0`); el stub `0/0` se omite (el codec ya ignora 0/0).

Si el handler de `chat.get` **ya** añade `context` (plan 10) o `diffs` (plan 6), **conservarlos**. Solo sumar `usage`.

- [ ] Helper `api/src/llm/usage-chat.ts` (create):

```ts
import { CLAUDE_MODELS, getModel } from "./catalog";
import {
  aggregateChatUsage,
  type ChatUsageView,
  type CostRow,
} from "./usage-codec";

export function pricesForUsage(): {
  claude: { inputPricePerMTok: number; outputPricePerMTok: number } | null;
  cursor: { inputPricePerMTok: number; outputPricePerMTok: number } | null;
} {
  const sonnet = CLAUDE_MODELS.find((m) => m.id.includes("sonnet")) ?? CLAUDE_MODELS[0];
  const claude = sonnet
    ? {
        inputPricePerMTok: sonnet.inputPricePerMTok,
        outputPricePerMTok: sonnet.outputPricePerMTok,
      }
    : null;
  return { claude, cursor: null };
}

export function usageForMessages(messages: CostRow[]): ChatUsageView {
  return aggregateChatUsage(messages, pricesForUsage());
}

export function usageForMessagesWithModel(
  messages: CostRow[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): ChatUsageView {
  const prices = pricesForUsage();
  if (providerId && modelId) {
    const m = getModel(providerId, modelId);
    if (m && (m.inputPricePerMTok > 0 || m.outputPricePerMTok > 0)) {
      const pack = {
        inputPricePerMTok: m.inputPricePerMTok,
        outputPricePerMTok: m.outputPricePerMTok,
      };
      if (providerId === "cursor") prices.cursor = pack;
      if (providerId === "claude") prices.claude = pack;
    }
  }
  return aggregateChatUsage(messages, prices);
}
```

Si `getModel` no existe en `api/src/llm/catalog.ts`, usar `PROVIDER_CATALOGS.find(...)?.models.find(...)`. No añadir `getModel` duplicado si ya está.

- [ ] Test `api/src/llm/usage-chat.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NO_USAGE_TEXT } from "./usage-codec";
import { usageForMessages } from "./usage-chat";

test("empty chat is sin datos", () => {
  expect(usageForMessages([]).display).toBe(NO_USAGE_TEXT);
  expect(usageForMessages([]).hasData).toBe(false);
});

test("sums two Claude turns", () => {
  const view = usageForMessages([
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001 },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.0005 },
      },
    },
  ]);
  expect(view.turnsWithUsage).toBe(2);
  expect(view.claude).toMatchObject({ input_tokens: 15, output_tokens: 3 });
  expect(view.display).toContain("in 15");
  expect(view.display).toBe(formatChatUsage([
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001 },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.0005 },
      },
    },
  ]));
});
```

Importar `formatChatUsage` desde `./usage-codec` en este archivo de test.

- [ ] `chat.get` en `api/src/ws/handlers.ts`: después de cargar `messages`, 

```ts
const usage = usageForMessages(messages);
return ok(type, id, { chat, messages, usage });
```

Si ya hay `context` / `diffs` en el objeto, spread: `{ chat, messages, usage, context, diffs }`.

- [ ] GET `/chats/:chatId` en `api/src/routes/workspaces.ts`: igual.

```ts
return c.json({ chat: chatRows[0], messages, usage: usageForMessages(messages) });
```

- [ ] GET `/me/usage` en `api/src/index.ts` junto a GET `/me` (misma auth `requireSession`):

```ts
app.get("/me/usage", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const rows = await db
    .select({
      id: chatMessages.id,
      chatId: chatMessages.chatId,
      createdAt: chatMessages.createdAt,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .innerJoin(chats, eq(chats.id, chatMessages.chatId))
    .where(
      and(
        eq(chats.userId, session.user.id),
        eq(chatMessages.role, "assistant"),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(USAGE_RECENT_SCAN);

  const recent: Array<{
    chatId: string;
    messageId: string;
    createdAt: Date | string;
    provider: string;
    modelId: string | null;
    display: string;
  }> = [];
  for (const row of rows) {
    if (recent.length >= RECENT_USAGE_LIMIT) break;
    const line = formatTurnUsageLine(row.metadata);
    if (!line) continue;
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const display = line;
    assertNoSecrets(display);
    recent.push({
      chatId: row.chatId,
      messageId: row.id,
      createdAt: row.createdAt,
      provider: String(meta.provider || "claude"),
      modelId: typeof meta.modelId === "string" ? meta.modelId : null,
      display,
    });
  }
  return c.json({ recent, emptyText: NO_USAGE_TEXT });
});
```

Importar `chatMessages`, `chats`, `and`, `eq`, `desc` (ya usados en workspaces; añadir imports en `index.ts`). **No** devolver `metadata` crudo ni `content`. **No** incluir secrets.

`assertNoSecrets` que tire → 500 no es aceptable en whoami. Envolver por fila: si `assertNoSecrets` falla, `continue` (omitir ese turn).

- [ ] `app.use("/me/*", corsMiddleware)` ya existe en `api/src/index.ts`. No duplicar.

- [ ] En `api/openapi/openapi.yaml`, documentar GET `/me/usage` (200: `{ recent, emptyText }`) y que GET `/chats/{chatId}` incluye `usage.display`. No inventar JSON schema de tokens unificado.

- [ ] Correr:

```bash
cd api && bun test src/llm/usage-chat.test.ts src/llm/usage-codec.test.ts src/ws/stream-end-usage.test.ts
```

Esperado: todos pasan.

- [ ] Commit:

```bash
git add api/src/llm/usage-chat.ts api/src/llm/usage-chat.test.ts \
  api/src/ws/handlers.ts api/src/routes/workspaces.ts api/src/index.ts \
  api/openapi/openapi.yaml
git commit -m "feat(usage): expose chat aggregate and recent usage without secrets"
```

---

## Task 5: CLI — `chat cost`, `whoami`, watch; nunca imprimir keys

**Files:**

- Modify: `cli/src/commands/whoami.ts`
- Test: `cli/src/commands/whoami.test.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/src/commands/headless-cost.test.ts`

- [ ] Extraer el render de whoami para testearlo sin red. En `cli/src/commands/whoami.ts`:

```ts
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { cwdPath } from "../workspace";
import {
  NO_USAGE_TEXT,
  assertNoSecrets,
} from "../llm/usage-codec";

export type WhoamiUsageRow = {
  chatId: string;
  createdAt?: string | Date;
  provider?: string;
  display: string;
};

export function formatWhoamiUsage(recent: WhoamiUsageRow[] | undefined): string {
  if (!recent?.length) return `Usage reciente: ${NO_USAGE_TEXT}`;
  const lines = ["Usage reciente:"];
  for (const row of recent) {
    const id = row.chatId.slice(0, 8);
    const prov = row.provider || "";
    lines.push(`  ${id} ${prov} ${row.display}`.trimEnd());
  }
  const text = lines.join("\n");
  assertNoSecrets(text);
  return text;
}

export async function whoamiCommand(): Promise<void> {
  const config = loadConfig();
  if (!config.accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
  const me = await apiFetch<{
    user: { id: string; email: string; name: string };
  }>("/me");
  let usageBlock = `Usage reciente: ${NO_USAGE_TEXT}`;
  try {
    const data = await apiFetch<{ recent?: WhoamiUsageRow[] }>("/me/usage");
    usageBlock = formatWhoamiUsage(data.recent);
  } catch {
    usageBlock = `Usage reciente: ${NO_USAGE_TEXT}`;
  }
  const out = [
    `cwd: ${cwdPath()}`,
    `API: ${config.apiUrl}`,
    `User: ${me.user.email} (${me.user.id})`,
    `Name: ${me.user.name}`,
    usageBlock,
  ].join("\n");
  assertNoSecrets(out);
  if (config.accessToken && out.includes(config.accessToken)) {
    throw new Error("whoami leaked accessToken");
  }
  console.log(out);
}
```

Si GET `/me/usage` aún no está en el server (deploy parcial), el catch imprime `sin datos` — no es error, exit 0.

- [ ] `cli/src/commands/whoami.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatWhoamiUsage } from "./whoami";
import { NO_USAGE_TEXT } from "../llm/usage-codec";

test("empty recent is sin datos", () => {
  expect(formatWhoamiUsage([])).toContain(NO_USAGE_TEXT);
  expect(formatWhoamiUsage(undefined)).toContain(NO_USAGE_TEXT);
});

test("prints display without keys", () => {
  const text = formatWhoamiUsage([
    {
      chatId: "abcd1234zzzz",
      provider: "claude",
      display: "in 12 · out 4 · $0.0012",
    },
  ]);
  expect(text).toContain("abcd1234");
  expect(text).toContain("in 12");
  expect(text).not.toContain("sk-ant");
  expect(text.toLowerCase()).not.toContain("effort");
});

test("refuses to format a leaked key", () => {
  expect(() =>
    formatWhoamiUsage([
      { chatId: "x", display: "in 1 sk-ant-api03-LEAK" },
    ]),
  ).toThrow();
});
```

- [ ] `chavez headless chat cost <chatId>` en `cli/src/commands/headless.ts`.

Si `runSlash` / `liveSlashIo` **ya existen** (plan 11), el action `cost` ya está: no duplicarlo. Verificar que usa `formatChatCost` → codec. Añadir un test de que el texto coincide con `formatChatUsage`.

Si **no** existe, añadir el action junto a `get`:

```ts
if (action === "cost") {
  const chatId = rest[0];
  if (!chatId) throw new Error("Uso: chavez headless chat cost <chatId>");
  const res = await client.request({ type: "chat.get", chatId });
  if (!res.ok) throw new Error(res.error);
  const data = res.data as {
    messages?: Array<{ metadata?: unknown }>;
    usage?: { display?: string };
  };
  const text =
    typeof data.usage?.display === "string"
      ? data.usage.display
      : formatChatUsage(data.messages ?? []);
  assertNoSecrets(text);
  console.log(text);
  return;
}
```

Importar `formatChatUsage`, `assertNoSecrets`. Actualizar el `throw` de uso del grupo chat:

```
"Uso: chavez headless chat <create|list|append|get|ask|watch|cost> …"
```

(si ya incluye `compact|undo|clear`, **añadir** `cost` a esa lista, no quitar los otros).

- [ ] `cli/src/index.ts` `usage()`: añadir la línea

```
  chavez headless chat cost <chatId>
```

junto al resto de `headless chat`. No imprimir tokens.

- [ ] Extraer el parse del action para test sin WS. `cli/src/commands/headless-cost.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatChatUsage, NO_USAGE_TEXT } from "../llm/usage-codec";

test("chat.get sidecar display matches formatChatUsage", () => {
  const messages = [
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 12, output_tokens: 4 }, total_cost_usd: 0.0012 },
      },
    },
  ];
  const display = formatChatUsage(messages);
  expect(display).toBe(formatChatUsage(messages));
  expect(display).toContain("in 12");
  expect(display).not.toBe(NO_USAGE_TEXT);
});
```

- [ ] Watch: el dump JSON actual de `chat watch` ya incluirá `data.usage` en `chat.stream.end` / `chat.get` no aplica. No filtrar el JSON (los consumers de watch esperan el event). **Sí** asegurar que `formatWatchLine` si existe (plan 2) añade una línea `usage · ${display}` cuando `msg.type === "chat.stream.end"` y `data.usage?.display` y `display !== NO_USAGE_TEXT`. Si `formatWatchLine` no existe, no crearlo.

- [ ] Correr:

```bash
cd cli && bun test src/commands/whoami.test.ts src/commands/headless-cost.test.ts src/llm/usage-codec.test.ts
```

Esperado: todos pasan. El test de leak **debe** tirar.

- [ ] Commit:

```bash
git add cli/src/commands/whoami.ts cli/src/commands/whoami.test.ts \
  cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/commands/headless-cost.test.ts
git commit -m "feat(usage): whoami recent usage and headless chat cost without keys"
```

---

## Task 6: TUI — mismo display que `/cost`

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json`
- Test: `tui/src/usage-line.test.ts`

TUI importa el codec de CLI (`../../cli/src/llm/usage-codec`). No duplicar en `tui/src`.

- [ ] Ampliar el type `Message`:

```ts
type Message = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};
```

`loadChat` ya asigna `messages` desde `chat.get`; dejar de tirar metadata (hoy el spread del row ya la trae si el type la admite).

Capturar el sidecar:

```ts
const [chatUsage, setChatUsage] = useState<string>("");
```

En `loadChat`:

```ts
const data = res.data as {
  messages?: Message[];
  usage?: { display?: string };
};
setMessages(data.messages ?? []);
setChatUsage(
  typeof data.usage?.display === "string"
    ? data.usage.display
    : formatChatUsage(data.messages ?? []),
);
```

Importar `formatChatUsage`, `NO_USAGE_TEXT`, `formatTurnUsageLine` desde `../../cli/src/llm/usage-codec`.

Al crear chat / cambiar session, `setChatUsage("")`.

- [ ] En el bloque Messages, para cada assistant mostrar una línea dim con `formatTurnUsageLine(m.metadata)` si no es null. El agregado del chat va **debajo** de Messages:

```tsx
<Box marginTop={1} flexDirection="column" height={10}>
  <Text bold>Messages</Text>
  {messages.slice(-8).map((m) => {
    const cost = m.role === "assistant" ? formatTurnUsageLine(m.metadata) : null;
    return (
      <Text key={m.id} wrap="truncate-end">
        <Text color={m.role === "assistant" ? "green" : "magenta"}>
          {m.role}:{" "}
        </Text>
        {m.content.replace(/\s+/g, " ").slice(0, 100)}
        {cost ? <Text dimColor>  ({cost})</Text> : null}
      </Text>
    );
  })}
</Box>
<Text dimColor>
  cost: {chatUsage || NO_USAGE_TEXT}
</Text>
```

No ciclar effort cuando se muestra usage. El header `effort:` y `precios:` del catálogo se quedan (son prefs, no consumo).

- [ ] Tecla `u` en command mode (opcional, no compose): `setLog(chatUsage || NO_USAGE_TEXT)`. Añadir `[u] cost` a la línea de ayuda. No abre picker `/` (plan 11).

- [ ] `tui/package.json`: añadir `"test": "bun test"` si falta.

- [ ] `tui/src/usage-line.test.ts` — no montar Ink. Testea que el string de `formatChatUsage` es el que la TUI pintaría:

```ts
import { describe, expect, test } from "bun:test";
import {
  NO_USAGE_TEXT,
  formatChatUsage,
  formatTurnUsageLine,
} from "../../cli/src/llm/usage-codec";

test("TUI cost line matches /cost", () => {
  const messages = [
    {
      role: "assistant",
      content: "ok",
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 12, output_tokens: 4 } },
      },
    },
  ];
  const display = formatChatUsage(messages);
  expect(display).toContain("in 12");
  expect(formatTurnUsageLine(messages[0]!.metadata)).toContain("in 12");
  expect(formatChatUsage([])).toBe(NO_USAGE_TEXT);
});

test("Cursor optimize_for=cost is not effort", () => {
  const display = formatChatUsage([
    {
      metadata: {
        kind: "turn_usage",
        provider: "cursor",
        modelId: "auto-smart",
        usage: { inputTokens: 2, outputTokens: 1, optimize_for: "cost" },
      },
    },
  ]);
  expect(display.toLowerCase()).not.toContain("effort");
});
```

- [ ] Correr:

```bash
cd tui && bun test src/usage-line.test.ts
```

Esperado: pasa.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/usage-line.test.ts tui/package.json
git commit -m "feat(usage): show native turn and chat cost in TUI"
```

---

## Task 7: Web — panel de costo idéntico a `/cost`

**Files:**

- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Create: `web/src/components/ChatUsagePanel.tsx`
- Test: `web/src/lib/usage-codec.test.ts` (ya en Task 1; añadir casos de panel si hace falta)
- Test: `web/src/components/ChatUsagePanel.test.ts`

Web usa `web/src/lib/usage-codec.ts` (copia). No importar `cli/`.

- [ ] En `web/src/lib/hooks.ts`, ampliar `useChat`:

```ts
import type { ChatUsageView } from "./usage-codec";

export type ChatDetail = {
  chat: Chat;
  messages: ChatMessage[];
  usage?: ChatUsageView;
};
```

`useChat` ya tipa `apiJson<{ chat: Chat; messages: ChatMessage[] }>`. Cambiar a `ChatDetail`. No romper callers: `usage` opcional.

- [ ] Crear `web/src/components/ChatUsagePanel.tsx`:

```tsx
import { NO_USAGE_TEXT, type ChatUsageView } from "../lib/usage-codec";
import type { ChatMessage } from "../lib/hooks";
import { formatChatUsage, formatTurnUsageLine } from "../lib/usage-codec";

export function ChatUsagePanel({
  usage,
  messages,
}: {
  usage?: ChatUsageView | null;
  messages: ChatMessage[];
}) {
  const display =
    usage?.display ?? formatChatUsage(messages);
  return (
    <div className="panel" data-testid="chat-usage">
      <h2>Costo</h2>
      <pre
        style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: "0.85rem" }}
        className={display === NO_USAGE_TEXT ? "muted" : undefined}
      >
        {display}
      </pre>
    </div>
  );
}

export function TurnCostBadge({ message }: { message: ChatMessage }) {
  if (message.role !== "assistant") return null;
  const line = formatTurnUsageLine(message.metadata);
  if (!line) return null;
  return <span className="badge">{line}</span>;
}
```

- [ ] En `ChatDetailPanel.tsx`:

  1. Importar `ChatUsagePanel`, `TurnCostBadge`.
  2. Encima del compositor (después del timeline), renderizar:

```tsx
<ChatUsagePanel usage={chat.data?.usage} messages={messages} />
```

  3. En cada burbuja assistant (no tool), junto al badge de role:

```tsx
<TurnCostBadge message={m} />
```

  4. El `useEffect` de WS ya invalida `queryKeys.chat(chatId)` en `chat.stream.end`. Tras invalidate, `usage` del GET coincide con `/cost`. Si el payload de `chat.stream.end` trae `usage`, se puede setQueryData; no es obligatorio (invalidate basta).

  5. No mostrar `effort` en el panel de costo. El effort del modelo sigue en `ProvidersPanel`.

- [ ] `web/src/components/ChatUsagePanel.test.ts` — sin DOM de Astro; testea las funciones que el panel usa:

```ts
import { describe, expect, test } from "bun:test";
import { formatChatUsage, NO_USAGE_TEXT } from "../lib/usage-codec";

test("web panel matches CLI /cost", () => {
  const messages = [
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 12, output_tokens: 4 }, total_cost_usd: 0.0012 },
      },
    },
  ];
  expect(formatChatUsage(messages)).toContain("in 12");
  expect(formatChatUsage(messages)).toContain("$0.0012");
  expect(formatChatUsage([])).toBe(NO_USAGE_TEXT);
});
```

El contrato “/cost y el panel Web coinciden” = **la misma función** `formatChatUsage` / `usage.display` del API. No hay una segunda fórmula en JSX.

- [ ] Correr:

```bash
cd web && bun test src/lib/usage-codec.test.ts src/components/ChatUsagePanel.test.ts
```

Esperado: pasan.

- [ ] Commit:

```bash
git add web/src/lib/hooks.ts web/src/components/ChatDetailPanel.tsx \
  web/src/components/ChatUsagePanel.tsx web/src/components/ChatUsagePanel.test.ts
git commit -m "feat(usage): web chat cost panel matches /cost display"
```

---

## Task 8: History no ve usage; tools se persisten sin usage — smoke Gherkin

**Files:**

- Test: `cli/src/llm/history.test.ts` (crear o **añadir**)
- Create: `cli/src/llm/usage-scenarios.test.ts`
- Create: `cli/scripts/usage-cost-smoke.ts`
- Modify: `cli/src/llm/history.ts` solo si hace falta tipar `metadata` (no filtrar usage; el LLM no recibe metadata hoy)

- [ ] En `cli/src/llm/history.ts`, ampliar `DbMessage` con `metadata?: unknown` **si** aún no está (slash-commands puede haberlo hecho). **No** filtrar `kind: turn_usage`: el assistant content **sí** va al LLM; el blob no está en `content`. Añadir un comentario de una línea: `// usage lives in metadata; history uses content only`.

- [ ] Test en `cli/src/llm/history.test.ts`:

```ts
import { expect, test } from "bun:test";
import { historyFromChatMessages } from "./history";

test("usage metadata is not copied into LLM history content", () => {
  const history = historyFromChatMessages(
    [
      { role: "user", content: "hola" },
      {
        role: "assistant",
        content: "respuesta",
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "claude-sonnet-4-6",
          usage: { usage: { input_tokens: 99 }, apiKey: "sk-ant-SHOULD-NOT-APPEAR" },
        },
      },
    ],
    "next",
  );
  const dumped = JSON.stringify(history);
  expect(dumped).toContain("respuesta");
  expect(dumped).not.toContain("sk-ant");
  expect(dumped).not.toContain("input_tokens");
});
```

- [ ] `cli/src/llm/usage-scenarios.test.ts` — escenarios Gherkin como tests **solo** de `cli/src/llm/` (no importar `api/`):

```ts
import { describe, expect, test } from "bun:test";
import {
  NO_USAGE_TEXT,
  extractClaudeUsageRaw,
  extractCursorUsageRaw,
  formatChatUsage,
  aggregateChatUsage,
} from "./usage-codec";
import { streamEndPayload } from "./publish-turn";

test("Gherkin: turn reporta usage Claude y Cursor; missing is sin datos", () => {
  const claude = extractClaudeUsageRaw({
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
    total_cost_usd: 0.01,
  });
  expect(claude).toBeTruthy();
  expect(
    formatChatUsage([
      {
        metadata: {
          kind: "turn_usage",
          provider: "claude",
          modelId: "x",
          usage: claude,
        },
      },
    ]),
  ).toContain("in 1");

  const cursor = extractCursorUsageRaw({
    usage: { inputTokens: 4, outputTokens: 5 },
  });
  expect(
    formatChatUsage([
      {
        metadata: {
          kind: "turn_usage",
          provider: "cursor",
          modelId: "y",
          usage: cursor,
        },
      },
    ]),
  ).toContain("in 4");

  expect(extractClaudeUsageRaw({ result: "ok" })).toBeNull();
  expect(
    formatChatUsage([{ role: "assistant", content: "ok", metadata: {} }]),
  ).toBe(NO_USAGE_TEXT);
});

test("Gherkin: agregado del chat suma turns; /cost == panel", () => {
  const messages = [
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "m",
        usage: { usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "m",
        usage: { usage: { input_tokens: 7, output_tokens: 2 } },
      },
    },
  ];
  const a = formatChatUsage(messages);
  const b = aggregateChatUsage(messages).display;
  expect(a).toBe(b);
  expect(a).toContain("in 17");
});

test("Gherkin: Cursor vs Claude — no same schema, Router cost is not effort", () => {
  const view = aggregateChatUsage([
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "m",
        usage: { usage: { input_tokens: 10 } },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "cursor",
        modelId: "auto-smart",
        usage: { inputTokens: 3, optimize_for: "cost" },
      },
    },
  ]);
  expect(view.claude).toHaveProperty("input_tokens", 10);
  expect(view.cursor).toHaveProperty("inputTokens", 3);
  expect(view.claude).not.toHaveProperty("inputTokens");
  expect(view.display.toLowerCase()).not.toContain("effort");
});

test("Gherkin: usage missing does not drop assistant content", () => {
  const p = streamEndPayload({
    chatId: "c",
    streamId: "s",
    content: "assistant lives",
    usageMeta: null,
  });
  expect(p.content).toBe("assistant lives");
  expect(p).not.toHaveProperty("metadata");
});
```

El caso “content vacío + usage sí persiste” vive en `api/src/ws/stream-end-usage.test.ts` (Task 3). No cruzar imports cli↔api.

- [ ] Crear `cli/scripts/usage-cost-smoke.ts`:

```ts
/**
 * Smoke: persist usage metadata via chat.append stand-in, chat.get aggregate,
 * /me/usage shape, no secrets. Live Claude result is optional.
 *
 * Needs: chavez login, API up. Does not require a provider turn.
 */
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { apiFetch } from "../src/api-client";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  NO_USAGE_TEXT,
  USAGE_META_KIND,
  formatChatUsage,
  assertNoSecrets,
} from "../src/llm/usage-codec";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
  process.exit(1);
}

const client = new ChavezWsClient(token);
await client.connect();
const bound = await client.bind(cwdPath(), "client");
if (!bound.ok) throw new Error(bound.error || "bind failed");

const sessionRes = await client.request({
  type: "session.create",
  title: `usage-smoke ${Date.now()}`,
});
if (!sessionRes.ok) throw new Error(sessionRes.error);
const sessionId = (sessionRes.data as { session: { id: string } }).session.id;
const chatRes = await client.request({
  type: "chat.create",
  sessionId,
  title: "usage-smoke",
});
if (!chatRes.ok) throw new Error(chatRes.error);
const chatId = (chatRes.data as { chat: { id: string } }).chat.id;

const empty = await client.request({ type: "chat.get", chatId });
if (!empty.ok) throw new Error(empty.error);
const emptyUsage = (empty.data as { usage?: { display?: string } }).usage;
const emptyDisplay =
  emptyUsage?.display ??
  formatChatUsage(
    (empty.data as { messages?: Array<{ metadata?: unknown }> }).messages ?? [],
  );
assert.equal(emptyDisplay, NO_USAGE_TEXT);

const append = await client.request({
  type: "chat.append",
  chatId,
  role: "assistant",
  content: "ok-from-smoke",
  metadata: {
    kind: USAGE_META_KIND,
    provider: "claude",
    modelId: "claude-sonnet-4-6",
    usage: {
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 1 },
      total_cost_usd: 0.0012,
      apiKey: "sk-ant-SHOULD-BE-STRIPPED-IF-HANDLER-STRIPS-APPEND",
    },
  },
});
if (!append.ok) throw new Error(append.error);

const got = await client.request({ type: "chat.get", chatId });
if (!got.ok) throw new Error(got.error);
const data = got.data as {
  messages: Array<{ content?: string; metadata?: unknown }>;
  usage?: { display?: string; hasData?: boolean };
};
assert.ok(data.messages.some((m) => m.content === "ok-from-smoke"));
const display = data.usage?.display ?? formatChatUsage(data.messages);
assert.match(display, /in 12/);
assert.match(display, /out 4/);
assert.notEqual(display, NO_USAGE_TEXT);
assertNoSecrets(JSON.stringify(data));
assert.doesNotMatch(JSON.stringify(data), /sk-ant-SHOULD/);

const http = await apiFetch<{
  messages: typeof data.messages;
  usage?: { display?: string };
}>(`/chats/${chatId}`, {}, token);
assert.equal(http.usage?.display ?? formatChatUsage(http.messages), display);

const meUsage = await apiFetch<{ recent?: Array<{ display: string }> }>(
  "/me/usage",
  {},
  token,
);
assertNoSecrets(JSON.stringify(meUsage));
console.log("whoami-shaped", meUsage.recent?.[0]?.display ?? NO_USAGE_TEXT);

client.close();
console.log("SMOKE PASS");
```

Nota: `chat.append` hoy **no** corre `stripUsageSecrets`. El smoke no debe fallar si el apiKey sobrevive en un append manual — el strip obligatorio es `chat.stream.end` (Task 3). Ajustar el assert: si el JSON de `chat.get` aún contiene `sk-ant-SHOULD`, **no** fallar el smoke; `console.warn` y seguir. El assert estricto de secrets aplica a `formatChatUsage(display)` y a GET `/me/usage` (que no devuelve metadata). Cambiar a:

```ts
assertNoSecrets(display);
assertNoSecrets(JSON.stringify(meUsage));
```

No exigir que `chat.append` redacte: ese path es manual y no es el runner.

- [ ] Correr unitarios:

```bash
cd cli && bun test src/llm/usage-codec.test.ts src/llm/usage-scenarios.test.ts \
  src/llm/publish-turn.test.ts src/llm/claude-runner.test.ts \
  src/commands/whoami.test.ts src/commands/headless-cost.test.ts \
  src/llm/history.test.ts
cd api && bun test src/llm/usage-codec.test.ts src/llm/usage-chat.test.ts \
  src/ws/stream-end-usage.test.ts
cd web && bun test src/lib/usage-codec.test.ts src/components/ChatUsagePanel.test.ts
cd tui && bun test src/usage-line.test.ts
```

Esperado: todos pasan.

- [ ] Smoke (API + login + WS; **sin** LLM vivo):

```bash
cd cli && bun run scripts/usage-cost-smoke.ts
```

Esperado: `SMOKE PASS`. `chat.get.usage.display` coincide con GET `/chats/:id`. Vacío → `sin datos`.

- [ ] Commit:

```bash
git add cli/src/llm/history.ts cli/src/llm/history.test.ts \
  cli/src/llm/usage-scenarios.test.ts cli/scripts/usage-cost-smoke.ts
git commit -m "test(usage): gherkin scenarios, history isolation, chat.get smoke"
```

---

## Orden de ejecución

1. Task 1 (codec puro, tres copias) — no depende de API ni del runner.
2. Task 2 (Claude runner + publish-turn payload) — depende de 1.
3. Task 3 (Cursor opcional + persistencia stream.end) — depende de 1; API en paralelo a 2 una vez 1 mergeó.
4. Task 4 (`chat.get` / `/me/usage`) — depende de 1 y del helper persist de 3.
5. Task 5 (CLI whoami + cost) — depende de 4 para el HTTP; el formatter funciona desde 1.
6. Task 6 (TUI) y Task 7 (Web) — paralelizables tras 1 y 4.
7. Task 8 (smoke Gherkin) — al final.

## Verificación Gherkin → task

| Escenario | Dónde se cubre |
|---|---|
| Turn Claude o Cursor termina → se guarda JSON crudo de usage | Task 2 `emitClaudeResultUsage` + `streamEndPayload`; Task 3 Cursor `extractCursorUsageRaw` + `prepareStreamEndMeta`; crudo en `metadata.usage` |
| Se muestran input/output/cache si vienen | Task 1 `formatTokenParts`; Task 6 TUI; Task 7 `TurnCostBadge` / panel |
| Si no vienen, `sin datos` no es error | Task 1 `formatChatUsage([])`; Task 3 persist assistant sin metadata; Task 5 whoami catch; Task 8 smoke chat vacío |
| Detalle de chat suma turns | Task 1 `aggregateChatUsage`; Task 4 `usageForMessages` |
| `/cost` y panel Web coinciden | Misma `formatChatUsage` / `usage.display`; Task 5 `chat cost`; Task 7 `ChatUsagePanel`; Task 8 compara WS vs HTTP |
| No se fuerza el mismo schema Claude/Cursor | Task 1 totales `input_tokens` vs `inputTokens` separados; test mixto |
| Router/cost de Cursor no se etiqueta effort | Task 1 test `optimize_for: "cost"`; Task 6/8 `not.toContain("effort")` |
| whoami / CLI ven usage reciente | Task 4 GET `/me/usage`; Task 5 `formatWhoamiUsage` |
| No se imprimen keys | Task 1 `stripUsageSecrets` / `assertNoSecrets`; Task 5 whoami test leak; Task 8 `/me/usage` |
| Provider no manda usage → assistant y tools igual se persisten | Task 2 stream.end sin metadata con content; tools no se tocan; Task 3 `shouldPersistAssistant("hello", {}) === true` |

## Fuera de este plan (no implementar)

- Slash picker `/` y dispatcher `/cost` → [slash-commands](../slash-commands/plan.md). Aquí se **produce** el string que ese comando imprime. Si slash ya tiene `formatChatCost`, se conecta al codec.
- Presupuesto de ventana / compact → [context-compact](../context-compact/plan.md). `chat.context.usage` no es billing.
- Cursor ejecutable, catálogo crudo, `optimize_for` como param de modelo → [cursor-provider](../cursor-provider/plan.md). Aquí solo se **lee** usage del `wait()` si existe.
- Invoice, límites de plan Anthropic/Cursor, spend alerts, notificaciones OS/email.
- Cola de turns, worktrees paralelos, Cursor cloud, voz, extensión IDE, upload desde el navegador.
