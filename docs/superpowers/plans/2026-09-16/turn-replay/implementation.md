# Turn replay Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, export/import/share (plan 23), slash `/replay` (plan 11), cola de turns (plan 29), undo (plan 12), ni notificaciones OS/email. Spec: [`plan.md`](./plan.md). Depende de mensajes persistidos (`chat_messages` + `streamId`), tools ([`agent-tools`](../agent-tools/implementation.md)), attaches ([`attach-files`](../attach-files/implementation.md)), diffs ([`diffs-review`](../diffs-review/implementation.md): preview por `streamId`, **sin** body), usage ([`usage-cost`](../usage-cost/implementation.md): JSON crudo, `sin datos` si falta), modos ([`execution-modes`](../execution-modes/implementation.md): `metadata.executionMode`), redacción ([`invariants`](../invariants/implementation.md) / [`ignore-secrets`](../ignore-secrets/implementation.md)) y dump de CI ([`ci-headless`](../ci-headless/implementation.md): **texto**, no JSON schema). Si un sibling ya creó un archivo citado, **extiéndelo**; no lo reescribas.

**Goal:** El dueño del chat abre el **replay de un turn terminado** y ve, **en este orden**, prompt, attaches, tools, diffs, assistant, usage, modo y modelo. Web y TUI coinciden (mismas secciones, mismo texto canónico). No hay API keys ni valores de `.env`. Los outputs de tools **siguen truncados**. Replay es **solo lectura**: no despacha un turn, no llama al LLM, no vuelve a correr bash. CLI `chavez headless chat dump <chatId> [streamId]` vuelca esa traza a stdout (útil en CI, plan 25).

**Architecture:** El filesystem y el runner viven en el daemon. Replay **no los toca**. La API arma el documento a partir de filas ya persistidas (`chat_messages` + `turn_file_diffs` si existe) y lo redacta otra vez. No hay tabla nueva. No hay migración. Sin daemon bound el dump **sigue funcionando** (es `chat.get` + ensamblado, no `agent.turn.request`).

```
Turn terminado (ya persistido)
  user     metadata.streamId + executionMode + attachments + prompt
  tool[]   metadata.streamId + toolName + status + input + output truncado
  diffs[]  turn_file_diffs preview (si plan 6 aterrizó)
  assistant metadata.streamId + usage + modelId
        |
        v
  chat.replay / GET /chats/:chatId/replay
        |  loadChatForUser (404 ajeno)
        |  assembleTurnReplay  (puro, orden fijo)
        |  redact belt
        |  NUNCA hub.findDaemon
        |  NUNCA agent.turn.dispatch
        v
  { replay: TurnReplay, text: formatTurnReplay(replay) }
        |
        +-- CLI  chat dump   → stdout = text
        +-- TUI  tecla L     → overlay con text
        +-- Web  ReplayPanel → mismas secciones
        +-- CI   puede llamar dump tras `chavez ci`
```

Estado actual que este plan extiende (no reescribir):

- `cli/src/llm/publish-turn.ts` genera `streamId` **después** del `chat.append` user y **no** estampa `streamId` / `executionMode` / `modelId` en el user. El assistant de `chat.stream.end` sí lleva `metadata.streamId` (handlers). Tools **hoy** no llevan `streamId` en `chat.tool.start` (el plan 2 lo añade). Esta fase: (1) genera `streamId` **antes** del append user; (2) lo estampa en user + tool + stream; (3) el assembler agrupa también por “user precedente” si un sibling aún no estampó.
- `api/src/ws/handlers.ts` `chat.get` y `GET /chats/:chatId` (`api/src/routes/workspaces.ts`) devuelven `{ chat, messages }`. **No** hay `chat.replay`.
- `api/src/db/schema.ts` `chat_messages.metadata` jsonb **ya existe**. **No** hay tabla de replay. `turn_file_diffs` la crea el plan 6: si **no** está en el schema, diffs = `[]` y se omite la sección. **Sin migración.**
- Web `ChatDetailPanel.tsx`: timeline role/content + `ToolCard`. Sin agrupación por turn, sin botón Replay.
- TUI `tui/src/App.tsx`: `Message = { id, role, content }` (plan 2 añade metadata). Teclas actuales `s` `c` `m` `p` `[` `]` `{` `}` `q`. **No** hay `L`. Escape mata la TUI (el plan 5 lo cambia en compose; aquí Escape en overlay de replay **cierra el overlay**, no la TUI).
- CLI `chavez headless chat` : `create|list|append|get|ask|watch`. **No** hay `dump`. `chat get` vuelca JSON crudo (puede contener keys si un sibling no redactó: el dump **nunca**).
- `cli/src/llm/history.ts` tira `role=tool` al armar el prompt. Replay **no** llama a `historyFromChatMessages` ni a `query()`.
- Redact: `cli/src/llm/redact.ts` + `api/src/lib/redact.ts` los crean planes 5/8. Si existen, el assembler los usa (inyectados). Si no, el módulo trae los mismos `PATTERNS` (keep-in-sync).
- Usage: `cli/src/llm/usage-codec.ts` lo crea el plan 15. El dump **no** lo importa (evita archivo ausente); formatea `turn: in N · out M` con las keys nativas o imprime `sin datos`.
- Truncado de tools: `TOOL_OUTPUT_MAX_CHARS = 8000` (plan 2). Replay **reaplica** el tope; no rehidrata el output original.
- Cursor `runnable: false` hasta el plan 4. Un turn Cursor que hubiera persistido (cuando exista) se replay-ea igual: es lectura de filas. **No** simular un turn Cursor. **No** llamar al SDK.
- Plan 25 (`chavez ci`) produce un log **en vivo**. Esta fase es el dump **a posteriori** del mismo turn. No se cambia el runner de CI. No hay JSON schema. Cero `.github/workflows`.

**Tech Stack:** Bun, Hono WebSocket hub, Drizzle `chat_messages.metadata` jsonb (**sin** tabla nueva, **sin** migración), Ink TUI, Astro/React web. Tests: `bun test`. Web y API **no** importan CLI: copiar `turn-replay.ts` (comentario keep-in-sync). TUI importa `cli/src/llm/turn-replay.ts`. Sin paquete extra. Sin spawn, sin git, sin LLM.

**Global Constraints:**

1. El filesystem real vive en el daemon. Replay **no** lee el cwd, **no** hidrata `@` otra vez, **no** calcula diffs contra disco. Solo filas ya persistidas.
2. Un turn de agente solo corre si hay daemon bound. Replay **no** es un turn: `chat.replay` y `GET /chats/:chatId/replay` **funcionan sin daemon**. No devolver `NO_DAEMON_ERROR`.
3. Web, TUI y CLI dump muestran el **mismo** documento (mismas secciones, mismo `text`). Un reload reconstruye desde `chat.replay` / GET; no hay estado local de “replay en vivo”.
4. Provider, modelo, esfuerzo y **modo** se leen de `metadata` del turn (estampados al persistir). No se leen las preferencias actuales: el replay muestra lo que **ese** turn usó. Si un campo no está, se imprime `—`, no un default inventado (`ask` / modelo activo de hoy).
5. Claude es ejecutable hoy. Cursor vinculado no ejecuta turns aquí. Un replay de un turn Claude (o Cursor, si ya hay filas) no llama al provider.
6. Tools históricas se **muestran**. No se re-ejecutan. `Bun.spawn`, `query()`, `runClaudeTurn`, `runCursorTurn`, `canUseTool` y `agent.turn.dispatch` están **prohibidos** en el path de replay.
7. Lecturas no piden confirmación (no hay tools que correr). Write/edit/bash del turn original ya ocurrieron; el dump solo pinta el rastro.
8. Aprobaciones una a una: un tool `awaiting_approval` significa que el turn **no** terminó → `REPLAY_TURN_RUNNING`. No hay botón approve en el overlay de replay.
9. 1 turn por daemon no aplica a replay (no corre nada). Un dump concurrente con un turn en curso del **mismo** `streamId` falla `REPLAY_TURN_RUNNING`; otro `streamId` ya terminado sí se dump-ea.
10. Un usuario = su vault. Chat ajeno → **404** `"Chat not found"` (no 403). Sin sesión → **401**. El 404 no incluye emails ni ids de otros.
11. Secretos: API keys (`sk-ant-`, `ghp_`, `xox…`, Bearer, PEM), líneas `.env` (`KEY=value` → `KEY=***`), vault `~/.chavez/**` y keys `api_key`/`token`/`secret`/`password`/`authorization`/`credential` se sustituyen por `***` **antes** de devolver `replay` / `text`. Attaches: path + kind + status + preview de texto acotado; **nunca** `imageBase64` ni bytes binarios.
12. Outputs de tools se vuelven a truncar a `TOOL_OUTPUT_MAX_CHARS`. Diffs: solo `preview` (máx. líneas del plan 6); el dump **no** llama `chat.diff.get` ni GET `.../diffs/:id`.
13. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, export markdown/JSON del chat entero (plan 23), slash `/replay`, GitHub Action, JSON schema del dump, re-hidratación de attaches, body completo de diffs.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `REPLAY_SECTION_ORDER` | `prompt`, `attaches`, `tools`, `diffs`, `assistant`, `usage` |
| `TOOL_OUTPUT_MAX_CHARS` | `8000` (reusar plan 2; si `tool-display.ts` existe, importar en CLI **solo** en tests de paridad, no en el keep-in-sync) |
| `REPLAY_ATTACH_PREVIEW_CHARS` | `500` |
| `REPLAY_MISSING` | `"—"` |
| `NO_USAGE_TEXT` | `"sin datos"` (mismo literal que plan 15 / slash `/cost`) |
| `REDACT_REPLACEMENT` | `"***"` |
| `REPLAY_NO_TURN` | `"No finished turn to replay"` |
| `REPLAY_TURN_RUNNING` | `"Turn is still running — replay is for finished turns"` |
| `REPLAY_NOT_FOUND` | `"Turn not found"` |
| `DUMP_USAGE` | `"Uso: chavez headless chat dump <chatId> [streamId]"` |
| `DUMP_HUB_HINT` | `"Replay: chavez headless chat dump <chatId> [streamId]  → traza texto (prompt, attaches, tools, diffs, assistant, usage, modo, modelo). Sin secrets. No re-ejecuta."` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` (reusar; **no** usarla en replay) |
| `TUI_REPLAY_KEY` | `"L"` |
| `TUI_REPLAY_HINT` | `"[L] replay último turn  [Esc] cierra replay"` |

`REPLAY_SECTION_ORDER` **no** incluye `mode`/`model` como `##` : van en el **header** del documento (líneas `mode:` / `model:` / `provider:`) para que Gherkin “veo … modo, modelo” se cumpla siempre, incluso si no hay tools.

Tipos (congelados):

```ts
export type ReplayStatus = "completed" | "error" | "cancelled" | "undone";

export type ReplayAttach = {
  path: string;
  kind: string;       // text | image | binary | directory | …
  status: string;     // ok | ignored | secret | …
  preview: string;    // texto acotado + redactado; "" si image/binary
};

export type ReplayTool = {
  toolCallId: string;
  name: string;       // canónico en minúsculas (bash, write, …)
  status: string;     // done | error | running | awaiting_approval
  input: unknown;     // ya redactado
  output: string;     // truncado + redactado
  kind?: string;      // mcp | skill | subagent | native (si viene)
  createdAt: string;
};

export type ReplayDiff = {
  path: string;
  kind: "created" | "modified" | "deleted" | string;
  status: string;     // applied | proposed (rejected se omite)
  additions: number;
  deletions: number;
  preview: string;    // ya truncado en persistencia; se re-acota
  truncated: boolean;
};

export type TurnReplay = {
  chatId: string;
  streamId: string;
  status: ReplayStatus;
  executionMode: string | null; // plan | auto | ask | null
  provider: string | null;      // claude | cursor | null
  modelId: string | null;
  effort: string | null;
  prompt: string;
  attaches: ReplayAttach[];
  tools: ReplayTool[];
  diffs: ReplayDiff[];
  assistant: string;
  error: string | null;
  usageDisplay: string;         // "turn: in N · out M · $X" | "sin datos"
};

export type ReplayResult =
  | { ok: true; replay: TurnReplay; text: string }
  | { ok: false; error: string };
```

Texto canónico (`formatTurnReplay`) — **este** string es el contrato entre CLI / TUI / Web / CI:

```
turn <streamId>
status: completed
mode: auto
model: claude-sonnet-4-6
provider: claude

## prompt
<prompt redactado>

## attaches
@ src/foo.ts  text  ok
  <preview ≤500 chars si kind=text|directory>
@ assets/logo.png  image  ok

## tools
tool · bash · done
  in: ls -la
  out: <truncado>

## diffs
src/foo.ts  modified  +3 −1
  <preview>

## assistant
<texto>

## usage
turn: in 12 · out 4 · $0.0012
```

Reglas del string:

- Header siempre: `turn`, `status`, `mode`, `model`, `provider` (faltantes = `—`). `effort` **no** se imprime como `mode` ni como `optimize_for` de Cursor (plan 4 / 15).
- Secciones `## attaches` / `## tools` / `## diffs` se **omiten** si el array está vacío (no “0 archivos”).
- `## prompt`, `## assistant`, `## usage` siempre. Assistant vacío → sección con línea vacía. Usage sin blob → `sin datos`.
- Si `error` no es null, tras `## assistant` va `## error` + el motivo redactado.
- Prohibido: la palabra `secret` en claro si era un valor; JSON envelope de `chat watch`; `imageBase64`; ciphertext del vault.
- `status: undone` si `metadata.undone` (plan 12). Sigue siendo replayable.

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `chat.replay` | cliente → API | `{ chatId, streamId? }` → `{ replay, text }`. Sin `streamId` = último turn **terminado**. **No** fan-out. **No** daemon. |
| `chat.get` | RPC | Sin cambios de contrato. Replay no lo sustituye. |
| `agent.turn.request` / `dispatch` | — | **Prohibido** en este path. |

HTTP:

| Método | Ruta | Devuelve |
|---|---|---|
| `GET` | `/chats/:chatId/replay` | `{ replay, text }` — query `streamId` opcional |
| `GET` | `/chats/:chatId` | intacto (plan 6 puede haber añadido `diffs`) |

401 sin sesión. 404 chat ajeno o inexistente (`Chat not found`). 409 `{ error: REPLAY_TURN_RUNNING }` si el `streamId` pedido (o el último) sigue `running` / `awaiting_approval`. 404 `{ error: REPLAY_NOT_FOUND }` si se pidió un `streamId` que no es de este chat. 404 `{ error: REPLAY_NO_TURN }` si el chat no tiene ningún turn terminado y no se pasó `streamId`.

---

## Task 1: Módulo puro — agrupar, ordenar, redactar, formatear

**Files:**

- Create: `cli/src/llm/turn-replay.ts`
- Test: `cli/src/llm/turn-replay.test.ts`
- Create: `api/src/llm/turn-replay.ts`
- Test: `api/src/llm/turn-replay.test.ts`
- Create: `web/src/lib/turn-replay.ts`
- Test: `web/src/lib/turn-replay.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`

Módulo puro. Sin I/O, sin `Bun.spawn`, sin `child_process`, sin WS, sin `query`. TUI importa `cli/src/llm/turn-replay.ts`. API y Web copian el archivo **idéntico** (primera línea keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`build` intactos).

- [ ] Crear `cli/src/llm/turn-replay.ts` con este contenido (copiar **idéntico** a `api/src/llm/turn-replay.ts` y `web/src/lib/turn-replay.ts`; primera línea: `/** keep-in-sync: cli/src/llm/turn-replay.ts */`):

```ts
/** keep-in-sync: cli/src/llm/turn-replay.ts */

export const TOOL_OUTPUT_MAX_CHARS = 8000;
export const REPLAY_ATTACH_PREVIEW_CHARS = 500;
export const REPLAY_MISSING = "—";
export const NO_USAGE_TEXT = "sin datos";
export const REDACT_REPLACEMENT = "***";
export const REPLAY_NO_TURN = "No finished turn to replay";
export const REPLAY_TURN_RUNNING = "Turn is still running — replay is for finished turns";
export const REPLAY_NOT_FOUND = "Turn not found";
export const DUMP_USAGE = "Uso: chavez headless chat dump <chatId> [streamId]";
export const DUMP_HUB_HINT =
  "Replay: chavez headless chat dump <chatId> [streamId]  → traza texto (prompt, attaches, tools, diffs, assistant, usage, modo, modelo). Sin secrets. No re-ejecuta.";
export const TUI_REPLAY_HINT = "[L] replay último turn  [Esc] cierra replay";

export const REPLAY_SECTION_ORDER = [
  "prompt",
  "attaches",
  "tools",
  "diffs",
  "assistant",
  "usage",
] as const;

export type ReplayStatus = "completed" | "error" | "cancelled" | "undone";

export type ReplayAttach = {
  path: string;
  kind: string;
  status: string;
  preview: string;
};

export type ReplayTool = {
  toolCallId: string;
  name: string;
  status: string;
  input: unknown;
  output: string;
  kind?: string;
  createdAt: string;
};

export type ReplayDiff = {
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
};

export type TurnReplay = {
  chatId: string;
  streamId: string;
  status: ReplayStatus;
  executionMode: string | null;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
  prompt: string;
  attaches: ReplayAttach[];
  tools: ReplayTool[];
  diffs: ReplayDiff[];
  assistant: string;
  error: string | null;
  usageDisplay: string;
};

export type ReplayChatMessage = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
};

export type ReplayDiffRow = {
  streamId?: string | null;
  path?: string | null;
  kind?: string | null;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
  preview?: string | null;
  truncated?: boolean | null;
  body?: string | null;
};

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
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const ENV_LINE =
  /^([A-Za-z_][A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|[A-Za-z0-9_]*))\s*=\s*(.+)$/gm;

const VAULT_PATH_RE = /(?:^|[^\w.])(?:~\/)?\.chavez\/[A-Za-z0-9._\-\/]+/g;

const CANONICAL: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "grep",
  Glob: "glob",
  LS: "glob",
  Bash: "bash",
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function iso(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

export function redactReplayText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  out = out.replace(ENV_LINE, (full, k, val) => {
    if (String(val).trim() === "" || String(val) === REDACT_REPLACEMENT) return full;
    return `${k}=${REDACT_REPLACEMENT}`;
  });
  out = out.replace(VAULT_PATH_RE, (m) => {
    const prefix = m[0] === "~" || m[0] === "." ? "" : m[0];
    return `${prefix}${REDACT_REPLACEMENT}`;
  });
  return out;
}

export function redactReplayJson(value: unknown): unknown {
  if (typeof value === "string") return redactReplayText(value);
  if (Array.isArray(value)) return value.map(redactReplayJson);
  const obj = rec(value);
  if (obj) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactReplayJson(v);
    }
    return out;
  }
  return value;
}

export function truncateReplayText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function canonicalReplayToolName(sdkName: string): string {
  return CANONICAL[sdkName] ?? sdkName.toLowerCase() || "tool";
}

function metaOf(m: ReplayChatMessage): Record<string, unknown> {
  return rec(m.metadata) ?? {};
}

export function streamIdOf(m: ReplayChatMessage): string | null {
  const meta = metaOf(m);
  const raw = meta.streamId;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function isRunningStatus(status: unknown): boolean {
  return status === "running" || status === "awaiting_approval";
}

export function isTurnFinished(
  tools: ReplayChatMessage[],
  assistant: ReplayChatMessage | undefined,
  error: string | null,
): boolean {
  if (tools.some((t) => isRunningStatus(metaOf(t).status))) return false;
  return Boolean(assistant || error);
}

function summarizeInput(input: unknown): string {
  const clean = redactReplayJson(input);
  if (typeof clean === "string") return truncateReplayText(clean, 200);
  const obj = rec(clean);
  if (!obj) return clean == null ? "" : truncateReplayText(JSON.stringify(clean), 200);
  const cmd = obj.command ?? obj.cmd;
  const path = obj.file_path ?? obj.path ?? obj.notebook_path;
  if (typeof cmd === "string") return truncateReplayText(cmd, 200);
  if (typeof path === "string") return path;
  return truncateReplayText(JSON.stringify(obj), 200);
}

function attachPreview(att: Record<string, unknown>): string {
  const kind = String(att.kind || "text");
  if (kind === "image" || kind === "binary") return "";
  const raw =
    typeof att.hydratedText === "string"
      ? att.hydratedText
      : typeof att.preview === "string"
        ? att.preview
        : "";
  const path = String(att.path || "");
  const looksEnv = /(^|\/)\.env(\.|$)/.test(path) || path.endsWith(".pem");
  const text = looksEnv
    ? redactReplayText(raw).replace(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/gm,
        (full, k, v) =>
          !String(v).trim() || v === REDACT_REPLACEMENT
            ? full
            : `${k}=${REDACT_REPLACEMENT}`,
      )
    : redactReplayText(raw);
  return truncateReplayText(text, REPLAY_ATTACH_PREVIEW_CHARS);
}

function usageDisplayFromMeta(meta: unknown): string {
  const m = rec(meta);
  if (!m) return NO_USAGE_TEXT;
  const blob =
    rec(m.usage) ||
    rec(m.tokenUsage) ||
    (m.kind === "turn_usage" ? rec(m.usage) : null) ||
    m;
  const input =
    num(blob.input_tokens) ??
    num(blob.inputTokens) ??
    num(m.input_tokens) ??
    num(m.inputTokens);
  const output =
    num(blob.output_tokens) ??
    num(blob.outputTokens) ??
    num(m.output_tokens) ??
    num(m.outputTokens);
  const cache =
    num(blob.cache_read_input_tokens) ??
    num(blob.cacheReadInputTokens) ??
    num(blob.cacheReadTokens);
  const usd =
    num(blob.total_cost_usd) ??
    num(blob.costUSD) ??
    num(blob.costUsd) ??
    num(m.total_cost_usd);
  const parts: string[] = [];
  if (input != null) parts.push(`in ${input}`);
  if (output != null) parts.push(`out ${output}`);
  if (cache != null) parts.push(`cache ${cache}`);
  if (usd != null) {
    parts.push(usd >= 0.0001 ? `$${usd.toFixed(4)}` : "<$0.0001");
  }
  return parts.length ? `turn: ${parts.join(" · ")}` : NO_USAGE_TEXT;
}

function strField(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export type AssembleInput = {
  chatId: string;
  messages: ReplayChatMessage[];
  diffs?: ReplayDiffRow[];
  streamId?: string | null;
};

export type AssembleOk = { ok: true; replay: TurnReplay };
export type AssembleErr = { ok: false; error: string };
export type AssembleOutput = AssembleOk | AssembleErr;

function collectStreamIds(messages: ReplayChatMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const id = streamIdOf(m);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function precedingUser(
  messages: ReplayChatMessage[],
  firstIdx: number,
): ReplayChatMessage | undefined {
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return undefined;
}

function sliceForStream(
  messages: ReplayChatMessage[],
  streamId: string,
): {
  user?: ReplayChatMessage;
  tools: ReplayChatMessage[];
  assistant?: ReplayChatMessage;
  error: string | null;
} {
  const indexed = messages.map((m, i) => ({ m, i }));
  const own = indexed.filter(({ m }) => streamIdOf(m) === streamId);
  const tools = own.filter(({ m }) => m.role === "tool").map(({ m }) => m);
  const assistant = own.find(({ m }) => m.role === "assistant")?.m;
  const taggedUser = own.find(({ m }) => m.role === "user")?.m;
  const firstOwn = own[0];
  const user =
    taggedUser ??
    (firstOwn ? precedingUser(messages, firstOwn.i) : undefined);
  let error: string | null = null;
  for (const { m } of own) {
    const meta = metaOf(m);
    if (typeof meta.error === "string" && meta.error) error = meta.error;
    if (m.role === "system" && typeof m.content === "string" && /error/i.test(String(meta.kind || ""))) {
      error = m.content;
    }
  }
  return { user, tools, assistant, error };
}

function replayStatus(
  tools: ReplayChatMessage[],
  assistant: ReplayChatMessage | undefined,
  error: string | null,
): ReplayStatus {
  const undone =
    (assistant && metaOf(assistant).undone === true) ||
    tools.some((t) => metaOf(t).undone === true);
  if (undone) return "undone";
  const cancelled =
    metaOf(assistant ?? {}).cancelled === true ||
    error === "Turn cancelled";
  if (cancelled) return "cancelled";
  if (error) return "error";
  return "completed";
}

function mapAttaches(user: ReplayChatMessage | undefined): ReplayAttach[] {
  const meta = user ? metaOf(user) : {};
  const raw = meta.attachments;
  if (!Array.isArray(raw)) return [];
  const out: ReplayAttach[] = [];
  for (const item of raw) {
    const att = rec(item);
    if (!att) continue;
    const path = String(att.path || "");
    if (!path) continue;
    out.push({
      path,
      kind: String(att.kind || "text"),
      status: String(att.status || "ok"),
      preview: attachPreview(att),
    });
  }
  return out;
}

function mapTools(tools: ReplayChatMessage[]): ReplayTool[] {
  return tools.map((t) => {
    const meta = metaOf(t);
    const sdk = String(meta.sdkName || meta.toolName || t.content || "tool");
    const outputRaw =
      typeof meta.output === "string"
        ? meta.output
        : typeof t.content === "string"
          ? t.content
          : "";
    return {
      toolCallId: String(meta.toolCallId || t.id || ""),
      name: canonicalReplayToolName(sdk),
      status: String(meta.status || "done"),
      input: redactReplayJson(meta.input ?? null),
      output: truncateReplayText(redactReplayText(outputRaw), TOOL_OUTPUT_MAX_CHARS),
      kind: typeof meta.kind === "string" ? meta.kind : undefined,
      createdAt: iso(t.createdAt),
    };
  });
}

function mapDiffs(rows: ReplayDiffRow[] | undefined, streamId: string): ReplayDiff[] {
  if (!rows?.length) return [];
  return rows
    .filter((d) => !d.streamId || d.streamId === streamId)
    .filter((d) => d.status !== "rejected")
    .map((d) => ({
      path: String(d.path || ""),
      kind: String(d.kind || "modified"),
      status: String(d.status || "applied"),
      additions: num(d.additions) ?? 0,
      deletions: num(d.deletions) ?? 0,
      preview: truncateReplayText(redactReplayText(String(d.preview || "")), TOOL_OUTPUT_MAX_CHARS),
      truncated: Boolean(d.truncated),
    }))
    .filter((d) => d.path);
}

export function assembleTurnReplay(input: AssembleInput): AssembleOutput {
  const messages = input.messages ?? [];
  const ids = collectStreamIds(messages);
  const wanted = input.streamId?.trim() || ids[ids.length - 1] || null;
  if (!wanted) {
    // Legacy: último user + tools siguientes + assistant, sin streamId.
    const lastUserIdx = [...messages]
      .map((m, i) => ({ m, i }))
      .reverse()
      .find((x) => x.m.role === "user")?.i;
    if (lastUserIdx == null) return { ok: false, error: REPLAY_NO_TURN };
    const user = messages[lastUserIdx]!;
    const rest = messages.slice(lastUserIdx + 1);
    const tools = rest.filter((m) => m.role === "tool");
    const assistant = rest.find((m) => m.role === "assistant");
    if (!isTurnFinished(tools, assistant, null)) {
      return { ok: false, error: REPLAY_TURN_RUNNING };
    }
    return buildReplay({
      chatId: input.chatId,
      streamId: `legacy-${String(user.id || lastUserIdx)}`,
      user,
      tools,
      assistant,
      error: null,
      diffs: input.diffs,
    });
  }
  if (input.streamId?.trim() && !ids.includes(wanted) && !messages.some((m) => streamIdOf(m) === wanted)) {
    return { ok: false, error: REPLAY_NOT_FOUND };
  }
  const slice = sliceForStream(messages, wanted);
  if (!slice.user && !slice.tools.length && !slice.assistant) {
    return { ok: false, error: REPLAY_NOT_FOUND };
  }
  if (!isTurnFinished(slice.tools, slice.assistant, slice.error)) {
    return { ok: false, error: REPLAY_TURN_RUNNING };
  }
  return buildReplay({
    chatId: input.chatId,
    streamId: wanted,
    user: slice.user,
    tools: slice.tools,
    assistant: slice.assistant,
    error: slice.error,
    diffs: input.diffs,
  });
}

function buildReplay(args: {
  chatId: string;
  streamId: string;
  user?: ReplayChatMessage;
  tools: ReplayChatMessage[];
  assistant?: ReplayChatMessage;
  error: string | null;
  diffs?: ReplayDiffRow[];
}): AssembleOk {
  const userMeta = args.user ? metaOf(args.user) : {};
  const asstMeta = args.assistant ? metaOf(args.assistant) : {};
  const replay: TurnReplay = {
    chatId: args.chatId,
    streamId: args.streamId,
    status: replayStatus(args.tools, args.assistant, args.error),
    executionMode: strField(userMeta, "executionMode") ?? strField(asstMeta, "executionMode"),
    provider:
      strField(userMeta, "provider") ??
      strField(asstMeta, "provider") ??
      (typeof rec(asstMeta)?.kind === "string" && asstMeta.kind === "turn_usage"
        ? strField(asstMeta, "provider")
        : null),
    modelId: strField(asstMeta, "modelId") ?? strField(userMeta, "modelId", "model"),
    effort: strField(userMeta, "effort", "activeEffort") ?? strField(asstMeta, "effort"),
    prompt: redactReplayText(String(args.user?.content ?? "")),
    attaches: mapAttaches(args.user),
    tools: mapTools(args.tools),
    diffs: mapDiffs(args.diffs, args.streamId),
    assistant: redactReplayText(String(args.assistant?.content ?? "")),
    error: args.error ? redactReplayText(args.error) : null,
    usageDisplay: usageDisplayFromMeta(args.assistant?.metadata ?? asstMeta),
  };
  return { ok: true, replay };
}

export function formatTurnReplay(replay: TurnReplay): string {
  const lines: string[] = [
    `turn ${replay.streamId}`,
    `status: ${replay.status}`,
    `mode: ${replay.executionMode || REPLAY_MISSING}`,
    `model: ${replay.modelId || REPLAY_MISSING}`,
    `provider: ${replay.provider || REPLAY_MISSING}`,
    "",
    "## prompt",
    replay.prompt,
  ];
  if (replay.attaches.length) {
    lines.push("", "## attaches");
    for (const a of replay.attaches) {
      lines.push(`@ ${a.path}  ${a.kind}  ${a.status}`);
      if (a.preview) {
        for (const pl of a.preview.split("\n")) lines.push(`  ${pl}`);
      }
    }
  }
  if (replay.tools.length) {
    lines.push("", "## tools");
    for (const t of replay.tools) {
      lines.push(`tool · ${t.name} · ${t.status}`);
      const inn = summarizeInput(t.input);
      if (inn) lines.push(`  in: ${inn}`);
      if (t.output) {
        const outLines = t.output.split("\n");
        lines.push(`  out: ${outLines[0] ?? ""}`);
        for (const extra of outLines.slice(1)) lines.push(`  ${extra}`);
      }
    }
  }
  if (replay.diffs.length) {
    lines.push("", "## diffs");
    for (const d of replay.diffs) {
      lines.push(`${d.path}  ${d.kind}  +${d.additions} −${d.deletions}`);
      if (d.preview) {
        for (const pl of d.preview.split("\n")) lines.push(`  ${pl}`);
      }
    }
  }
  lines.push("", "## assistant", replay.assistant);
  if (replay.error) {
    lines.push("", "## error", replay.error);
  }
  lines.push("", "## usage", replay.usageDisplay);
  return lines.join("\n");
}

export function replayToResult(assembled: AssembleOutput): {
  ok: boolean;
  replay?: TurnReplay;
  text?: string;
  error?: string;
} {
  if (!assembled.ok) return { ok: false, error: assembled.error };
  return {
    ok: true,
    replay: assembled.replay,
    text: formatTurnReplay(assembled.replay),
  };
}
```

- [ ] Crear `cli/src/llm/turn-replay.test.ts` (la misma batería se copia a `api/src/llm/turn-replay.test.ts` y `web/src/lib/turn-replay.test.ts`, ajustando el import). Casos **obligatorios**:

```ts
import { describe, expect, test } from "bun:test";
import {
  assembleTurnReplay,
  formatTurnReplay,
  redactReplayText,
  TOOL_OUTPUT_MAX_CHARS,
  REPLAY_TURN_RUNNING,
  REPLAY_NO_TURN,
  NO_USAGE_TEXT,
  REPLAY_SECTION_ORDER,
} from "./turn-replay";

const chatId = "c1";
const sid = "s-finished";

function fixture() {
  return [
    {
      id: "u1",
      role: "user",
      content: "arregla @src/a.ts sk-ant-api03-AAAAAAAAAAAAAAAA",
      createdAt: "2026-09-16T10:00:00.000Z",
      metadata: {
        streamId: sid,
        executionMode: "auto",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        effort: "medium",
        attachments: [
          {
            path: "src/a.ts",
            kind: "text",
            status: "ok",
            hydratedText: "export const x = 1\nANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAA",
          },
          { path: "logo.png", kind: "image", status: "ok", imageBase64: "AAAA" },
        ],
      },
    },
    {
      id: "t1",
      role: "tool",
      content: "ok",
      createdAt: "2026-09-16T10:00:01.000Z",
      metadata: {
        streamId: sid,
        toolCallId: "tc1",
        toolName: "Bash",
        status: "done",
        input: { command: "cat .env && echo ghp_secrettokenvalue" },
        output: `${"x".repeat(TOOL_OUTPUT_MAX_CHARS + 80)}\nghp_secrettokenvalue`,
      },
    },
    {
      id: "a1",
      role: "assistant",
      content: "listo. token=sk-ant-api03-AAAAAAAAAAAAAAAA",
      createdAt: "2026-09-16T10:00:02.000Z",
      metadata: {
        streamId: sid,
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4, total_cost_usd: 0.0012 },
      },
    },
  ];
}

describe("assembleTurnReplay", () => {
  test("ordered sections and header include mode+model", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: fixture(),
      diffs: [
        {
          streamId: sid,
          path: "src/a.ts",
          kind: "modified",
          status: "applied",
          additions: 3,
          deletions: 1,
          preview: "--- a\n+++ b\n+export const x = 1",
        },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    const idx = (h: string) => text.indexOf(h);
    expect(idx("## prompt")).toBeGreaterThan(-1);
    expect(idx("## attaches")).toBeGreaterThan(idx("## prompt"));
    expect(idx("## tools")).toBeGreaterThan(idx("## attaches"));
    expect(idx("## diffs")).toBeGreaterThan(idx("## tools"));
    expect(idx("## assistant")).toBeGreaterThan(idx("## diffs"));
    expect(idx("## usage")).toBeGreaterThan(idx("## assistant"));
    expect(text.startsWith(`turn ${sid}`)).toBe(true);
    expect(text).toContain("mode: auto");
    expect(text).toContain("model: claude-sonnet-4-6");
    expect(text).toContain("provider: claude");
    expect(REPLAY_SECTION_ORDER.join(",")).toBe(
      "prompt,attaches,tools,diffs,assistant,usage",
    );
  });

  test("redacts keys, .env values, vault; keeps tool output truncated", () => {
    const assembled = assembleTurnReplay({ chatId, messages: fixture() });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAA");
    expect(text).not.toContain("ghp_secrettokenvalue");
    expect(text).toContain("***");
    expect(text).toContain("ANTHROPIC_API_KEY=***");
    expect(text).not.toContain("imageBase64");
    expect(text).not.toContain("AAAA");
    expect(assembled.replay.tools[0]!.output.length).toBeLessThanOrEqual(
      TOOL_OUTPUT_MAX_CHARS + 80,
    );
    expect(assembled.replay.tools[0]!.output).toContain("[truncated:");
    expect(text).toContain("tool · bash · done");
  });

  test("does not treat a bash command as something to run", () => {
    const assembled = assembleTurnReplay({ chatId, messages: fixture() });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.replay.tools[0]!.input).toEqual({
      command: "cat .env && echo ***",
    });
    // El módulo es puro: el test no spawnea. El command queda como string.
    expect(typeof assembled.replay.tools[0]!.input).toBe("object");
  });

  test("running turn is not replayable", () => {
    const messages = fixture();
    messages[1]!.metadata = { ...(messages[1]!.metadata as object), status: "running" };
    messages.pop(); // sin assistant
    const assembled = assembleTurnReplay({ chatId, messages, streamId: sid });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toBe(REPLAY_TURN_RUNNING);
  });

  test("awaiting_approval is still running", () => {
    const messages = fixture().slice(0, 2);
    messages[1]!.metadata = {
      ...(messages[1]!.metadata as object),
      status: "awaiting_approval",
    };
    const assembled = assembleTurnReplay({ chatId, messages, streamId: sid });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toBe(REPLAY_TURN_RUNNING);
  });

  test("empty chat", () => {
    const assembled = assembleTurnReplay({ chatId, messages: [] });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toBe(REPLAY_NO_TURN);
  });

  test("usage missing is sin datos, not an error", () => {
    const messages = fixture();
    messages[2]!.metadata = { streamId: sid };
    const assembled = assembleTurnReplay({ chatId, messages });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.replay.usageDisplay).toBe(NO_USAGE_TEXT);
    expect(formatTurnReplay(assembled.replay)).toContain("## usage\nsin datos");
  });

  test("omits empty attaches/tools/diffs sections", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: [
        {
          role: "user",
          content: "hola",
          metadata: { streamId: "s2", executionMode: "ask" },
        },
        {
          role: "assistant",
          content: "ok",
          metadata: { streamId: "s2", modelId: "claude-sonnet-4-6" },
        },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("## attaches");
    expect(text).not.toContain("## tools");
    expect(text).not.toContain("## diffs");
    expect(text).toContain("mode: ask");
  });

  test("rejected diffs are omitted; body is never copied", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: fixture(),
      diffs: [
        { streamId: sid, path: "a.ts", kind: "modified", status: "rejected", preview: "NO" },
        { streamId: sid, path: "b.ts", kind: "created", status: "applied", additions: 1, deletions: 0, preview: "hi", body: "SECRET_BODY=1" },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.replay.diffs.map((d) => d.path)).toEqual(["b.ts"]);
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("SECRET_BODY");
    expect(text).not.toContain("a.ts");
  });

  test("redactReplayText strips .env and keys", () => {
    expect(redactReplayText("sk-ant-api03-ABCDEFGHIJKLMNOP")).toBe("***");
    expect(redactReplayText("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
    expect(redactReplayText("token=ghp_abcdefghijklmnop")).toContain("***");
  });
});
```

Añadir en el test (o un `describe` extra) la guarda de no-re-ejecución:

```ts
import { readFileSync } from "node:fs";

test("source never spawns or calls the LLM", () => {
  const src = readFileSync(new URL("./turn-replay.ts", import.meta.url), "utf8");
  expect(src).not.toContain("Bun.spawn");
  expect(src).not.toContain("child_process");
  expect(src).not.toContain("runClaudeTurn");
  expect(src).not.toContain("runCursorTurn");
  expect(src).not.toContain("agent.turn.dispatch");
  expect(src).not.toContain("from \"@anthropic-ai/claude-agent-sdk\"");
});
```

- [ ] Copiar el módulo y el test a API y Web. En `web/src/lib/turn-replay.test.ts` el import es `from "./turn-replay"`. Primera línea del `.ts` de producción idéntica.

- [ ] Correr:

```bash
bun test cli/src/llm/turn-replay.test.ts
bun test api/src/llm/turn-replay.test.ts
bun test web/src/lib/turn-replay.test.ts
```

Esperado: todos green. `formatTurnReplay` del fixture contiene las 6 secciones en orden + `mode:` + `model:`. Cero `sk-ant-` / `ghp_` en el texto. Output de bash truncado. Source sin spawn.

- [ ] Commit:

```bash
git add cli/src/llm/turn-replay.ts cli/src/llm/turn-replay.test.ts \
  api/src/llm/turn-replay.ts api/src/llm/turn-replay.test.ts \
  web/src/lib/turn-replay.ts web/src/lib/turn-replay.test.ts \
  cli/package.json api/package.json web/package.json
git commit -m "feat(turn-replay): assemble ordered redacted turn trace"
```

---

## Task 2: API — `chat.replay` y `GET /chats/:chatId/replay` (sin daemon)

**Files:**

- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts` (solo si hace falta documentar `type`; `chatId` / `streamId` ya existen en `ClientMessage`)
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/openapi/openapi.yaml`
- Test: `api/src/llm/turn-replay-load.test.ts`
- Create: `api/src/llm/turn-replay-load.ts`

La API **no** llama `hub.findDaemon`. **No** manda `agent.turn.dispatch`. Cinturón `redactReplayJson` sobre el objeto (y `api/src/lib/redact.ts` `redactJson` si el archivo existe).

- [ ] Crear `api/src/llm/turn-replay-load.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import * as schema from "../db/schema";
import {
  assembleTurnReplay,
  formatTurnReplay,
  redactReplayJson,
  redactReplayText,
  type ReplayDiffRow,
  type ReplayResult,
  type TurnReplay,
  REPLAY_NO_TURN,
} from "./turn-replay";

type Msg = {
  id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export async function loadReplayDiffs(
  chatId: string,
  streamId: string | null,
): Promise<ReplayDiffRow[]> {
  const table = (schema as { turnFileDiffs?: typeof schema.chatMessages }).turnFileDiffs;
  if (!table) return [];
  try {
    const rows = await db
      .select()
      .from(table as typeof schema.chatMessages)
      .where(eq((table as { chatId: typeof schema.chatMessages.chatId }).chatId, chatId));
    return (rows as Array<Record<string, unknown>>)
      .filter((r) => !streamId || r.streamId === streamId)
      .map((r) => ({
        streamId: typeof r.streamId === "string" ? r.streamId : null,
        path: typeof r.path === "string" ? r.path : null,
        kind: typeof r.kind === "string" ? r.kind : null,
        status: typeof r.status === "string" ? r.status : null,
        additions: typeof r.additions === "number" ? r.additions : null,
        deletions: typeof r.deletions === "number" ? r.deletions : null,
        preview: typeof r.preview === "string" ? r.preview : null,
        truncated: Boolean(r.truncated),
        // body se ignora a propósito
      }));
  } catch {
    return [];
  }
}

function belt(replay: TurnReplay): TurnReplay {
  return redactReplayJson(replay) as TurnReplay;
}

export async function buildChatReplay(input: {
  chatId: string;
  messages: Msg[];
  streamId?: string | null;
}): Promise<ReplayResult> {
  const diffs = await loadReplayDiffs(input.chatId, input.streamId ?? null);
  const assembled = assembleTurnReplay({
    chatId: input.chatId,
    messages: input.messages,
    diffs,
    streamId: input.streamId,
  });
  if (!assembled.ok) return assembled;
  const replay = belt(assembled.replay);
  replay.prompt = redactReplayText(replay.prompt);
  replay.assistant = redactReplayText(replay.assistant);
  if (replay.error) replay.error = redactReplayText(replay.error);
  return { ok: true, replay, text: formatTurnReplay(replay) };
}

export { REPLAY_NO_TURN };
```

Si TypeScript se queja del cast de `turnFileDiffs` (no existe en el schema actual), **no** importar el símbolo: dejar `loadReplayDiffs` con:

```ts
export async function loadReplayDiffs(
  _chatId: string,
  _streamId: string | null,
): Promise<ReplayDiffRow[]> {
  return [];
}
```

y un comentario `// plan 6: when turnFileDiffs exists, query preview rows; never select body`. Cuando el grep `turnFileDiffs` en `api/src/db/schema.ts` pegue, entonces sí consultar `preview` / `path` / `kind` / `status` / `additions` / `deletions` / `truncated` / `streamId`. **Nunca** `body`.

- [ ] Test `api/src/llm/turn-replay-load.test.ts`: `loadReplayDiffs` con schema actual (sin tabla) devuelve `[]`. `buildChatReplay` con el fixture de Task 1 (in-memory, sin db) — si `buildChatReplay` siempre pega a db para diffs, testear `assemble` + `belt` importando `redactReplayJson` sobre un replay que incluye `sk-ant-` y assert que el resultado no la tiene. No hace falta Postgres para este test.

- [ ] En `api/src/ws/handlers.ts`, añadir el case **junto** a `chat.get` (después). Reusar `loadChatForUser`. **No** tocar `agent.turn.request`.

```ts
case "chat.replay": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, msg.chatId))
    .orderBy(asc(chatMessages.createdAt));
  const result = await buildChatReplay({
    chatId: msg.chatId,
    messages,
    streamId: msg.streamId ?? null,
  });
  if (!result.ok) {
    const code =
      result.error === REPLAY_TURN_RUNNING ? fail(type, id, result.error) : fail(type, id, result.error);
    return code;
  }
  return ok(type, id, { replay: result.replay, text: result.text });
}
```

Importar `buildChatReplay` desde `../llm/turn-replay-load`. Importar `REPLAY_TURN_RUNNING` si se quiere mapear 409; en WS no hay status HTTP: `ok: false, error: REPLAY_TURN_RUNNING` basta.

**Prohibido** en este case: `hub.findDaemon`, `sendTo`, `agent.turn.dispatch`, leer `cwd`, `publishAgentTurn`.

- [ ] En `api/src/routes/workspaces.ts`, dentro de `createSessionChatRoutes`, **después** de `GET /chats/:chatId`:

```ts
app.get("/chats/:chatId/replay", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const chatId = c.req.param("chatId");
  const streamId = c.req.query("streamId") || null;
  const chatRows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
    .limit(1);
  if (!chatRows[0]) return c.json({ error: "Chat not found" }, 404);
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt));
  const result = await buildChatReplay({ chatId, messages, streamId });
  if (!result.ok) {
    const status = result.error === REPLAY_TURN_RUNNING ? 409 : 404;
    return c.json({ error: result.error }, status);
  }
  return c.json({ replay: result.replay, text: result.text });
});
```

CORS `/chats/*` ya cubre la ruta (`api/src/index.ts`).

- [ ] En `api/openapi/openapi.yaml`, path nuevo:

```yaml
  /chats/{chatId}/replay:
    get:
      tags: [Chats]
      summary: Replay de un turn terminado (solo lectura, redactado)
      operationId: getChatReplay
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - name: chatId
          in: path
          required: true
          schema: { type: string }
        - name: streamId
          in: query
          required: false
          schema: { type: string }
          description: Si falta, último turn terminado
      responses:
        "200":
          description: Traza ordenada
          content:
            application/json:
              schema:
                type: object
                required: [replay, text]
                properties:
                  replay: { type: object }
                  text: { type: string }
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          description: Chat o turn no encontrado
        "409":
          description: Turn todavía running
```

En `components.schemas` o en la descripción de WebSocket, documentar `chat.replay` (request `{ type, id, chatId, streamId? }` → `{ ok, data: { replay, text } }`). Dejar `agent.turn.request` intacto.

- [ ] Correr:

```bash
bun test api/src/llm/turn-replay.test.ts
bun test api/src/llm/turn-replay-load.test.ts
```

- [ ] Commit:

```bash
git add api/src/llm/turn-replay-load.ts api/src/llm/turn-replay-load.test.ts \
  api/src/ws/handlers.ts api/src/routes/workspaces.ts api/openapi/openapi.yaml
git commit -m "feat(turn-replay): read-only chat.replay and HTTP dump"
```

---

## Task 3: Estampar identidad del turn + CLI `chat dump`

**Files:**

- Modify: `cli/src/llm/publish-turn.ts`
- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/src/commands/chat-dump.test.ts`
- Create: `cli/src/llm/turn-identity.ts`
- Test: `cli/src/llm/turn-identity.test.ts`

Sin dump no hay escenario CLI. Sin stamp, modo/modelo del turn **nuevo** salen `—`. Replay de turns viejos sigue agrupando por user precedente.

- [ ] Crear `cli/src/llm/turn-identity.ts`:

```ts
export type TurnIdentity = {
  streamId: string;
  executionMode?: string | null;
  provider?: string | null;
  modelId?: string | null;
  effort?: string | null;
};

export function turnUserMetadata(
  identity: TurnIdentity,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(extra || {}),
    streamId: identity.streamId,
    ...(identity.executionMode ? { executionMode: identity.executionMode } : {}),
    ...(identity.provider ? { provider: identity.provider } : {}),
    ...(identity.modelId ? { modelId: identity.modelId } : {}),
    ...(identity.effort ? { effort: identity.effort } : {}),
  };
}

export function turnToolMetadata(
  identity: Pick<TurnIdentity, "streamId">,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(extra || {}), streamId: identity.streamId };
}
```

- [ ] Test `cli/src/llm/turn-identity.test.ts`: `turnUserMetadata` siempre incluye `streamId`; no inventa `executionMode: "ask"` si viene `null`/`undefined`; mergea `attachments` de `extra`.

- [ ] En `cli/src/llm/publish-turn.ts`:

  1. Mover `const streamId = crypto.randomUUID();` **antes** del `chat.append` user.
  2. Tras leer `providers` (ya se hace para el guard de Cursor), construir:

```ts
const identity = {
  streamId,
  provider: providers.activeProvider ?? "claude",
  modelId: providers.activeModel || defaultModelId("claude") || model,
  effort: providers.activeEffort || effort,
  executionMode:
    "activeExecutionMode" in providers
      ? (providers as { activeExecutionMode?: string | null }).activeExecutionMode ?? null
      : null,
};
```

  3. El `chat.append` user pasa `metadata: turnUserMetadata(identity)`. Si ya hay `metadata.attachments` / `mentions` (plan 1 hidrata **antes** y a veces hace el append), **extender** ese objeto con `turnUserMetadata(identity, existing)` — no pisar attachments.
  4. `chat.tool.start` / `chat.tool.result`: `metadata: turnToolMetadata(identity, { input: ev.input, sdkName: ev.toolName })` y `streamId` en el request (`streamId` ya está en `ClientMessage`).
  5. `chat.stream.start` / `delta` / `end` / `error`: el `streamId` ya se manda. En `stream.end`, si `msg.metadata` se envía (plan 15 usage), mergear `modelId` / `provider` / `streamId` sin borrar `usage`.
  6. **No** llamar a `assembleTurnReplay` desde `publish-turn`. El runner no dump-ea solo.
  7. **No** volver a `bypassPermissions`. **No** re-ejecutar tools al stamp.

Si `skipUserAppend` es true (cola / TUI ya appendeó): no reescribir el user; el dispatch debería haber mandado metadata. Si el user existe sin `streamId`, el assembler usa “user precedente”.

- [ ] En `cli/src/commands/headless.ts`, grupo `chat`, **antes** del `throw` de uso, añadir `dump`:

```ts
if (action === "dump") {
  const chatId = rest[0];
  const streamId = rest[1];
  if (!chatId) throw new Error(DUMP_USAGE);
  const res = await client.request({
    type: "chat.replay",
    chatId,
    streamId: streamId || undefined,
  });
  if (!res.ok) throw new Error(res.error || REPLAY_NO_TURN);
  const text = (res.data as { text?: string })?.text;
  if (typeof text !== "string") throw new Error(REPLAY_NO_TURN);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return;
}
```

Importar `DUMP_USAGE`, `REPLAY_NO_TURN` desde `../llm/turn-replay`. El `finally` cierra el client (dump **no** es `watch`). **No** llamar `agent.turn.request`. **No** imprimir JSON.

Mensaje de uso del grupo chat:

```
Uso: chavez headless chat <create|list|append|get|ask|watch|dump> …
```

- [ ] En `cli/src/index.ts` `usage()`, añadir la línea:

```
  chavez headless chat dump <chatId> [streamId]
```

junto a `create|list|append|get|ask|watch`.

- [ ] Test `cli/src/commands/chat-dump.test.ts` — no hace falta WS real. Extraer la función de formateo de error/uso si hace falta, o testear que `formatTurnReplay` + `process.stdout` contract:

```ts
import { describe, expect, test } from "bun:test";
import { DUMP_USAGE } from "../llm/turn-replay";
import { readFileSync } from "node:fs";

test("dump usage string", () => {
  expect(DUMP_USAGE).toContain("chat dump");
});

test("headless dump does not dispatch a turn", () => {
  const src = readFileSync(new URL("./headless.ts", import.meta.url), "utf8");
  const dumpBlock = src.slice(src.indexOf('action === "dump"'), src.indexOf('action === "watch"'));
  expect(dumpBlock).toContain("chat.replay");
  expect(dumpBlock).not.toContain("agent.turn.request");
  expect(dumpBlock).not.toContain("agent.turn.dispatch");
  expect(dumpBlock).not.toContain("Bun.spawn");
  expect(dumpBlock).not.toContain("publishAgentTurn");
});
```

`DUMP_USAGE` ya está en las tres copias de `turn-replay.ts` (Task 1). Importarla; no inventar otro literal.

- [ ] Correr:

```bash
bun test cli/src/llm/turn-replay.test.ts
bun test cli/src/llm/turn-identity.test.ts
bun test cli/src/commands/chat-dump.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/publish-turn.ts cli/src/llm/turn-identity.ts \
  cli/src/llm/turn-identity.test.ts cli/src/commands/headless.ts \
  cli/src/index.ts cli/src/commands/chat-dump.test.ts \
  cli/src/llm/turn-replay.ts api/src/llm/turn-replay.ts web/src/lib/turn-replay.ts
git commit -m "feat(turn-replay): stamp turn identity and CLI text dump"
```

---

## Task 4: TUI — tecla `L`, overlay de lectura, Escape cierra replay

**Files:**

- Modify: `tui/src/App.tsx`
- Test: `tui/src/replay-overlay.test.ts`
- Modify: `tui/package.json`

TUI importa `formatTurnReplay` **solo** como fallback si el RPC no mandara `text`. Preferir `data.text` del API para coincidir byte-a-byte con CLI dump.

- [ ] Añadir `"test": "bun test"` en `tui/package.json` si falta.

- [ ] En `tui/src/App.tsx`:

  1. Estado:

```ts
const [view, setView] = useState<"chat" | "replay">("chat");
const [replayText, setReplayText] = useState<string>("");
const [replayErr, setReplayErr] = useState<string | null>(null);
```

  2. `Message` type: si el plan 2 **no** añadió `metadata`, **no** hace falta para replay (el RPC trae el texto).

  3. En command mode, **antes** del `if (busy) return` de mutaciones (como `m` en plan 29), manejar `L` **aunque busy** — replay de un turn **anterior** es legal; el `streamId` en curso fallará `REPLAY_TURN_RUNNING` y se muestra en `log` / overlay.

```ts
if (ch === "L" && client && activeChatId) {
  setReplayErr(null);
  const res = await client.request({ type: "chat.replay", chatId: activeChatId });
  if (!res.ok) {
    setLog(res.error || "replay failed");
    setReplayErr(res.error || "replay failed");
    setView("replay");
    setReplayText("");
    return;
  }
  const text = (res.data as { text?: string })?.text || "";
  setReplayText(text);
  setView("replay");
  setLog("Replay (solo lectura)");
  return;
}
```

  4. Con `view === "replay"`: si `key.escape`, `setView("chat")`, `setReplayText("")`, **no** `exit()`, **no** `client.close()`. `ctrl+c` sigue saliendo (plan 5). `q` en overlay cierra overlay (no la TUI); `q` en chat sigue saliendo.

  5. **Prohibido** en el overlay: `sendWithLlm`, `publishAgentTurn`, `agent.turn.request`, teclas `y`/`n` de approve (si existen, ignorarlas mientras `view === "replay"`).

  6. Render: si `view === "replay"`, en lugar de (o encima de) la lista de mensajes:

```tsx
<Box flexDirection="column" marginTop={1}>
  <Text bold color="cyan">Replay (read-only)</Text>
  <Text dimColor>{TUI_REPLAY_HINT}</Text>
  {replayErr ? <Text color="red">{replayErr}</Text> : null}
  <Text>{replayText || ""}</Text>
</Box>
```

Importar `TUI_REPLAY_HINT` — definirlo en `cli/src/llm/turn-replay.ts` (`export const TUI_REPLAY_HINT = "[L] replay último turn  [Esc] cierra replay";`) y copiar a las tres copias. TUI: `import { TUI_REPLAY_HINT } from "../../cli/src/llm/turn-replay";`.

  7. Footer de ayuda (la línea `[Tab] listas…`): añadir `[L] replay`.

  8. No truncar el replay a “últimos 8 mensajes”: el overlay es el documento entero (ya acotado por truncates del assembler).

- [ ] Test `tui/src/replay-overlay.test.ts` (puro, sin Ink mount si es frágil). Extraer un helper si hace falta:

```ts
export function replayEscapeCloses(view: "chat" | "replay"): "chat" | "replay" {
  return view === "replay" ? "chat" : view;
}
```

Ponerlo en `tui/src/replay-overlay.ts`:

```ts
export function replayEscapeCloses(view: "chat" | "replay"): "chat" | "replay" {
  return view === "replay" ? "chat" : view;
}

export function isReplayReadOnlyKey(ch: string): boolean {
  return ch === "y" || ch === "n" || ch === "m" || ch === "u" || ch === "r";
}
```

En `App.tsx`, con overlay abierto, si `isReplayReadOnlyKey(ch)` → `return` (no compose, no undo, no approve).

Test:

```ts
import { describe, expect, test } from "bun:test";
import { replayEscapeCloses, isReplayReadOnlyKey } from "./replay-overlay";
import { readFileSync } from "node:fs";

test("escape leaves replay without implying process exit", () => {
  expect(replayEscapeCloses("replay")).toBe("chat");
  expect(replayEscapeCloses("chat")).toBe("chat");
});

test("approve/compose keys are inert in replay", () => {
  expect(isReplayReadOnlyKey("y")).toBe(true);
  expect(isReplayReadOnlyKey("L")).toBe(false);
});

test("App replay path is read-only RPC", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(src).toContain('type: "chat.replay"');
  expect(src).toContain('ch === "L"');
  expect(src).not.toMatch(/view === "replay"[\s\S]*publishAgentTurn/);
});
```

- [ ] Correr:

```bash
bun test tui/src/replay-overlay.test.ts
bun test cli/src/llm/turn-replay.test.ts
```

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/src/replay-overlay.ts tui/src/replay-overlay.test.ts \
  tui/package.json cli/src/llm/turn-replay.ts api/src/llm/turn-replay.ts web/src/lib/turn-replay.ts
git commit -m "feat(turn-replay): TUI read-only overlay on L"
```

---

## Task 5: Web — ReplayPanel, mismas secciones, sin re-ejecutar

**Files:**

- Create: `web/src/components/ReplayPanel.tsx`
- Test: `web/src/components/ReplayPanel.test.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/components/HubPanel.tsx`
- Modify: `web/src/styles/global.css` (solo si hace falta una clase; preferir `panel` / `badge` existentes)

Web **no** importa CLI. Usa `web/src/lib/turn-replay.ts`. Puede pintar el objeto `replay` **o** un `<pre>{text}</pre>`; las cabeceras visibles deben ser `## prompt` … en el `<pre>` **o** `<h3>` con los mismos nombres en `REPLAY_SECTION_ORDER`. Para garantizar “Web/TUI coinciden”, el panel principal es `<pre className="replay-text">{text}</pre>` (el mismo `text` que CLI dump y TUI). Encima, chips de `mode` / `model` leídos de `replay` (mismos valores que el header).

- [ ] En `web/src/lib/query-keys.ts` añadir:

```ts
chatReplay: (chatId: string, streamId?: string | null) =>
  ["chatReplay", chatId, streamId ?? "last"] as const,
```

- [ ] En `web/src/lib/hooks.ts` añadir:

```ts
export type ChatReplayResponse = {
  replay: import("./turn-replay").TurnReplay;
  text: string;
};

export function useChatReplay(
  chatId: string,
  streamId: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.chatReplay(chatId, streamId),
    enabled: enabled && Boolean(chatId),
    queryFn: () => {
      const q = streamId ? `?streamId=${encodeURIComponent(streamId)}` : "";
      return apiJson<ChatReplayResponse>(`/chats/${chatId}/replay${q}`);
    },
  });
}
```

- [ ] Crear `web/src/components/ReplayPanel.tsx`:

```tsx
import { REPLAY_SECTION_ORDER } from "../lib/turn-replay";
import type { TurnReplay } from "../lib/turn-replay";

export function ReplayPanel({
  text,
  replay,
  error,
  onClose,
}: {
  text: string;
  replay?: TurnReplay | null;
  error?: string | null;
  onClose: () => void;
}) {
  return (
    <div className="panel replay-panel" data-testid="replay-panel">
      <p>
        <span className="badge ok">replay · read-only</span>
        {replay?.executionMode ? (
          <span className="badge">mode {replay.executionMode}</span>
        ) : null}
        {replay?.modelId ? (
          <span className="badge">model {replay.modelId}</span>
        ) : null}
        <button type="button" className="secondary" onClick={onClose}>
          Cerrar
        </button>
      </p>
      {error ? <p className="error">{error}</p> : null}
      <pre className="replay-text" style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </pre>
      <p className="muted" data-testid="replay-section-order">
        {REPLAY_SECTION_ORDER.join(" → ")}
      </p>
    </div>
  );
}
```

**Cero** botones “Re-run”, “Retry”, “Aprobar”. Retry es plan 12 y vive **fuera** de este panel.

- [ ] Test `web/src/components/ReplayPanel.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REPLAY_SECTION_ORDER } from "../lib/turn-replay";

test("panel is a pre of canonical text, not a turn dispatcher", () => {
  const src = readFileSync(new URL("./ReplayPanel.tsx", import.meta.url), "utf8");
  expect(src).toContain("replay-text");
  expect(src).toContain("read-only");
  expect(src).not.toContain("agent.turn.request");
  expect(src).not.toContain("publishAgentTurn");
  expect(src).not.toContain("Re-run");
  expect(REPLAY_SECTION_ORDER).toEqual([
    "prompt",
    "attaches",
    "tools",
    "diffs",
    "assistant",
    "usage",
  ]);
});
```

- [ ] En `web/src/components/ChatDetailPanel.tsx`:

  1. Estado `replayOpen` boolean (último turn) y opcional `replayStreamId`.
  2. Botón **Replay** visible cuando hay al menos un mensaje `assistant` o `tool` en el chat (turn que pudo terminar). Disabled mientras `streaming` (el live no es replay). Label: `Replay`.
  3. Al click: `setReplayOpen(true)` (el hook `useChatReplay(chatId, null, replayOpen)` carga GET).
  4. Render `{replayOpen && <ReplayPanel text={...} replay={...} error={...} onClose={() => setReplayOpen(false)} />}`.
  5. El compositor **sigue** existiendo debajo; abrir replay **no** manda un turn. El botón Replay **no** está dentro del `<form onSubmit={onAgent}>`.
  6. Si el GET 409: mostrar `REPLAY_TURN_RUNNING` en el panel (el hook surfacea `formatQueryError`).

No hace falta agrupar la timeline en este plan (la timeline live no cambia). Replay es un documento aparte.

- [ ] `DUMP_HUB_HINT` ya vive en `web/src/lib/turn-replay.ts` (Task 1). Test extra en `web/src/lib/turn-replay.test.ts`:

```ts
import { DUMP_HUB_HINT } from "./turn-replay";
test("hub hint is text dump, not JSON schema, not GitHub Action", () => {
  expect(DUMP_HUB_HINT).toContain("chat dump");
  expect(DUMP_HUB_HINT).not.toContain(".github");
  expect(DUMP_HUB_HINT).not.toContain("JSON schema");
});
```

- [ ] En `web/src/components/HubPanel.tsx`, sección CLI (el `<pre>` de comandos, o un `<p className="muted">` debajo): pintar `{DUMP_HUB_HINT}` importado de `../lib/turn-replay`. No borrar hints de CI si el plan 25 ya añadió `CI_HUB_HINT`.

- [ ] Correr:

```bash
bun test web/src/lib/turn-replay.test.ts
bun test web/src/components/ReplayPanel.test.ts
```

- [ ] Commit:

```bash
git add web/src/components/ReplayPanel.tsx web/src/components/ReplayPanel.test.ts \
  web/src/components/ChatDetailPanel.tsx web/src/components/HubPanel.tsx \
  web/src/lib/hooks.ts web/src/lib/query-keys.ts web/src/lib/turn-replay.ts \
  cli/src/llm/turn-replay.ts api/src/llm/turn-replay.ts
git commit -m "feat(turn-replay): Web replay panel matches CLI/TUI text"
```

---

## Task 6: Paridad Web ↔ TUI ↔ CLI y guarda de no-re-ejecución

**Files:**

- Test: `cli/src/llm/turn-replay-parity.test.ts`
- Modify: `cli/src/ws/daemon.ts` (solo un comentario de guarda si se toca; **no** añadir handler de replay en el daemon)
- Test: `api/src/ws/replay-no-daemon.test.ts`

El Gherkin “Web/TUI coinciden” se demuestra con el **mismo** `formatTurnReplay(fixture)`. El Gherkin “No re-ejecuta” se demuestra con source guards + assembler puro.

- [ ] Crear `cli/src/llm/turn-replay-parity.test.ts` que lea las tres copias y compare el cuerpo tras la primera línea:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assembleTurnReplay, formatTurnReplay } from "./turn-replay";

const root = resolve(import.meta.dir, "../../..");

function body(rel: string): string {
  const txt = readFileSync(resolve(root, rel), "utf8");
  return txt.replace(/^\/\*\* keep-in-sync:.*\*\/\s*/, "");
}

test("keep-in-sync copies match", () => {
  const cli = body("cli/src/llm/turn-replay.ts");
  expect(body("api/src/llm/turn-replay.ts")).toBe(cli);
  expect(body("web/src/lib/turn-replay.ts")).toBe(cli);
});

test("CLI formatter output is the contract", () => {
  const messages = [
    {
      role: "user",
      content: "hola",
      metadata: {
        streamId: "s",
        executionMode: "plan",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
      },
    },
    {
      role: "assistant",
      content: "ok",
      metadata: { streamId: "s", modelId: "claude-sonnet-4-6" },
    },
  ];
  const a = assembleTurnReplay({ chatId: "c", messages });
  expect(a.ok).toBe(true);
  if (!a.ok) return;
  const text = formatTurnReplay(a.replay);
  expect(text).toContain("mode: plan");
  expect(text).toContain("model: claude-sonnet-4-6");
  expect(text.indexOf("## prompt")).toBeLessThan(text.indexOf("## assistant"));
  expect(text.indexOf("## assistant")).toBeLessThan(text.indexOf("## usage"));
});
```

- [ ] Crear `api/src/ws/replay-no-daemon.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("chat.replay handler never looks up a daemon", () => {
  const src = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
  const start = src.indexOf('case "chat.replay"');
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start, start + 1800);
  expect(rest).toContain("buildChatReplay");
  expect(rest).not.toContain("findDaemon");
  expect(rest).not.toContain("agent.turn.dispatch");
  expect(rest).not.toContain("NO_DAEMON_ERROR");
});
```

El import path de `handlers.ts` es `api/src/ws/handlers.ts` — el test vive en `api/src/ws/replay-no-daemon.test.ts` y lee `./handlers.ts`.

- [ ] **No** añadir `chat.replay` al `onPush` de `cli/src/ws/daemon.ts`. Verificar con:

```ts
// en el mismo test de dump o uno de daemon:
const daemon = readFileSync(new URL("../ws/daemon.ts", import.meta.url), "utf8");
expect(daemon).not.toContain("chat.replay");
```

Ponerlo en `cli/src/commands/chat-dump.test.ts`.

- [ ] Correr:

```bash
bun test cli/src/llm/turn-replay-parity.test.ts
bun test api/src/ws/replay-no-daemon.test.ts
bun test cli/src/commands/chat-dump.test.ts
```

- [ ] Commit:

```bash
git add cli/src/llm/turn-replay-parity.test.ts api/src/ws/replay-no-daemon.test.ts \
  cli/src/commands/chat-dump.test.ts
git commit -m "test(turn-replay): Web/TUI/CLI same text; replay never dispatches"
```

---

## Task 7: Smoke Gherkin — los cuatro escenarios, sin LLM vivo

**Files:**

- Test: `cli/src/llm/turn-replay.gherkin.test.ts`
- Modify: `web/src/components/HubPanel.tsx` (si Task 5 no dejó el hint)
- Modify: `cli/src/index.ts` (usage ya actualizado)

Sin Anthropic, sin Cursor SDK, sin git, sin daemon de verdad. Fixture in-memory + source guards cubren el Gherkin.

- [ ] Crear `cli/src/llm/turn-replay.gherkin.test.ts` mapeando cada escenario:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assembleTurnReplay,
  formatTurnReplay,
  TOOL_OUTPUT_MAX_CHARS,
  REPLAY_TURN_RUNNING,
} from "./turn-replay";

const sid = "gherkin-1";
const messages = [
  {
    role: "user",
    content: "mira @.env y corre ls",
    metadata: {
      streamId: sid,
      executionMode: "auto",
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      attachments: [
        { path: ".env", kind: "text", status: "secret", hydratedText: "OPENAI_API_KEY=sk-ant-api03-NOTAREALKEYVALUE" },
      ],
    },
  },
  {
    role: "tool",
    content: "ok",
    metadata: {
      streamId: sid,
      toolCallId: "1",
      toolName: "Bash",
      status: "done",
      input: { command: "ls" },
      output: "x".repeat(TOOL_OUTPUT_MAX_CHARS + 10),
    },
  },
  {
    role: "assistant",
    content: "hecho",
    metadata: {
      streamId: sid,
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  },
];
const diffs = [
  { streamId: sid, path: "src/a.ts", kind: "modified" as const, status: "applied", additions: 1, deletions: 0, preview: "+x" },
];

describe("Gherkin Replay", () => {
  test("Abrir replay: prompt, attaches, tools, diffs, assistant, usage, modo, modelo en orden; Web/TUI coinciden", () => {
    const assembled = assembleTurnReplay({ chatId: "c", messages, diffs });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    const order = ["## prompt", "## attaches", "## tools", "## diffs", "## assistant", "## usage"];
    let last = -1;
    for (const h of order) {
      const i = text.indexOf(h);
      expect(i).toBeGreaterThan(last);
      last = i;
    }
    expect(text).toContain("mode: auto");
    expect(text).toContain("model: claude-sonnet-4-6");
    expect(text).toContain("@ .env");
    expect(text).toContain("tool · bash · done");
    expect(text).toContain("src/a.ts  modified  +1 −0");
    expect(text).toContain("## assistant");
    expect(text).toContain("turn: in 3 · out 1");
    expect(formatTurnReplay(assembled.replay)).toBe(text);
  });

  test("Redacción: no API keys ni .env values; tool output sigue truncado", () => {
    const assembled = assembleTurnReplay({ chatId: "c", messages, diffs });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("sk-ant-api03-NOTAREALKEYVALUE");
    expect(text).toContain("OPENAI_API_KEY=***");
    expect(assembled.replay.tools[0]!.output).toContain("[truncated:");
    expect(assembled.replay.tools[0]!.output.length).toBeLessThanOrEqual(
      TOOL_OUTPUT_MAX_CHARS + 80,
    );
  });

  test("No re-ejecuta: replay es lectura y no corre bash", () => {
    const src = readFileSync(new URL("./turn-replay.ts", import.meta.url), "utf8");
    expect(src).not.toContain("Bun.spawn");
    expect(src).not.toMatch(/execSync|spawnSync|child_process/);
    const running = assembleTurnReplay({
      chatId: "c",
      streamId: sid,
      messages: [
        messages[0]!,
        {
          ...messages[1]!,
          metadata: { ...(messages[1]!.metadata as object), status: "running" },
        },
      ],
    });
    expect(running.ok).toBe(false);
    if (running.ok) return;
    expect(running.error).toBe(REPLAY_TURN_RUNNING);
  });

  test("CLI dump is text (CI, plan 25), not JSON schema", () => {
    const headless = readFileSync(
      resolve(import.meta.dir, "../commands/headless.ts"),
      "utf8",
    );
    expect(headless).toContain('action === "dump"');
    expect(headless).toContain("chat.replay");
    expect(headless).toContain("process.stdout.write");
    const usage = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(usage).toContain("chat dump");
    expect(usage).not.toMatch(/dump[\s\S]*JSON schema/);
  });
});
```

- [ ] Correr **toda** la batería de esta fase:

```bash
bun test cli/src/llm/turn-replay.test.ts
bun test cli/src/llm/turn-identity.test.ts
bun test cli/src/llm/turn-replay-parity.test.ts
bun test cli/src/llm/turn-replay.gherkin.test.ts
bun test cli/src/commands/chat-dump.test.ts
bun test api/src/llm/turn-replay.test.ts
bun test api/src/llm/turn-replay-load.test.ts
bun test api/src/ws/replay-no-daemon.test.ts
bun test web/src/lib/turn-replay.test.ts
bun test web/src/components/ReplayPanel.test.ts
bun test tui/src/replay-overlay.test.ts
```

Esperado: green. Cero llamadas de red. Cero LLM.

- [ ] Tabla de aceptación (marcar mentalmente; los tests de arriba son la evidencia):

| Escenario Gherkin | Task | Evidencia |
|---|---|---|
| Abrir replay — prompt, attaches, tools, diffs, assistant, usage, modo, modelo en orden | 1, 5, 7 | `formatTurnReplay` índices crecientes; header `mode:`/`model:` |
| Web/TUI coinciden | 4, 5, 6 | keep-in-sync + `<pre>{text}</pre>` + overlay `{replayText}` + CLI stdout |
| Redacción — no API keys ni `.env` | 1, 2, 7 | `***`, `KEY=***`, cinturón API |
| Outputs de tools siguen truncados | 1, 7 | `[truncated:]` + tope 8000 |
| No re-ejecuta / no corre bash | 2, 3, 6, 7 | source sin spawn; handler sin `findDaemon`; dump ≠ `agent.turn.request` |
| CLI dump texto (CI plan 25) | 3, 7 | `chavez headless chat dump`; stdout texto; hint en Hub |

- [ ] Commit:

```bash
git add cli/src/llm/turn-replay.gherkin.test.ts
git commit -m "test(turn-replay): Gherkin replay, redact, read-only dump"
```

---

## Notas de implementación (cerradas)

- Si `cli/src/llm/redact.ts` ya existe, **no** borrar `PATTERNS` de `turn-replay.ts` (el keep-in-sync debe ser autónomo para Web). Opcional en CLI: `redactReplayText` puede delegar a `redactText` **después** de copiar el archivo; **no** lo hagas en las copias de API/Web si eso rompe keep-in-sync. Preferir tres archivos idénticos.
- Si el plan 2 aún no estampa `streamId` en tools, Task 3 lo hace en `publish-turn`. Turns antiguos se agrupan por user precedente.
- Si el plan 6 no creó `turn_file_diffs`, la sección `## diffs` se omite. No crear la tabla aquí.
- Si el plan 15 no persistió usage, `## usage` imprime `sin datos`. No es error.
- `chavez ci` (plan 25) **no** se modifica. CI llama `chat dump` si quiere la traza a posteriori. El log en vivo de CI sigue siendo el formatter del plan 25.
- Retry (plan 12) dispara un turn **nuevo**. No vive en ReplayPanel.
- Slash `/replay` no se implementa (plan 11). El usuario usa `L`, el botón Web o `chat dump`.
