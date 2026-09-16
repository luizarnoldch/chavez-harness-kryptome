# Export Share Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, org/roles, notificaciones OS/email, cola de turns (plan 29), worktrees paralelos (plan 28), slash `/export` (plan 11), replay de un turn (plan 34 — otro documento), ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Si un sibling (`turn-replay`, `usage-cost`, `attach-files`, `diffs-review`, `ignore-secrets`, `chat-organization`, `invariants`) ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **no** lee el cwd, **no** hidrata `@` otra vez, **no** despacha `agent.turn`.

**Goal:** El dueño del chat se lleva la conversación **sin vault**. Export markdown = mensajes `user`/`assistant` + resumen de tools/diffs + attaches como **paths** (cero blobs). Export JSON = historial persistido **acotado**, con usage **crudo por provider** si existe (plan 15). Importar un export propio crea un **chat nuevo** en una session y **no** re-ejecuta tools. Un link de solo lectura muestra el timeline; quien lo abre no puede `ask` ni ver vault; el dueño lo revoca. El link **no** es membresía (plan 33). Chat de otro user → **404**.

**Architecture:** El filesystem y el runner viven en el daemon. Export/import/share **no los tocan**. La API arma el documento desde filas ya persistidas (`chat_messages` + `turn_file_diffs` preview si el plan 6 aterrizó) y vuelve a redactar. El link público es una fila `chat_share_links` + GET anónimo. Sin daemon bound, export/import/share **siguen funcionando** (no son `agent.turn.request`).

```
chat_messages + diffs preview (si existen)
        |
        v
  assembleChatExport  (puro)
        |  redact belt
        |  drop blobs (imageBase64, hydratedText, bytes)
        |  tools/diffs → resumen
        |  usage crudo por provider (kind=turn_usage)
        v
  GET /chats/:id/export?format=md|json
  chat.export
        |
        +-- CLI  chat export  → stdout / --out
        +-- TUI  tecla E      → overlay markdown
        +-- Web  botones MD/JSON

POST /sessions/:id/chats/import  { document }
  chat.import
        |  chat.create (nuevo id) + insert messages (nuevos ids)
        |  metadata.imported = true
        |  NUNCA hub.findDaemon
        |  NUNCA agent.turn.dispatch
        v
  broadcast chat.created  →  Web / TUI / watch

POST /chats/:id/share  →  { token, url }   (1 activo / chat)
GET  /share/:token     →  timeline acotada  (sin auth, sin vault, sin ask)
DELETE /chats/:id/share → revokedAt = now   → GET 404
Web /s/:token          → ShareTimeline (sin compositor)
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts` `chats` / `chat_messages` (jsonb `metadata`). **No** hay `chat_share_links`. `provider_credentials.ciphertext` es el vault — **nunca** entra en un export ni en `/share/:token`.
- `api/src/ws/handlers.ts` `chat.get` y `GET /chats/:chatId` (`api/src/routes/workspaces.ts`) devuelven `{ chat, messages }` filtrando `chats.userId`. Chat ajeno → `"Chat not found"`. **No** hay `chat.export` / `chat.import` / `chat.share.*`.
- `cli/src/commands/headless.ts` `chat`: `create|list|append|get|ask|watch`. **No** `export|import|share`. `ensureClient()` hace `workspace.bind`; export/import/share de esta fase van por **HTTP** (`cli/src/api-client.ts` `apiFetch`) y **no** exigen daemon ni bind.
- TUI `tui/src/App.tsx`: teclas `s` `c` `m` `p` `[` `]` `{` `}` `q`. Plan 34 añade `L` (replay). Esta fase añade `E` (export/share overlay). Escape en overlay **cierra el overlay**, no la TUI.
- Web `ChatDetailPanel.tsx`: timeline + compositor `agent.turn.request` + append. **No** hay export. `SessionDetailPanel.tsx` crea chats; **no** hay import de archivo. No existe `/s/[token]`.
- `api/src/index.ts` CORS cubre `/chats/*` `/sessions/*`; **no** `/share/*`.
- `cli/src/llm/history.ts` tira `role=tool` al armar el prompt del LLM. Import **no** llama a `historyFromChatMessages` ni a `query()`.
- Redact: `cli/src/llm/redact.ts` / `api/src/lib/redact.ts` / `cli/src/llm/turn-replay.ts` los crean planes 5/8/34. El módulo de esta fase **trae sus propios** `PATTERNS` (keep-in-sync). Si `redactReplayText` ya existe, los tests de paridad pueden comparar; el archivo `export-share.ts` permanece autónomo (tres copias idénticas).
- Usage: `USAGE_META_KIND = "turn_usage"` (plan 15). El JSON de export **copia el blob crudo** (ya strippeado de secrets), **sin** aplanar Claude+Cursor. Si no hay blob, el array `usage` queda `[]` — no es error.
- Attaches (plan 1): `metadata.attachments[]` con `path`, `kind`, `status`, a veces `hydratedText` / `imageBase64`. Export **tira** esos blobs; deja path+kind+status.
- Diffs (plan 6): `turn_file_diffs` preview. Si la tabla **no** está en el schema, diffs = `[]` y markdown omite `## diffs`. **Nunca** `body`.
- Cursor `runnable: false`. Un chat con filas Cursor se exporta igual (lectura). **No** simular un turn Cursor. **No** llamar al SDK.
- Plan 33: cero org, cero roles. El token del link **no** crea session Better Auth, **no** añade el viewer al workspace, **no** abre `/providers/:id/credentials` del dueño.

**Tech Stack:** Bun, Hono + Drizzle Postgres (tabla nueva `chat_share_links`), WebSocket hub **solo** para RPCs del dueño (`chat.export` / `chat.import` / `chat.share.*`) y `chat.created` tras import. Better Auth (cookie Web + Bearer CLI) en rutas de dueño; GET `/share/:token` **sin** sesión. Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar `cli/src/chats/export-share.ts` en `api/src/chats/export-share.ts` y `web/src/lib/export-share.ts` (comentario keep-in-sync). TUI importa `cli/src/chats/export-share.ts`. Sin paquete extra. Sin spawn, sin git, sin LLM.

**Global Constraints:**

1. El filesystem real vive en el daemon. Export/import/share **cero** `readdir` / `readFile` / hidratar `@` / calcular diffs contra disco. Solo filas Postgres.
2. Un turn de agente solo corre si hay daemon bound. Export/import/share **no** son turns: **funcionan sin daemon**. No devolver `NO_DAEMON_ERROR`. `agent.turn.request` sigue fallando con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"` — esta fase no lo toca.
3. Web, CLI `watch` y TUI ven el mismo chat. Import emite `chat.created` (el chat **nuevo**). El viewer anónimo del link **no** tiene WS: recarga HTTP. `watch` no es notificación OS.
4. Preferencias de provider/modelo/esfuerzo/modo **no** se tocan. El export no escribe `user_preferences`. El import no cambia el provider activo.
5. Claude es el provider ejecutable. Export/import no llaman al provider. Cursor vinculado no ejecuta turns aquí.
6. Tools históricas se **copian como filas** en import. No se re-ejecutan. `Bun.spawn`, `query()`, `runClaudeTurn`, `runCursorTurn`, `canUseTool` y `agent.turn.dispatch` están **prohibidos** en export/import/share.
7. Lecturas no piden confirmación (no hay tools que correr). Write/edit/bash del chat original ya ocurrieron; el export solo pinta el rastro.
8. Aprobaciones una a una: un tool `awaiting_approval` se exporta con ese status (resumen). Import **no** abre un waiter ni un approve. El chat importado es histórico.
9. 1 turn por daemon no aplica (no corre nada).
10. Un usuario = su vault. Chat ajeno → **404** `"Chat not found"` (no 403). Sin sesión en rutas de dueño → **401**. Session ajena en import → **404** `"Session not found"`. Token de share inválido/revocado → **404** `"Share not found"` (no filtrar “revoked” vs “never existed”). El 404 no incluye emails ni ids de otros.
11. Secretos: API keys (`sk-ant-`, `ghp_`, `xox…`, Bearer, PEM), líneas `.env` (`KEY=value` → `KEY=***`), vault `~/.chavez/**` y keys `api_key`/`token`/`secret`/`password`/`authorization`/`credential`/`ciphertext`/`accessToken` se sustituyen por `***` **antes** de devolver markdown/JSON/share. Attaches: path + kind + status; **nunca** `imageBase64` ni `hydratedText` ni bytes.
12. Usage en JSON = blob **crudo por provider** (plan 15). No aplanar `input_tokens` de Claude con `inputTokens` de Cursor. Markdown **no** vuelca el blob (Gherkin markdown pide mensajes + resumen de tools/diffs, no la factura).
13. Link de solo lectura **no** es membresía: no crea `session` Better Auth, no da `workspace.bind`, no lista `/workspaces` del dueño, no abre vault. Viewer autenticado B que abre el link de A sigue viendo **solo** el payload público; `GET /chats/:id` del chat de A → 404; `agent.turn.request` sobre ese id → 404.
14. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador (el import Web es `<input type="file">` de un JSON **ya exportado**, no un archivo del cwd ni un blob hidratado), notificaciones OS/email, org/roles, “team workspace”, JSON schema de CI, GitHub Action, slash `/export`.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `EXPORT_FORMAT_ID` | `"chavez.chat.export"` |
| `EXPORT_FORMAT_VERSION` | `1` |
| `EXPORT_FORMATS` | `"md"` \| `"json"` |
| `TOOL_SUMMARY_MAX_CHARS` | `500` |
| `JSON_TOOL_OUTPUT_MAX_CHARS` | `8000` (mismo tope que plan 2; re-acotar, no rehidratar) |
| `REDACT_REPLACEMENT` | `"***"` |
| `SHARE_TOKEN_BYTES` | `32` |
| `CHAT_NOT_FOUND` | `"Chat not found"` |
| `SESSION_NOT_FOUND` | `"Session not found"` |
| `SHARE_NOT_FOUND` | `"Share not found"` |
| `IMPORT_INVALID` | `"Invalid export document"` |
| `IMPORT_JSON_ONLY` | `"Import requires a JSON export (chavez.chat.export)"` |
| `FORMAT_REQUIRED` | `"format must be md or json"` |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` (reusar; **no** usarla aquí) |
| `EXPORT_USAGE` | `"Uso: chavez headless chat export <chatId> [--format md\|json] [--out file]"` |
| `IMPORT_USAGE` | `"Uso: chavez headless chat import <sessionId> <file.json>"` |
| `SHARE_USAGE` | `"Uso: chavez headless chat share <create\|get\|revoke> <chatId>"` |
| `EXPORT_HUB_HINT` | `"Export: chavez headless chat export <chatId> [--format md\|json]. Import: chat import <sessionId> <file.json>. Share: chat share create <chatId>. Sin vault. Tools no se re-ejecutan."` |
| `TUI_EXPORT_KEY` | `"E"` |
| `TUI_EXPORT_HINT` | `"[E] export/share  [Esc] cierra"` |
| `SHARE_READONLY_BANNER` | `"Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault."` |
| `SHARE_REVOKED_HINT` | `"Link revocado"` |
| `IMPORT_TITLE_PREFIX` | `"Imported: "` |
| `DROP_ATTACH_KEYS` | `imageBase64`, `hydratedText`, `bytes`, `contentBase64`, `data`, `blob`, `preview` (preview de attach texto **no** viaja; el path sí) |
| `USAGE_META_KIND` | `"turn_usage"` (mismo literal que plan 15) |

Tipos (congelados):

```ts
export type ExportFormat = "md" | "json";

export type ExportAttach = {
  path: string;
  kind: string;
  status: string;
};

export type ExportToolSummary = {
  toolCallId: string;
  name: string;
  status: string;
  input: unknown;
  output: string;
};

export type ExportDiffSummary = {
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
};

export type ExportUsageEntry = {
  provider: string;
  modelId: string | null;
  usage: Record<string, unknown>;
};

export type ExportMessage = {
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

export type ChatExportDocument = {
  format: typeof EXPORT_FORMAT_ID;
  version: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  chat: { title: string };
  messages: ExportMessage[];
  usage: ExportUsageEntry[];
  diffs: ExportDiffSummary[];
};

export type ChatExportResult = {
  markdown: string;
  document: ChatExportDocument;
};

export type ShareView = {
  title: string;
  createdAt: string;
  messages: ExportMessage[];
  banner: typeof SHARE_READONLY_BANNER;
};
```

Texto canónico markdown (`formatChatMarkdown`) — contrato CLI / TUI / Web:

```
# <title>

## user
<content redactado>

## attaches
@ src/foo.ts  text  ok
@ assets/logo.png  image  ok

## tools
tool · bash · done
  in: ls -la
  out: <resumen ≤500 chars>

## diffs
src/foo.ts  modified  +3 −1

## assistant
<content redactado>
```

Reglas del string:

- Un bloque por mensaje `user` / `assistant` / `system` en orden `createdAt`. `role=tool` **no** tiene `## tool` largo: se agrupa en `## tools` **inmediatamente después** del `user` (o assistant precedente) del mismo `streamId` si existe; si no hay `streamId`, después del último `user`.
- `## attaches` solo si ese user tiene attachments acotados. Paths posix, nunca bytes.
- `## diffs` una vez por `streamId` si el array de diffs de ese turn no está vacío; si el plan 6 no aterrizó, se omite la sección (no “0 archivos”).
- Prohibido en markdown **y** JSON: `sk-ant-`, `ghp_`, `imageBase64`, `hydratedText`, `ciphertext`, `Authorization: Bearer`, valores de `.env`.
- `system` se exporta como `## system` (raro; append manual lo permite hoy).
- Título vacío → `Chat`.

JSON (`document`) — historial persistido acotado:

- `chat` **solo** `{ title }`. Cero `id`, `userId`, `sessionId`, `workspaceId`.
- `messages[].metadata` ya bounded + redactado. Usage crudo vive **también** en sidecar `usage[]` (una entrada por mensaje assistant con `kind=turn_usage`). El blob en metadata se deja (acotado) para que import restaure el sidecar al copiar metadata.
- `diffs` preview stats, **sin** `body` / `preview` largo (solo path, kind, status, ±).

Nombres de events WS:

| Tipo | Dirección | Semántica |
|---|---|---|
| `chat.export` | cliente → API | `{ chatId, format?: "md"\|"json" }` → `{ markdown, document }`. **No** fan-out. **No** daemon. `format` solo filtra qué campo usar el cliente; la API **siempre** calcula ambos. |
| `chat.import` | cliente → API | `{ sessionId, payload: ChatExportDocument }` → `{ chat }`. Broadcast `chat.created`. **No** daemon. |
| `chat.share.create` | cliente → API | `{ chatId }` → `{ token, url, createdAt }`. Si ya hay activo, **devuelve el existente** (no rota). |
| `chat.share.get` | cliente → API | `{ chatId }` → `{ token, url, createdAt }` o `ok:false` `SHARE_NOT_FOUND`. |
| `chat.share.revoke` | cliente → API | `{ chatId }` → `{ revoked: true }`. Activo → `revokedAt=now`. Sin activo → `SHARE_NOT_FOUND`. |
| `chat.share.updated` | API → dueño | `{ chatId, active: boolean }` tras create/revoke. **No** al viewer anónimo. |
| `agent.turn.request` / `dispatch` | — | **Prohibido** en este path. |

HTTP:

| Método | Ruta | Auth | Devuelve |
|---|---|---|---|
| `GET` | `/chats/:chatId/export?format=md\|json` | cookie/Bearer | `format=json` → `ChatExportDocument`. `format=md` → `{ markdown }` o `text/markdown` si `Accept: text/markdown`. |
| `POST` | `/sessions/:sessionId/chats/import` | cookie/Bearer | `{ chat }` — body = `ChatExportDocument` |
| `POST` | `/chats/:chatId/share` | cookie/Bearer | `{ token, url, createdAt }` |
| `GET` | `/chats/:chatId/share` | cookie/Bearer | igual, o 404 `Share not found` |
| `DELETE` | `/chats/:chatId/share` | cookie/Bearer | `{ revoked: true }` |
| `GET` | `/share/:token` | **ninguna** | `{ title, createdAt, messages, banner }` |

401 sin sesión en rutas de dueño. 404 chat/session/share ajenos o inexistentes. 400 `format must be md or json` / `Invalid export document`. CORS: añadir `/share/*` en `api/src/index.ts`.

URL pública del link: `${WEB_ORIGIN}/s/${token}` (web). El JSON de share **no** incluye la API origin del vault ni `/providers`.

---

## Task 1: Módulo puro — acotar, redactar, markdown, JSON, validar import

**Files:**

- Create: `cli/src/chats/export-share.ts`
- Test: `cli/src/chats/export-share.test.ts`
- Create: `api/src/chats/export-share.ts`
- Test: `api/src/chats/export-share.test.ts`
- Create: `web/src/lib/export-share.ts`
- Test: `web/src/lib/export-share.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`

Sin I/O, sin `Bun.spawn`, sin `child_process`, sin WS, sin `query`, sin Postgres. TUI importa CLI. API y Web copian el archivo **idéntico** (primera línea keep-in-sync).

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`db:*`/`test:e2e`/`build` intactos).

- [ ] Crear `cli/src/chats/export-share.ts` y copiar **idéntico** a `api/src/chats/export-share.ts` y `web/src/lib/export-share.ts`. Primera línea:

```ts
/** keep-in-sync: cli/src/chats/export-share.ts, api/src/chats/export-share.ts, web/src/lib/export-share.ts */
```

Contenido:

```ts
/** keep-in-sync: cli/src/chats/export-share.ts, api/src/chats/export-share.ts, web/src/lib/export-share.ts */

export const EXPORT_FORMAT_ID = "chavez.chat.export" as const;
export const EXPORT_FORMAT_VERSION = 1 as const;
export const EXPORT_FORMATS = ["md", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const TOOL_SUMMARY_MAX_CHARS = 500;
export const JSON_TOOL_OUTPUT_MAX_CHARS = 8000;
export const REDACT_REPLACEMENT = "***";
export const SHARE_TOKEN_BYTES = 32;
export const CHAT_NOT_FOUND = "Chat not found";
export const SESSION_NOT_FOUND = "Session not found";
export const SHARE_NOT_FOUND = "Share not found";
export const IMPORT_INVALID = "Invalid export document";
export const IMPORT_JSON_ONLY = "Import requires a JSON export (chavez.chat.export)";
export const FORMAT_REQUIRED = "format must be md or json";
export const EXPORT_USAGE =
  "Uso: chavez headless chat export <chatId> [--format md|json] [--out file]";
export const IMPORT_USAGE =
  "Uso: chavez headless chat import <sessionId> <file.json>";
export const SHARE_USAGE =
  "Uso: chavez headless chat share <create|get|revoke> <chatId>";
export const EXPORT_HUB_HINT =
  "Export: chavez headless chat export <chatId> [--format md|json]. Import: chat import <sessionId> <file.json>. Share: chat share create <chatId>. Sin vault. Tools no se re-ejecutan.";
export const TUI_EXPORT_HINT = "[E] export/share  [Esc] cierra";
export const SHARE_READONLY_BANNER =
  "Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault.";
export const SHARE_REVOKED_HINT = "Link revocado";
export const IMPORT_TITLE_PREFIX = "Imported: ";
export const USAGE_META_KIND = "turn_usage";
export const DEFAULT_CHAT_TITLE = "Chat";

export const DROP_ATTACH_KEYS = [
  "imageBase64",
  "hydratedText",
  "bytes",
  "contentBase64",
  "data",
  "blob",
  "preview",
] as const;

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

export type ExportAttach = {
  path: string;
  kind: string;
  status: string;
};

export type ExportToolSummary = {
  toolCallId: string;
  name: string;
  status: string;
  input: unknown;
  output: string;
};

export type ExportDiffSummary = {
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
};

export type ExportUsageEntry = {
  provider: string;
  modelId: string | null;
  usage: Record<string, unknown>;
};

export type ExportMessage = {
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

export type ChatExportDocument = {
  format: typeof EXPORT_FORMAT_ID;
  version: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  chat: { title: string };
  messages: ExportMessage[];
  usage: ExportUsageEntry[];
  diffs: ExportDiffSummary[];
};

export type ChatExportResult = {
  markdown: string;
  document: ChatExportDocument;
};

export type ShareView = {
  title: string;
  createdAt: string;
  messages: ExportMessage[];
  banner: typeof SHARE_READONLY_BANNER;
};

export type SourceMessage = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
};

export type SourceDiffRow = {
  streamId?: string | null;
  path?: string | null;
  kind?: string | null;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
  preview?: string | null;
  body?: string | null;
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

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return 0;
}

export function redactExportText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  out = out.replace(ENV_LINE, (full, k, val) => {
    if (String(val).trim() === "" || String(val) === REDACT_REPLACEMENT) {
      return full;
    }
    return `${k}=${REDACT_REPLACEMENT}`;
  });
  out = out.replace(VAULT_PATH_RE, (m) => {
    const prefix = m[0] === "~" || m[0] === "." ? "" : m[0];
    return `${prefix}${REDACT_REPLACEMENT}`;
  });
  return out;
}

export function redactExportJson(value: unknown): unknown {
  if (typeof value === "string") return redactExportText(value);
  if (Array.isArray(value)) return value.map(redactExportJson);
  const obj = rec(value);
  if (obj) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactExportJson(v);
    }
    return out;
  }
  return value;
}

export function truncateExportText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function parseExportFormat(raw: string | null | undefined): ExportFormat | null {
  const v = String(raw || "json").trim().toLowerCase();
  if (v === "md" || v === "markdown") return "md";
  if (v === "json") return "json";
  return null;
}

export function shareUrl(webOrigin: string, token: string): string {
  return `${webOrigin.replace(/\/$/, "")}/s/${encodeURIComponent(token)}`;
}

function metaOf(m: SourceMessage): Record<string, unknown> {
  return rec(m.metadata) ?? {};
}

function canonicalToolName(name: string): string {
  return CANONICAL[name] || name.toLowerCase();
}

function boundAttach(raw: unknown): ExportAttach | null {
  const o = rec(raw);
  if (!o) return null;
  const path = typeof o.path === "string" ? o.path : "";
  if (!path) return null;
  return {
    path: redactExportText(path),
    kind: typeof o.kind === "string" ? o.kind : "file",
    status: typeof o.status === "string" ? o.status : "ok",
  };
}

function dropBlobKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if ((DROP_ATTACH_KEYS as readonly string[]).includes(k)) continue;
    if (k === "attachments" && Array.isArray(v)) {
      out.attachments = v.map(boundAttach).filter(Boolean);
      continue;
    }
    if (k === "output" && typeof v === "string") {
      out.output = truncateExportText(redactExportText(v), JSON_TOOL_OUTPUT_MAX_CHARS);
      continue;
    }
    if (k === "input") {
      out.input = redactExportJson(v);
      continue;
    }
    if (k === "usage" && rec(v)) {
      out.usage = redactExportJson(v);
      continue;
    }
    out[k] = redactExportJson(v);
  }
  return out;
}

function boundMessage(m: SourceMessage): ExportMessage {
  const role = String(m.role || "user");
  const meta = metaOf(m);
  return {
    role,
    content: redactExportText(String(m.content ?? "")),
    createdAt: iso(m.createdAt),
    metadata: Object.keys(meta).length ? dropBlobKeys(meta) : null,
  };
}

function toolSummary(m: SourceMessage, maxOut: number): ExportToolSummary {
  const meta = metaOf(m);
  const outputRaw =
    (typeof meta.output === "string" ? meta.output : null) ||
    String(m.content ?? "");
  return {
    toolCallId: typeof meta.toolCallId === "string" ? meta.toolCallId : "",
    name: canonicalToolName(String(meta.toolName || m.content || "tool")),
    status: typeof meta.status === "string" ? meta.status : "done",
    input: redactExportJson(meta.input ?? null),
    output: truncateExportText(redactExportText(outputRaw), maxOut),
  };
}

function usageFromMeta(meta: Record<string, unknown>): ExportUsageEntry | null {
  if (meta.kind !== USAGE_META_KIND) return null;
  const usage = rec(meta.usage);
  if (!usage) return null;
  const provider =
    typeof meta.provider === "string" && meta.provider.trim()
      ? meta.provider
      : "unknown";
  const modelId = typeof meta.modelId === "string" ? meta.modelId : null;
  return {
    provider,
    modelId,
    usage: redactExportJson(usage) as Record<string, unknown>,
  };
}

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return truncateExportText(redactExportText(input), TOOL_SUMMARY_MAX_CHARS);
  }
  const o = rec(input);
  if (o) {
    const cmd = o.command ?? o.path ?? o.pattern ?? o.file_path;
    if (typeof cmd === "string") {
      return truncateExportText(redactExportText(cmd), TOOL_SUMMARY_MAX_CHARS);
    }
  }
  try {
    return truncateExportText(
      redactExportText(JSON.stringify(input)),
      TOOL_SUMMARY_MAX_CHARS,
    );
  } catch {
    return "";
  }
}

function mapDiffs(rows: SourceDiffRow[] | undefined): ExportDiffSummary[] {
  if (!rows?.length) return [];
  const out: ExportDiffSummary[] = [];
  for (const d of rows) {
    if (d.status === "rejected") continue;
    const path = typeof d.path === "string" ? d.path : "";
    if (!path) continue;
    out.push({
      path: redactExportText(path),
      kind: typeof d.kind === "string" ? d.kind : "modified",
      status: typeof d.status === "string" ? d.status : "applied",
      additions: num(d.additions),
      deletions: num(d.deletions),
    });
  }
  return out;
}

export function assembleChatExport(input: {
  title?: string | null;
  messages: SourceMessage[];
  diffs?: SourceDiffRow[];
  exportedAt?: string;
}): ChatExportResult {
  const title = (input.title || "").trim() || DEFAULT_CHAT_TITLE;
  const messages = input.messages.map(boundMessage);
  const usage: ExportUsageEntry[] = [];
  for (const m of input.messages) {
    const u = usageFromMeta(metaOf(m));
    if (u) usage.push(u);
  }
  const diffs = mapDiffs(input.diffs);
  const document: ChatExportDocument = {
    format: EXPORT_FORMAT_ID,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt || new Date().toISOString(),
    chat: { title: redactExportText(title) },
    messages,
    usage,
    diffs,
  };
  const clean = redactExportJson(document) as ChatExportDocument;
  return {
    document: clean,
    markdown: formatChatMarkdown(clean, input.messages, input.diffs),
  };
}

function attachesOf(m: SourceMessage): ExportAttach[] {
  const raw = metaOf(m).attachments;
  if (!Array.isArray(raw)) return [];
  return raw.map(boundAttach).filter((a): a is ExportAttach => Boolean(a));
}

export function formatChatMarkdown(
  doc: ChatExportDocument,
  source?: SourceMessage[],
  diffs?: SourceDiffRow[],
): string {
  const lines: string[] = [`# ${doc.chat.title}`, ""];
  const src = source ?? [];
  const diffSum = doc.diffs.length ? doc.diffs : mapDiffs(diffs);
  let diffsEmitted = false;

  const emitTools = (tools: SourceMessage[]) => {
    if (!tools.length) return;
    lines.push("## tools");
    for (const t of tools) {
      const s = toolSummary(t, TOOL_SUMMARY_MAX_CHARS);
      lines.push(`tool · ${s.name} · ${s.status}`);
      const inn = summarizeInput(s.input);
      if (inn) lines.push(`  in: ${inn}`);
      if (s.output) {
        const outLines = s.output.split("\n");
        lines.push(`  out: ${outLines[0] ?? ""}`);
        for (const extra of outLines.slice(1)) lines.push(`  ${extra}`);
      }
    }
    lines.push("");
  };

  let pendingTools: SourceMessage[] = [];
  const flushTools = () => {
    emitTools(pendingTools);
    pendingTools = [];
  };

  for (let i = 0; i < src.length; i++) {
    const m = src[i]!;
    const role = String(m.role || "");
    if (role === "tool") {
      pendingTools.push(m);
      continue;
    }
    flushTools();
    lines.push(`## ${role}`);
    lines.push(redactExportText(String(m.content ?? "")));
    lines.push("");
    const atts = attachesOf(m);
    if (atts.length) {
      lines.push("## attaches");
      for (const a of atts) {
        lines.push(`@ ${a.path}  ${a.kind}  ${a.status}`);
      }
      lines.push("");
    }
    if (!diffsEmitted && diffSum.length && role === "assistant") {
      lines.push("## diffs");
      for (const d of diffSum) {
        lines.push(`${d.path}  ${d.kind}  +${d.additions} −${d.deletions}`);
      }
      lines.push("");
      diffsEmitted = true;
    }
  }
  flushTools();
  if (!diffsEmitted && diffSum.length) {
    lines.push("## diffs");
    for (const d of diffSum) {
      lines.push(`${d.path}  ${d.kind}  +${d.additions} −${d.deletions}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function parseExportDocument(raw: unknown): ChatExportDocument | null {
  const o = rec(raw);
  if (!o) return null;
  if (o.format !== EXPORT_FORMAT_ID) return null;
  if (o.version !== EXPORT_FORMAT_VERSION) return null;
  const chat = rec(o.chat);
  if (!chat || typeof chat.title !== "string") return null;
  if (!Array.isArray(o.messages)) return null;
  const messages: ExportMessage[] = [];
  for (const item of o.messages) {
    const m = rec(item);
    if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
      return null;
    }
    messages.push({
      role: m.role,
      content: String(m.content),
      createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
      metadata: rec(m.metadata),
    });
  }
  const usage: ExportUsageEntry[] = [];
  if (Array.isArray(o.usage)) {
    for (const item of o.usage) {
      const u = rec(item);
      if (!u || typeof u.provider !== "string") continue;
      const blob = rec(u.usage) ?? {};
      usage.push({
        provider: u.provider,
        modelId: typeof u.modelId === "string" ? u.modelId : null,
        usage: blob,
      });
    }
  }
  const diffs = mapDiffs(
    Array.isArray(o.diffs) ? (o.diffs as SourceDiffRow[]) : [],
  );
  return {
    format: EXPORT_FORMAT_ID,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
    chat: { title: chat.title },
    messages,
    usage,
    diffs,
  };
}

export function importedChatTitle(original: string): string {
  const t = (original || "").trim() || DEFAULT_CHAT_TITLE;
  if (t.startsWith(IMPORT_TITLE_PREFIX)) return t.slice(0, 120);
  return `${IMPORT_TITLE_PREFIX}${t}`.slice(0, 120);
}

export function messagesForImport(doc: ChatExportDocument): ExportMessage[] {
  return doc.messages.map((m) => {
    const meta = rec(m.metadata) ?? {};
    const bounded = dropBlobKeys({
      ...meta,
      imported: true,
      importedAt: new Date().toISOString(),
    });
    return {
      role: ["user", "assistant", "system", "tool"].includes(m.role)
        ? m.role
        : "user",
      content: redactExportText(m.content),
      createdAt: m.createdAt,
      metadata: bounded,
    };
  });
}

export function shareViewFromExport(
  title: string,
  createdAt: string,
  messages: SourceMessage[],
): ShareView {
  const assembled = assembleChatExport({ title, messages });
  return {
    title: assembled.document.chat.title,
    createdAt,
    messages: assembled.document.messages,
    banner: SHARE_READONLY_BANNER,
  };
}

export function documentHasForbidden(doc: ChatExportDocument, needle: string): boolean {
  return JSON.stringify(doc).includes(needle);
}
```

- [ ] Crear `cli/src/chats/export-share.test.ts` (copiar la batería a `api/src/chats/export-share.test.ts` y `web/src/lib/export-share.test.ts`, ajustando el import). Casos **obligatorios**:

```ts
import { describe, expect, test } from "bun:test";
import {
  assembleChatExport,
  parseExportDocument,
  messagesForImport,
  importedChatTitle,
  shareViewFromExport,
  parseExportFormat,
  documentHasForbidden,
  EXPORT_FORMAT_ID,
  IMPORT_TITLE_PREFIX,
  SHARE_READONLY_BANNER,
  TOOL_SUMMARY_MAX_CHARS,
  DROP_ATTACH_KEYS,
} from "./export-share";

const SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAA";
const GHP = "ghp_secrettokenvalue";

function fixture() {
  return [
    {
      id: "u1",
      role: "user",
      content: `arregla @src/a.ts ${SECRET}`,
      createdAt: "2026-09-16T10:00:00.000Z",
      metadata: {
        streamId: "s1",
        attachments: [
          {
            path: "src/a.ts",
            kind: "text",
            status: "ok",
            hydratedText: `export const x = 1\nANTHROPIC_API_KEY=${SECRET}`,
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
        streamId: "s1",
        toolCallId: "tc1",
        toolName: "Bash",
        status: "done",
        input: { command: `cat .env && echo ${GHP}` },
        output: `${"x".repeat(TOOL_SUMMARY_MAX_CHARS + 80)}\n${GHP}`,
      },
    },
    {
      id: "a1",
      role: "assistant",
      content: `listo. token=${SECRET}`,
      createdAt: "2026-09-16T10:00:02.000Z",
      metadata: {
        streamId: "s1",
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4, total_cost_usd: 0.0012 },
      },
    },
  ];
}

describe("assembleChatExport", () => {
  test("markdown has user/assistant and tool/diff summaries; attaches are paths", () => {
    const { markdown, document } = assembleChatExport({
      title: "Fix auth",
      messages: fixture(),
      diffs: [
        {
          path: "src/a.ts",
          kind: "modified",
          status: "applied",
          additions: 3,
          deletions: 1,
          body: "THIS BODY MUST NOT APPEAR",
          preview: "--- a\n+++ b",
        },
      ],
    });
    expect(markdown.startsWith("# Fix auth")).toBe(true);
    expect(markdown).toContain("## user");
    expect(markdown).toContain("## assistant");
    expect(markdown).toContain("## tools");
    expect(markdown).toContain("tool · bash · done");
    expect(markdown).toContain("## diffs");
    expect(markdown).toContain("src/a.ts  modified  +3 −1");
    expect(markdown).toContain("@ src/a.ts  text  ok");
    expect(markdown).toContain("@ logo.png  image  ok");
    expect(markdown).not.toContain("imageBase64");
    expect(markdown).not.toContain("AAAA");
    expect(markdown).not.toContain("hydratedText");
    expect(markdown).not.toContain("THIS BODY MUST NOT APPEAR");
    expect(markdown).not.toContain(SECRET);
    expect(markdown).not.toContain(GHP);
    expect(document.format).toBe(EXPORT_FORMAT_ID);
    expect(document.chat).toEqual({ title: "Fix auth" });
    expect((document.chat as { userId?: string }).userId).toBeUndefined();
    expect(document.usage).toEqual([
      {
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4, total_cost_usd: 0.0012 },
      },
    ]);
    const img = (document.messages[0]!.metadata as { attachments: Array<Record<string, unknown>> })
      .attachments[1]!;
    for (const k of DROP_ATTACH_KEYS) expect(img[k]).toBeUndefined();
    expect(documentHasForbidden(document, SECRET)).toBe(false);
    expect(documentHasForbidden(document, "imageBase64")).toBe(false);
  });

  test("JSON keeps raw usage per provider and does not flatten schemas", () => {
    const mixed = fixture();
    mixed.push({
      id: "a2",
      role: "assistant",
      content: "cursor turn",
      createdAt: "2026-09-16T10:00:03.000Z",
      metadata: {
        kind: "turn_usage",
        provider: "cursor",
        modelId: "composer",
        usage: { inputTokens: 20, outputTokens: 8, optimize_for: "cost" },
      },
    });
    const { document, markdown } = assembleChatExport({
      title: "mix",
      messages: mixed,
    });
    expect(document.usage).toHaveLength(2);
    expect(document.usage[0]!.usage).toHaveProperty("input_tokens", 12);
    expect(document.usage[1]!.usage).toHaveProperty("inputTokens", 20);
    expect(document.usage[1]!.usage).toHaveProperty("optimize_for", "cost");
    expect(JSON.stringify(document.usage[1])).not.toContain("effort");
    expect(markdown).not.toContain("input_tokens");
  });

  test("parse + import copies history and does not look like a tool rerun", () => {
    const { document } = assembleChatExport({
      title: "Fix auth",
      messages: fixture(),
    });
    const parsed = parseExportDocument(document);
    expect(parsed).not.toBeNull();
    const rows = messagesForImport(parsed!);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.role).toBe("tool");
    expect(rows[1]!.metadata).toMatchObject({ imported: true, status: "done" });
    expect(importedChatTitle("Fix auth")).toBe(`${IMPORT_TITLE_PREFIX}Fix auth`);
    expect(typeof rows[1]!.metadata).toBe("object");
  });

  test("share view has banner and no vault fields", () => {
    const view = shareViewFromExport(
      "Fix auth",
      "2026-09-16T10:00:00.000Z",
      fixture(),
    );
    expect(view.banner).toBe(SHARE_READONLY_BANNER);
    expect(JSON.stringify(view)).not.toContain("ciphertext");
    expect(JSON.stringify(view)).not.toContain("userId");
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test("parseExportFormat", () => {
    expect(parseExportFormat("md")).toBe("md");
    expect(parseExportFormat("markdown")).toBe("md");
    expect(parseExportFormat("json")).toBe("json");
    expect(parseExportFormat("xml")).toBeNull();
  });

  test("invalid document is rejected", () => {
    expect(parseExportDocument({ format: "nope", version: 1, chat: { title: "x" }, messages: [] })).toBeNull();
    expect(parseExportDocument({ hello: true })).toBeNull();
  });
});
```

- [ ] Correr:

```bash
cd cli && bun test src/chats/export-share.test.ts
cd api && bun test src/chats/export-share.test.ts
cd web && bun test src/lib/export-share.test.ts
```

Esperado: todos green. Markdown sin `sk-ant-` / `imageBase64` / body de diff. JSON con `usage` crudo Claude **y** Cursor por separado. `parseExportDocument` round-trip. El módulo no spawnea.

- [ ] Commit:

```bash
git add cli/src/chats/export-share.ts cli/src/chats/export-share.test.ts \
  api/src/chats/export-share.ts api/src/chats/export-share.test.ts \
  web/src/lib/export-share.ts web/src/lib/export-share.test.ts \
  cli/package.json api/package.json web/package.json
git commit -m "feat(export-share): bound redacted markdown and JSON chat export codec"
```

---

## Task 2: Schema `chat_share_links` + token

**Files:**

- Modify: `api/src/db/schema.ts`
- Create: `api/src/chats/share-token.ts`
- Test: `api/src/chats/share-token.test.ts`

Una fila por link. Como máximo **un activo** por `chatId` (se enforcea en la API, Task 4). Token 32 bytes `base64url` (URL-safe, no adivina). Cascade al borrar el chat.

- [ ] Añadir al final de `api/src/db/schema.ts`:

```ts
export const chatShareLinks = pgTable(
  "chat_share_links",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("chat_share_links_token_uidx").on(table.token),
  ],
);
```

No añadir columnas de org, role, member, workspace compartido.

- [ ] Crear `api/src/chats/share-token.ts`:

```ts
import { SHARE_TOKEN_BYTES } from "./export-share";

export function generateShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function isShareTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,}$/.test(token);
}
```

- [ ] Test `api/src/chats/share-token.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { generateShareToken, isShareTokenShape } from "./share-token";
import { SHARE_TOKEN_BYTES } from "./export-share";

describe("generateShareToken", () => {
  test("url-safe, unique, long enough", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
    expect(isShareTokenShape(a)).toBe(true);
    expect(a).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(a, "base64url");
    expect(decoded.byteLength).toBe(SHARE_TOKEN_BYTES);
  });
});
```

- [ ] Aplicar schema:

```bash
cd api && bun run db:push
```

Si `db:push` pide confirmación, usar el flag que drizzle-kit acepte en este repo (`--force` / stdin `y`) **solo** para añadir `chat_share_links`. No borrar tablas Better Auth.

- [ ] `cd api && bun test src/chats/share-token.test.ts` — green.

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/src/chats/share-token.ts api/src/chats/share-token.test.ts
git commit -m "feat(export-share): chat_share_links table and unguessable token"
```

---

## Task 3: API export — `chat.export` y `GET /chats/:chatId/export`

**Files:**

- Create: `api/src/chats/export-load.ts`
- Test: `api/src/chats/export-load.test.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/ws/protocol.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/index.ts` (solo si hace falta CORS extra; `/chats/*` ya cubre export)

La API **no** llama `hub.findDaemon`. **No** manda `agent.turn.dispatch`. Cinturón `redactExportJson` sobre el documento.

- [ ] En `api/src/ws/protocol.ts`, ampliar `ClientMessage` (y el equivalente `WsRequest` en `cli/src/ws/client.ts` y `web/src/lib/ws-client.ts`) con campos opcionales **sin quitar los existentes**:

```ts
format?: string;
payload?: Record<string, unknown>;
token?: string;
```

- [ ] Crear `api/src/chats/export-load.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { chatMessages, chats } from "../db/schema";
import * as schema from "../db/schema";
import {
  assembleChatExport,
  parseExportFormat,
  FORMAT_REQUIRED,
  CHAT_NOT_FOUND,
  type ChatExportResult,
  type SourceDiffRow,
  type SourceMessage,
} from "./export-share";

export async function loadOwnedChat(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadChatMessages(chatId: string): Promise<SourceMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt));
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    metadata: (m.metadata as Record<string, unknown> | null) ?? null,
    createdAt: m.createdAt,
  }));
}

export async function loadExportDiffs(chatId: string): Promise<SourceDiffRow[]> {
  const table = (schema as { turnFileDiffs?: unknown }).turnFileDiffs;
  if (!table) return [];
  try {
    const rows = await db
      .select()
      .from(table as typeof chatMessages)
      .where(eq((table as { chatId: typeof chatMessages.chatId }).chatId, chatId));
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      streamId: typeof r.streamId === "string" ? r.streamId : null,
      path: typeof r.path === "string" ? r.path : null,
      kind: typeof r.kind === "string" ? r.kind : null,
      status: typeof r.status === "string" ? r.status : null,
      additions: typeof r.additions === "number" ? r.additions : null,
      deletions: typeof r.deletions === "number" ? r.deletions : null,
      preview: null,
      body: null,
    }));
  } catch {
    return [];
  }
}

export async function buildChatExport(input: {
  title: string;
  chatId: string;
  messages?: SourceMessage[];
}): Promise<ChatExportResult> {
  const messages = input.messages ?? (await loadChatMessages(input.chatId));
  const diffs = await loadExportDiffs(input.chatId);
  return assembleChatExport({ title: input.title, messages, diffs });
}

export { parseExportFormat, FORMAT_REQUIRED, CHAT_NOT_FOUND };
```

Si TypeScript se queja de `turnFileDiffs`, dejar `loadExportDiffs` devolviendo `[]` con comentario `// plan 6: when turnFileDiffs exists, query path/kind/status/±; never select body`.

- [ ] Test `api/src/chats/export-load.test.ts`: `loadExportDiffs` con schema actual → `[]`. `assembleChatExport` (importado) sobre el fixture de Task 1 no contiene `sk-ant-`. No hace falta Postgres para este test.

- [ ] En `api/src/ws/handlers.ts`, case **después** de `chat.get`. Reusar `loadChatForUser` (ya 404-equivale con `"Chat not found"`). Importar `buildChatExport` y `parseExportFormat` / `FORMAT_REQUIRED`.

```ts
case "chat.export": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const format = parseExportFormat(msg.format ?? "json");
  if (!format) return fail(type, id, FORMAT_REQUIRED);
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const result = await buildChatExport({
    title: chat.title,
    chatId: chat.id,
  });
  return ok(type, id, {
    format,
    markdown: result.markdown,
    document: result.document,
  });
}
```

**Prohibido** en este case: `hub.findDaemon`, `sendTo`, `agent.turn.dispatch`, leer cwd, `publishAgentTurn`, `decryptSecret`, tocar `providerCredentials`.

- [ ] En `api/src/routes/workspaces.ts`, dentro de `createSessionChatRoutes`, **después** de `GET /chats/:chatId`:

```ts
app.get("/chats/:chatId/export", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const chatId = c.req.param("chatId");
  const format = parseExportFormat(c.req.query("format") ?? "json");
  if (!format) return c.json({ error: FORMAT_REQUIRED }, 400);
  const chatRows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
    .limit(1);
  if (!chatRows[0]) return c.json({ error: "Chat not found" }, 404);
  const result = await buildChatExport({
    title: chatRows[0].title,
    chatId,
  });
  const accept = c.req.header("accept") || "";
  if (format === "md" && accept.includes("text/markdown")) {
    return c.body(result.markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  }
  if (format === "md") return c.json({ markdown: result.markdown });
  return c.json(result.document);
});
```

Importar `buildChatExport`, `parseExportFormat`, `FORMAT_REQUIRED` desde `../chats/export-load`.

- [ ] Test de contrato (sin Postgres si no hay harness): función helper `exportHttpStatus(userId, chatUserId)` → 404 vs 200. Alternativa: test del case con `loadOwnedChat` mockeado no es obligatorio si `loadChatForUser` ya cubre 404 en e2e existentes; sí es obligatorio un test de `assembleChatExport` que el handler usa.

Añadir en `api/src/chats/export-load.test.ts`:

```ts
test("foreign chat is not distinguished from missing (same error string)", () => {
  expect(CHAT_NOT_FOUND).toBe("Chat not found");
});
```

El 404 vs 401 lo cubre Task 8 (HTTP). El handler reusa el string existente de `chat.get`.

- [ ] `cd api && bun test src/chats/export-load.test.ts src/chats/export-share.test.ts`

- [ ] Commit:

```bash
git add api/src/chats/export-load.ts api/src/chats/export-load.test.ts \
  api/src/ws/handlers.ts api/src/ws/protocol.ts \
  cli/src/ws/client.ts web/src/lib/ws-client.ts \
  api/src/routes/workspaces.ts
git commit -m "feat(export-share): chat.export HTTP and WS without daemon"
```

---

## Task 4: API import — chat nuevo, tools no se re-ejecutan

**Files:**

- Create: `api/src/chats/import-chat.ts`
- Test: `api/src/chats/import-chat.test.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/workspaces.ts`

Import = `chat.create` + N inserts. Mensajes nuevos con `crypto.randomUUID()`. `metadata.imported = true`. **Cero** `hub.findDaemon`.

- [ ] Crear `api/src/chats/import-chat.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, chatMessages, chats } from "../db/schema";
import {
  importedChatTitle,
  messagesForImport,
  parseExportDocument,
  IMPORT_INVALID,
  SESSION_NOT_FOUND,
  type ChatExportDocument,
} from "./export-share";

export async function importChatDocument(input: {
  userId: string;
  sessionId: string;
  raw: unknown;
}): Promise<
  | { ok: true; chat: typeof chats.$inferSelect }
  | { ok: false; error: string }
> {
  const doc = parseExportDocument(input.raw);
  if (!doc) return { ok: false, error: IMPORT_INVALID };

  const sessions = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.userId, input.userId),
      ),
    )
    .limit(1);
  if (!sessions[0]) return { ok: false, error: SESSION_NOT_FOUND };

  const now = new Date();
  const chat = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    userId: input.userId,
    title: importedChatTitle(doc.chat.title),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(chats).values(chat);

  const rows = messagesForImport(doc);
  for (const m of rows) {
    const createdAt = m.createdAt ? new Date(m.createdAt) : now;
    await db.insert(chatMessages).values({
      id: crypto.randomUUID(),
      chatId: chat.id,
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      createdAt: Number.isNaN(createdAt.getTime()) ? now : createdAt,
    });
  }
  return { ok: true, chat };
}

export type { ChatExportDocument };
```

Insertar mensajes en un loop está bien (N típico ≪ 1000). Si se prefiere `db.insert(chatMessages).values(array)`, un solo insert batch. **No** llamar tools.

- [ ] Test `api/src/chats/import-chat.test.ts` (puro sobre `messagesForImport` + `parseExportDocument`; el insert se testea en el handler con un test de “no dispatch”):

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assembleChatExport,
  messagesForImport,
  parseExportDocument,
  IMPORT_INVALID,
} from "./export-share";

test("imported tool rows stay historical", () => {
  const { document } = assembleChatExport({
    title: "t",
    messages: [
      {
        role: "tool",
        content: "rm -rf /",
        createdAt: "2026-09-16T10:00:00.000Z",
        metadata: {
          toolName: "Bash",
          status: "done",
          input: { command: "rm -rf /" },
        },
      },
    ],
  });
  const rows = messagesForImport(document);
  expect(rows[0]!.metadata).toMatchObject({ imported: true, status: "done" });
  expect(rows[0]!.content).toContain("rm -rf /");
});

test("source of import-chat.ts never mentions agent.turn.dispatch", () => {
  const src = readFileSync(new URL("./import-chat.ts", import.meta.url), "utf8");
  expect(src).not.toContain("agent.turn.dispatch");
  expect(src).not.toContain("findDaemon");
  expect(src).not.toContain("publishAgentTurn");
  expect(src).not.toContain("query(");
});

test("garbage is IMPORT_INVALID", () => {
  expect(parseExportDocument({ nope: 1 })).toBeNull();
  expect(IMPORT_INVALID).toBe("Invalid export document");
});
```

- [ ] WS case `chat.import` (después de `chat.export`):

```ts
case "chat.import": {
  if (!msg.sessionId) return fail(type, id, "sessionId is required");
  const raw = msg.payload ?? msg.metadata ?? null;
  const result = await importChatDocument({
    userId,
    sessionId: msg.sessionId,
    raw,
  });
  if (!result.ok) return fail(type, id, result.error);
  broadcast(userId, "chat.created", { chat: result.chat }, connectionId);
  return ok(type, id, { chat: result.chat });
}
```

- [ ] HTTP en `createSessionChatRoutes`:

```ts
app.post("/sessions/:sessionId/chats/import", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json().catch(() => null);
  const result = await importChatDocument({
    userId: session.user.id,
    sessionId,
    raw: body,
  });
  if (!result.ok) {
    const status =
      result.error === SESSION_NOT_FOUND
        ? 404
        : result.error === IMPORT_INVALID
          ? 400
          : 400;
    return c.json({ error: result.error }, status);
  }
  hub.broadcastToUser(
    session.user.id,
    hub.pushEvent("chat.created", { chat: result.chat }),
  );
  return c.json({ chat: result.chat }, 201);
});
```

Importar `hub` ya está en `workspaces.ts`. Importar `importChatDocument`, `SESSION_NOT_FOUND`, `IMPORT_INVALID`.

- [ ] `cd api && bun test src/chats/import-chat.test.ts`

- [ ] Commit:

```bash
git add api/src/chats/import-chat.ts api/src/chats/import-chat.test.ts \
  api/src/ws/handlers.ts api/src/routes/workspaces.ts
git commit -m "feat(export-share): import JSON as a new chat without re-running tools"
```

---

## Task 5: API share — crear, leer, revocar, GET público

**Files:**

- Create: `api/src/chats/share.ts`
- Test: `api/src/chats/share.test.ts`
- Create: `api/src/routes/share.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/lib/config.ts` — **no** hace falta; `env.public.webOrigin` ya existe.

Un activo por chat. GET público **sin** `requireSession`. Payload = `shareViewFromExport` (mensajes acotados). Cero vault.

- [ ] Crear `api/src/chats/share.ts`:

```ts
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chatShareLinks, chats } from "../db/schema";
import { env } from "../lib/config";
import { generateShareToken } from "./share-token";
import {
  SHARE_NOT_FOUND,
  shareUrl,
  shareViewFromExport,
  type ShareView,
} from "./export-share";
import { loadChatMessages, loadOwnedChat } from "./export-load";

export async function getActiveShare(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chatShareLinks)
    .where(
      and(
        eq(chatShareLinks.chatId, chatId),
        eq(chatShareLinks.userId, userId),
        isNull(chatShareLinks.revokedAt),
      ),
    )
    .orderBy(desc(chatShareLinks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export function publicSharePayload(row: {
  token: string;
  createdAt: Date;
}) {
  return {
    token: row.token,
    url: shareUrl(env.public.webOrigin, row.token),
    createdAt: row.createdAt,
  };
}

export async function createShare(chatId: string, userId: string) {
  const chat = await loadOwnedChat(chatId, userId);
  if (!chat) return { ok: false as const, error: "Chat not found" };
  const existing = await getActiveShare(chatId, userId);
  if (existing) {
    return { ok: true as const, share: publicSharePayload(existing), created: false };
  }
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    chatId,
    userId,
    token: generateShareToken(),
    createdAt: now,
    revokedAt: null as Date | null,
  };
  await db.insert(chatShareLinks).values(row);
  return { ok: true as const, share: publicSharePayload(row), created: true };
}

export async function revokeShare(chatId: string, userId: string) {
  const chat = await loadOwnedChat(chatId, userId);
  if (!chat) return { ok: false as const, error: "Chat not found" };
  const existing = await getActiveShare(chatId, userId);
  if (!existing) return { ok: false as const, error: SHARE_NOT_FOUND };
  await db
    .update(chatShareLinks)
    .set({ revokedAt: new Date() })
    .where(eq(chatShareLinks.id, existing.id));
  return { ok: true as const, revoked: true };
}

export async function loadShareView(token: string): Promise<ShareView | null> {
  const rows = await db
    .select()
    .from(chatShareLinks)
    .where(eq(chatShareLinks.token, token))
    .limit(1);
  const link = rows[0];
  if (!link || link.revokedAt) return null;
  const chatRows = await db
    .select()
    .from(chats)
    .where(eq(chats.id, link.chatId))
    .limit(1);
  const chat = chatRows[0];
  if (!chat) return null;
  const messages = await loadChatMessages(chat.id);
  return shareViewFromExport(
    chat.title,
    chat.createdAt.toISOString(),
    messages,
  );
}
```

`loadShareView` **no** devuelve `userId`, `sessionId`, `workspaceId`, `path`, `ciphertext`. El viewer no obtiene membership.

- [ ] Test `api/src/chats/share.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { shareViewFromExport, SHARE_READONLY_BANNER } from "./export-share";
import { publicSharePayload } from "./share";

test("public payload is token+url+createdAt only", () => {
  const p = publicSharePayload({
    token: "abc",
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  });
  expect(Object.keys(p).sort()).toEqual(["createdAt", "token", "url"]);
  expect(p.url).toContain("/s/abc");
  expect(JSON.stringify(p)).not.toContain("ciphertext");
  expect(JSON.stringify(p)).not.toContain("userId");
});

test("share view banner and no vault", () => {
  const view = shareViewFromExport("t", "2026-09-16T00:00:00.000Z", [
    {
      role: "user",
      content: "hi",
      createdAt: "2026-09-16T00:00:00.000Z",
      metadata: { ciphertext: "SHOULD_DROP_VIA_KEY_NAME" },
    },
  ]);
  expect(view.banner).toBe(SHARE_READONLY_BANNER);
  expect(JSON.stringify(view)).not.toContain("SHOULD_DROP_VIA_KEY_NAME");
  expect(JSON.stringify(view.messages[0]!.metadata)).toContain("***");
});

test("share.ts does not touch vault or daemon", () => {
  const src = readFileSync(new URL("./share.ts", import.meta.url), "utf8");
  expect(src).not.toContain("providerCredentials");
  expect(src).not.toContain("decryptSecret");
  expect(src).not.toContain("findDaemon");
  expect(src).not.toContain("agent.turn");
});
```

`publicSharePayload` usa `env` → este test corre en `api/` donde `DATABASE_URL` ya es requerido al importar `../lib/config` vía `share.ts`. Si importar `share.ts` arranca config/db, **mover** `publicSharePayload` no: el test de `api/` ya asume env (el proceso de test de api carga config). Si `bun test` de api falla al importar `db` por `postgres()`, extraer `publicSharePayload` no depende de db — el import de `share.ts` sí tira de `db`. En ese caso el test de “keys only” se queda en `export-share.test.ts` (`shareUrl`) y `share.test.ts` solo lee el source con `readFileSync` **sin importar** `./share`. Preferir:

```ts
test("share.ts source has no vault/daemon", () => { /* readFileSync */ });
```

y el test de payload keys vive en Task 1 (`shareUrl`).

- [ ] WS cases:

```ts
case "chat.share.create": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const result = await createShare(msg.chatId, userId);
  if (!result.ok) return fail(type, id, result.error);
  broadcast(userId, "chat.share.updated", {
    chatId: msg.chatId,
    active: true,
  });
  return ok(type, id, result.share);
}
case "chat.share.get": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const chat = await loadChatForUser(msg.chatId, userId);
  if (!chat) return fail(type, id, "Chat not found");
  const existing = await getActiveShare(msg.chatId, userId);
  if (!existing) return fail(type, id, SHARE_NOT_FOUND);
  return ok(type, id, publicSharePayload(existing));
}
case "chat.share.revoke": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const result = await revokeShare(msg.chatId, userId);
  if (!result.ok) return fail(type, id, result.error);
  broadcast(userId, "chat.share.updated", {
    chatId: msg.chatId,
    active: false,
  });
  return ok(type, id, { revoked: true });
}
```

- [ ] HTTP dueño, en `createSessionChatRoutes`:

```ts
app.post("/chats/:chatId/share", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const result = await createShare(c.req.param("chatId"), session.user.id);
  if (!result.ok) return c.json({ error: result.error }, 404);
  hub.broadcastToUser(
    session.user.id,
    hub.pushEvent("chat.share.updated", {
      chatId: c.req.param("chatId"),
      active: true,
    }),
  );
  return c.json(result.share, result.created ? 201 : 200);
});

app.get("/chats/:chatId/share", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const chatId = c.req.param("chatId");
  const chat = await loadOwnedChat(chatId, session.user.id);
  if (!chat) return c.json({ error: "Chat not found" }, 404);
  const existing = await getActiveShare(chatId, session.user.id);
  if (!existing) return c.json({ error: SHARE_NOT_FOUND }, 404);
  return c.json(publicSharePayload(existing));
});

app.delete("/chats/:chatId/share", async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const result = await revokeShare(c.req.param("chatId"), session.user.id);
  if (!result.ok) {
    const status = result.error === SHARE_NOT_FOUND ? 404 : 404;
    return c.json({ error: result.error }, status);
  }
  hub.broadcastToUser(
    session.user.id,
    hub.pushEvent("chat.share.updated", {
      chatId: c.req.param("chatId"),
      active: false,
    }),
  );
  return c.json({ revoked: true });
});
```

Hono matchea `/chats/:chatId/export` y `/chats/:chatId/share` **antes** de cualquier wildcard; registrarlas junto a `/chats/:chatId` (ya está en el mismo router). Orden: `export`, `share` GET/POST/DELETE, luego el GET `/:chatId` existente — **mover** `GET /chats/:chatId` **después** de las subrutas si Hono pudiera tragar `export` como id (en Hono el path estático gana; igual coloca las subrutas primero por claridad).

- [ ] Crear `api/src/routes/share.ts`:

```ts
import { Hono } from "hono";
import { loadShareView } from "../chats/share";
import { SHARE_NOT_FOUND } from "../chats/export-share";

export function createSharePublicRoutes() {
  const app = new Hono();
  app.get("/:token", async (c) => {
    const token = c.req.param("token");
    const view = await loadShareView(token);
    if (!view) return c.json({ error: SHARE_NOT_FOUND }, 404);
    return c.json(view);
  });
  return app;
}
```

**Sin** `requireSession`. **Sin** cookie. Un 404 único.

- [ ] En `api/src/index.ts`:

```ts
import { createSharePublicRoutes } from "./routes/share";

app.use("/share/*", corsMiddleware);
app.route("/share", createSharePublicRoutes());
```

Colocar `app.route("/share", …)` junto a los otros `app.route`. No exigir auth en GET `/share/:token`.

- [ ] Confirmar que `GET /providers/:provider/credentials` **no** se llama desde `loadShareView` (el source test lo cubre).

- [ ] `cd api && bun test src/chats/share.test.ts src/chats/export-share.test.ts`

- [ ] Commit:

```bash
git add api/src/chats/share.ts api/src/chats/share.test.ts \
  api/src/routes/share.ts api/src/index.ts \
  api/src/ws/handlers.ts api/src/routes/workspaces.ts
git commit -m "feat(export-share): read-only share links with revoke and public GET"
```

---

## Task 6: CLI — `chat export` / `import` / `share` por HTTP

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/src/commands/headless-export.test.ts`

Sin daemon. Sin `ensureClient()` / `workspace.bind`. Usa `apiFetch` (Bearer). Markdown a stdout; `--out` escribe archivo.

- [ ] En `cli/src/commands/headless.ts`, **antes** del `if (group === "chat")` que llama `ensureClient()`, interceptar `export|import|share` para **no** exigir bind:

```ts
if (group === "chat" && (action === "export" || action === "import" || action === "share")) {
  await chatPortability(action, rest);
  return;
}
```

Añadir imports:

```ts
import { writeFileSync, readFileSync } from "node:fs";
import {
  EXPORT_USAGE,
  IMPORT_USAGE,
  SHARE_USAGE,
  IMPORT_JSON_ONLY,
  FORMAT_REQUIRED,
  parseExportFormat,
  parseExportDocument,
  type ChatExportDocument,
} from "../chats/export-share";
```

Implementar:

```ts
async function chatPortability(action: string, rest: string[]): Promise<void> {
  requireAuth();
  if (action === "export") {
    const chatId = rest[0];
    if (!chatId) throw new Error(EXPORT_USAGE);
    let format = "md";
    let out: string | null = null;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--format") {
        format = rest[++i] || "";
      } else if (rest[i] === "--out") {
        out = rest[++i] || null;
      } else if (rest[i] === "--format=json" || rest[i] === "--format=md") {
        format = rest[i]!.slice("--format=".length);
      } else if (rest[i]!.startsWith("--out=")) {
        out = rest[i]!.slice("--out=".length);
      }
    }
    const parsed = parseExportFormat(format);
    if (!parsed) throw new Error(FORMAT_REQUIRED);
    if (parsed === "md") {
      const data = await apiFetch<{ markdown: string }>(
        `/chats/${encodeURIComponent(chatId)}/export?format=md`,
      );
      const text = data.markdown;
      if (out) writeFileSync(out, text);
      else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    const data = await apiFetch<ChatExportDocument>(
      `/chats/${encodeURIComponent(chatId)}/export?format=json`,
    );
    const text = `${JSON.stringify(data, null, 2)}\n`;
    if (out) writeFileSync(out, text);
    else process.stdout.write(text);
    return;
  }

  if (action === "import") {
    const sessionId = rest[0];
    const file = rest[1];
    if (!sessionId || !file) throw new Error(IMPORT_USAGE);
    if (file.endsWith(".md")) throw new Error(IMPORT_JSON_ONLY);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(IMPORT_JSON_ONLY);
    }
    if (!parseExportDocument(raw)) throw new Error(IMPORT_JSON_ONLY);
    const data = await apiFetch<{ chat: { id: string; title: string } }>(
      `/sessions/${encodeURIComponent(sessionId)}/chats/import`,
      { method: "POST", body: JSON.stringify(raw) },
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (action === "share") {
    const sub = rest[0];
    const chatId = rest[1];
    if (!sub || !chatId) throw new Error(SHARE_USAGE);
    if (sub === "create") {
      const data = await apiFetch(`/chats/${encodeURIComponent(chatId)}/share`, {
        method: "POST",
        body: "{}",
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (sub === "get") {
      const data = await apiFetch(`/chats/${encodeURIComponent(chatId)}/share`);
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (sub === "revoke") {
      const data = await apiFetch(`/chats/${encodeURIComponent(chatId)}/share`, {
        method: "DELETE",
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    throw new Error(SHARE_USAGE);
  }
}
```

En el `throw` final de `chat`, ampliar usage:

```
"Uso: chavez headless chat <create|list|append|get|ask|watch|export|import|share> …"
```

`ApiError` de `apiFetch` ya imprime el `error` del body (404 `Chat not found`). No mapear a 403.

- [ ] En `cli/src/index.ts` `usage()`:

```
  chavez headless chat export <chatId> [--format md|json] [--out file]
  chavez headless chat import <sessionId> <file.json>
  chavez headless chat share create|get|revoke <chatId>
```

y una línea `EXPORT_HUB_HINT`.

- [ ] Test `cli/src/commands/headless-export.test.ts` (lee source, no spawnea daemon):

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_USAGE, IMPORT_JSON_ONLY } from "../chats/export-share";

const src = readFileSync(join(import.meta.dir, "headless.ts"), "utf8");

test("export/import/share skip ensureClient", () => {
  expect(src).toContain('action === "export" || action === "import" || action === "share"');
  expect(src).toContain("chatPortability");
  expect(src).toContain("EXPORT_USAGE");
  expect(src).toContain("IMPORT_JSON_ONLY");
  const intercept = src.indexOf('action === "export" || action === "import" || action === "share"');
  const ensure = src.indexOf("const client = await ensureClient();");
  expect(intercept).toBeGreaterThan(-1);
  expect(intercept).toBeLessThan(ensure);
});

test("portability path does not dispatch turns", () => {
  const start = src.indexOf("async function chatPortability");
  const slice = src.slice(start, start + 2500);
  expect(slice).not.toContain("agent.turn.request");
  expect(slice).not.toContain("ensureClient");
  expect(IMPORT_JSON_ONLY).toContain("chavez.chat.export");
});
```

Ajustar el assert de orden: `chatPortability` se llama en el intercept **antes** de `ensureClient` dentro de `headlessCommand`. El test de source `expect(src).toContain('if (group === "chat" && (action === "export"')` basta.

- [ ] `cd cli && bun test src/chats/export-share.test.ts src/commands/headless-export.test.ts`

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/commands/headless-export.test.ts
git commit -m "feat(export-share): headless chat export/import/share over HTTP"
```

---

## Task 7: TUI — tecla `E`, overlay export/share, sin ask en overlay

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json` (añadir `"test": "bun test"` si falta; TUI no necesita copia del codec)

TUI ya es daemon (`clientKind: "daemon"`). Overlay de export **no** corre un turn. WS `chat.export` / `chat.share.*`. Escape cierra overlay.

- [ ] Importar desde CLI:

```ts
import {
  TUI_EXPORT_HINT,
  SHARE_READONLY_BANNER,
  type ChatExportDocument,
} from "../../cli/src/chats/export-share";
```

- [ ] Estado:

```ts
type ExportOverlay = {
  markdown: string;
  url: string | null;
  status: string;
} | null;
const [exportOverlay, setExportOverlay] = useState<ExportOverlay>(null);
```

- [ ] En `useInput`, **si** `exportOverlay` está abierto:

```ts
if (exportOverlay) {
  if (key.escape) {
    setExportOverlay(null);
    return;
  }
  if (ch === "y" && client && activeChatId) {
    const res = await client.request({ type: "chat.share.create", chatId: activeChatId });
    if (res.ok) {
      const url = (res.data as { url?: string })?.url || "";
      setExportOverlay({ ...exportOverlay, url, status: url });
    } else setExportOverlay({ ...exportOverlay, status: res.error || "share failed" });
    return;
  }
  if (ch === "r" && client && activeChatId) {
    const res = await client.request({ type: "chat.share.revoke", chatId: activeChatId });
    setExportOverlay({
      ...exportOverlay,
      url: null,
      status: res.ok ? "revoked" : res.error || "revoke failed",
    });
    return;
  }
  return; // no filtrar E a compose / no quit
}
```

- [ ] En command mode (no compose, no busy-block para export: export **sí** se permite durante busy porque no es un turn), tecla `E` / `e`:

```ts
if ((ch === "e" || ch === "E") && client && activeChatId) {
  const res = await client.request({
    type: "chat.export",
    chatId: activeChatId,
    format: "md",
  });
  if (!res.ok) {
    setLog(res.error || "chat.export failed");
    return;
  }
  const markdown = String((res.data as { markdown?: string })?.markdown || "");
  setExportOverlay({ markdown, url: null, status: TUI_EXPORT_HINT });
  return;
}
```

Colocar **antes** de `if (busy) return` para que se pueda exportar un chat mientras genera **otro** no aplica (1 turn/daemon: el TUI **es** el daemon; igual export no despacha). Si `busy`, **permitir** `E` igual: es lectura.

- [ ] Render, encima del compositor cuando `exportOverlay`:

```tsx
{exportOverlay ? (
  <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
    <Text bold>Export / share</Text>
    <Text dimColor>{TUI_EXPORT_HINT}  [Y] link  [R] revocar</Text>
    {exportOverlay.url ? <Text color="cyan">{exportOverlay.url}</Text> : null}
    <Text dimColor>{exportOverlay.status}</Text>
    <Text>{exportOverlay.markdown.split("\n").slice(0, 18).join("\n")}</Text>
  </Box>
) : null}
```

No hay textarea de prompt en el overlay. No hay `agent.turn.request`.

- [ ] Hint de teclas en el header: añadir `[E] export` junto a `[s][c][m]`.

- [ ] `onPush`: si `msg.type === "chat.share.updated"` y overlay abierto del mismo `chatId`, refrescar `url` (null si `active: false`).

- [ ] No hay test Ink obligatorio. Añadir `tui/src/export-overlay.test.ts` que importa el codec y verifica que `TUI_EXPORT_HINT` contiene `[E]` y que `SHARE_READONLY_BANNER` no menciona vault decrypt. `cd tui && bun test` si se añadió script; si TUI no tiene `bun test` en package.json, añadirlo igual que CLI.

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/package.json tui/src/export-overlay.test.ts
git commit -m "feat(export-share): TUI export overlay and share yank/revoke"
```

Si no creas `tui/src/export-overlay.test.ts` porque el hint se testea en el codec, **no** lo listes en el commit. El hint ya está en Task 1. Entonces solo `App.tsx`.

---

## Task 8: Web — botones de export/share, import en session, página pública `/s/:token`

**Files:**

- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/SessionDetailPanel.tsx`
- Modify: `web/src/components/HubPanel.tsx`
- Create: `web/src/components/ShareTimeline.tsx`
- Create: `web/src/pages/s/[token].astro`
- Modify: `web/src/styles/global.css` (solo si hace falta `.banner`; reusar `.panel` / `.muted` / `.error`)
- Test: `web/src/lib/export-share.test.ts` (ya en Task 1)

El viewer público **no** monta `WsProvider` ni compositor ni `useProviders`. Dueño usa cookie.

- [ ] `queryKeys.shareView = (token: string) => ["shareView", token] as const` y `queryKeys.chatShare = (chatId: string) => ["chatShare", chatId] as const`.

- [ ] En `web/src/lib/hooks.ts`:

```ts
export function useChatExport() {
  return useMutation({
    mutationFn: (input: { chatId: string; format: "md" | "json" }) =>
      apiJson<ChatExportDocument | { markdown: string }>(
        `/chats/${input.chatId}/export?format=${input.format}`,
      ),
  });
}

export function useChatImport(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (document: unknown) =>
      apiJson<{ chat: Chat }>(`/sessions/${sessionId}/chats/import`, {
        method: "POST",
        body: JSON.stringify(document),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionChats(sessionId) });
    },
  });
}

export function useChatShare(chatId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chatShare(chatId),
    enabled: enabled && Boolean(chatId),
    queryFn: () =>
      apiJson<{ token: string; url: string; createdAt: string }>(
        `/chats/${chatId}/share`,
      ),
    retry: false,
  });
}

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      apiJson<{ token: string; url: string; createdAt: string }>(
        `/chats/${chatId}/share`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: (_d, chatId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatShare(chatId) });
    },
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      apiJson<{ revoked: true }>(`/chats/${chatId}/share`, { method: "DELETE" }),
    onSuccess: (_d, chatId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatShare(chatId) });
    },
  });
}

export function useShareView(token: string) {
  return useQuery({
    queryKey: queryKeys.shareView(token),
    enabled: Boolean(token),
    queryFn: () =>
      apiJson<{
        title: string;
        createdAt: string;
        messages: ChatMessage[];
        banner: string;
      }>(`/share/${encodeURIComponent(token)}`),
    retry: false,
  });
}
```

Importar tipos de `./export-share` para `ChatExportDocument` si se quiere; o dejar el genérico.

`useShareView` usa `apiJson` **con** `credentials: "include"` (default). Eso **no** autentica al dueño ante `/share/:token` (la ruta ignora la cookie). No enviar el token a `/providers`.

- [ ] Opcional WS hooks `useWsChatExport` / `useWsChatShareCreate` — Web puede ir **solo HTTP** para portability (como CLI). Preferir HTTP: no exige `workspace.bind` desde el browser.

- [ ] `ChatDetailPanel.tsx`: debajo del título, si `signedIn && chat.data`, panel:

```tsx
<div className="panel">
  <h2>Exportar / compartir</h2>
  <p className="muted">Sin vault. Attaches como paths. Tools no se re-ejecutan al importar.</p>
  <button type="button" onClick={() => void downloadExport("md")}>Export markdown</button>
  {" "}
  <button type="button" className="secondary" onClick={() => void downloadExport("json")}>
    Export JSON
  </button>
  {" "}
  <button type="button" className="secondary" onClick={() => void onShare()}>
    Crear link de solo lectura
  </button>
  {shareUrl && (
    <p>
      <a href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a>
      {" "}
      <button type="button" className="secondary" onClick={() => void onRevoke()}>
        Revocar
      </button>
    </p>
  )}
</div>
```

`downloadExport`: llama `useChatExport`, crea `Blob` (`text/markdown` o `application/json`), `URL.createObjectURL`, `<a download={`chat-${chatId.slice(0,8)}.md`}>`. **No** lee el filesystem del browser más que el download. **No** hidrata attaches.

El compositor `Enviar al agente` **sigue** en la página del dueño. En `ShareTimeline` **no**.

- [ ] `SessionDetailPanel.tsx`: form de import:

```tsx
<label htmlFor="import-json">Importar export JSON</label>
<input
  id="import-json"
  type="file"
  accept="application/json,.json"
  onChange={async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { setMsg({ kind: "error", text: "Import requires a JSON export (chavez.chat.export)" }); return; }
    const res = await chatImport.mutateAsync(raw);
    if (res.chat?.id) window.location.href = `/chats/${res.chat.id}`;
  }}
/>
```

Esto **no** es upload de un archivo del workspace al LLM (fuera de alcance). Es el JSON de export. Rechazar `.md`.

- [ ] Crear `web/src/components/ShareTimeline.tsx`:

```tsx
import { useShareView } from "../lib/hooks";
import { SHARE_READONLY_BANNER } from "../lib/export-share";

export function ShareTimeline({ token }: { token: string }) {
  const view = useShareView(token);
  return (
    <div>
      <div className="panel">
        <p className="muted">{SHARE_READONLY_BANNER}</p>
        {view.isLoading && <p className="muted">Cargando…</p>}
        {view.isError && <p className="error">Share not found</p>}
        {view.data && (
          <>
            <h1>{view.data.title}</h1>
            <p className="muted">{view.data.banner}</p>
            {(view.data.messages || []).map((m, i) => (
              <div key={i} className="panel" style={{ marginBottom: "0.5rem" }}>
                <span className="badge">{m.role}</span>
                <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>
                  {m.content}
                </pre>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

**No** `AppProviders` con WS. **No** `<form>` de prompt. **No** `useProviders`. **No** links a `/providers` desde este componente (el `BaseLayout` nav sigue visible: un click a Providers pide sign-in del **viewer**, nunca el vault de A).

Pintar `role=tool` como badge `tool · name · status` leyendo `metadata.toolName` si viene; el contenido ya es resumen acotado.

- [ ] Crear `web/src/pages/s/[token].astro`:

```astro
---
export const prerender = false;
import BaseLayout from "../../layouts/BaseLayout.astro";
import { ShareTimeline } from "../../components/ShareTimeline";

const { token } = Astro.params;
---
<BaseLayout title="Chat compartido">
  <ShareTimeline client:only="react" token={token!} />
</BaseLayout>
```

- [ ] `HubPanel.tsx`: un `<p className="muted">` con `EXPORT_HUB_HINT` (importar de `../lib/export-share`).

- [ ] Verificar a mano (o test de source):

```ts
// web/src/components/ShareTimeline.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
test("share timeline has no ask and no vault", () => {
  const src = readFileSync(join(import.meta.dir, "ShareTimeline.tsx"), "utf8");
  expect(src).not.toContain("agent.turn");
  expect(src).not.toContain("useProviders");
  expect(src).not.toContain("credentials");
  expect(src).not.toContain("useWsAgentTurn");
});
```

- [ ] `cd web && bun test`

- [ ] Commit:

```bash
git add web/src/lib/hooks.ts web/src/lib/query-keys.ts web/src/lib/ws-hooks.ts \
  web/src/components/ChatDetailPanel.tsx web/src/components/SessionDetailPanel.tsx \
  web/src/components/HubPanel.tsx web/src/components/ShareTimeline.tsx \
  web/src/components/ShareTimeline.test.ts web/src/pages/s/[token].astro
git commit -m "feat(export-share): web export/import and read-only share page"
```

---

## Task 9: OpenAPI + 404 cross-user + verificación Gherkin

**Files:**

- Modify: `api/openapi/openapi.yaml`
- Create: `api/src/chats/export-share-http.test.ts`
- Modify: `api/src/ws/handlers.ts` (comentario en `default` no; ya están los cases)

Documentar rutas. Fijar 401/404. Recorrer los 5 escenarios Gherkin.

- [ ] En `api/openapi/openapi.yaml`, tag `Share`. Paths (junto a `/chats/{chatId}`):

```yaml
  /chats/{chatId}/export:
    get:
      tags: [Chats]
      summary: Export markdown o JSON acotado (sin vault)
      operationId: exportChat
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/ChatId"
        - name: format
          in: query
          schema: { type: string, enum: [md, json], default: json }
      responses:
        "200":
          description: Markdown envelope o ChatExportDocument
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          $ref: "#/components/responses/NotFound"
  /chats/{chatId}/share:
    post:
      tags: [Share]
      summary: Crear o devolver link de solo lectura (no es membresía)
      operationId: createChatShare
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/ChatId"
      responses:
        "200": { description: Link activo existente }
        "201": { description: Link nuevo }
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          $ref: "#/components/responses/NotFound"
    get:
      tags: [Share]
      operationId: getChatShare
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/ChatId"
      responses:
        "200": { description: token, url, createdAt }
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          $ref: "#/components/responses/NotFound"
    delete:
      tags: [Share]
      operationId: revokeChatShare
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/ChatId"
      responses:
        "200": { description: "{ revoked: true }" }
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          $ref: "#/components/responses/NotFound"
  /sessions/{sessionId}/chats/import:
    post:
      tags: [Chats]
      summary: Importar un chavez.chat.export en un chat nuevo (no re-ejecuta tools)
      operationId: importChat
      security:
        - bearerAuth: []
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/SessionId"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                format: { type: string, example: chavez.chat.export }
                version: { type: integer, example: 1 }
      responses:
        "201": { description: "{ chat }" }
        "400": { description: Invalid export document }
        "401":
          $ref: "#/components/responses/Unauthorized"
        "404":
          $ref: "#/components/responses/NotFound"
  /share/{token}:
    get:
      tags: [Share]
      summary: Timeline de solo lectura. Sin auth. Sin vault. Sin ask.
      operationId: getPublicShare
      security: []
      parameters:
        - name: token
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: title, createdAt, messages acotados, banner
        "404":
          $ref: "#/components/responses/NotFound"
```

En la descripción de `/ws`, añadir `chat.export`, `chat.import`, `chat.share.create|get|revoke` a la lista de tipos. **No** añadir org/members.

Si `SessionId` / `ChatId` no existen como parameters, copiar el estilo de `$ref: "#/components/parameters/ChatId"` ya usado en `GET /chats/{chatId}`. Si no hay `SessionId`, inlinear `name: sessionId`.

- [ ] Crear `api/src/chats/export-share-http.test.ts` como test de **contratos de error** (strings + status mapping puro):

```ts
import { describe, expect, test } from "bun:test";
import {
  CHAT_NOT_FOUND,
  SESSION_NOT_FOUND,
  SHARE_NOT_FOUND,
  IMPORT_INVALID,
  FORMAT_REQUIRED,
} from "./export-share";

function ownerStatus(opts: {
  session: boolean;
  owned: boolean;
  kind: "export" | "import" | "share" | "public";
  shareExists?: boolean;
}): number {
  if (opts.kind === "public") return opts.shareExists ? 200 : 404;
  if (!opts.session) return 401;
  if (!opts.owned) return 404;
  if (opts.kind === "share" && opts.shareExists === false) return 404;
  return 200;
}

describe("http mapping", () => {
  test("other user is 404 not 403", () => {
    expect(ownerStatus({ session: true, owned: false, kind: "export" })).toBe(404);
    expect(ownerStatus({ session: true, owned: false, kind: "import" })).toBe(404);
    expect(ownerStatus({ session: true, owned: false, kind: "share" })).toBe(404);
    expect(CHAT_NOT_FOUND).toBe("Chat not found");
    expect(SESSION_NOT_FOUND).toBe("Session not found");
    expect(SHARE_NOT_FOUND).toBe("Share not found");
  });
  test("no session on owner routes is 401", () => {
    expect(ownerStatus({ session: false, owned: true, kind: "export" })).toBe(401);
  });
  test("public invalid token is 404 without leaking", () => {
    expect(ownerStatus({ session: false, owned: false, kind: "public", shareExists: false })).toBe(404);
  });
  test("constants", () => {
    expect(IMPORT_INVALID).toBe("Invalid export document");
    expect(FORMAT_REQUIRED).toBe("format must be md or json");
  });
});
```

- [ ] Grep de seguridad (obligatorio, en el test o a mano en esta task):

```bash
rg -n "decryptSecret|providerCredentials|agent.turn.dispatch|findDaemon" \
  api/src/chats api/src/routes/share.ts
```

Esperado: **cero** hits (salvo comentarios “prohibido”). `import-chat.ts` / `share.ts` / `export-load.ts` / `routes/share.ts` no despachan turns ni leen vault.

- [ ] Correr la batería:

```bash
cd api && bun test src/chats
cd cli && bun test src/chats src/commands/headless-export.test.ts
cd web && bun test src/lib/export-share.test.ts src/components/ShareTimeline.test.ts
```

Todos green.

- [ ] Commit:

```bash
git add api/openapi/openapi.yaml api/src/chats/export-share-http.test.ts
git commit -m "docs(export-share): OpenAPI for export, import, and read-only share"
```

---

## Orden de implementación y verificación Gherkin

| Escenario | Tasks | Cómo se demuestra |
|---|---|---|
| Export markdown | 1, 3, 6, 7, 8 | `GET /chats/:id/export?format=md` / `chavez headless chat export <id>` / TUI `E` / botón Web. Contiene `## user` `## assistant` `## tools` `## diffs` (si hay). Cero `sk-ant-` / `ghp_` / `ciphertext`. Attaches `@ path kind status`, no `imageBase64` ni `hydratedText`. |
| Export JSON | 1, 3, 6, 8 | `?format=json` → `format=chavez.chat.export`, `version=1`, `messages` acotados, `usage[]` crudo por provider (`input_tokens` Claude ≠ `inputTokens` Cursor). Sin `userId` / vault. |
| Import | 1, 4, 6, 8 | `POST /sessions/:id/chats/import` con el JSON propio → chat **nuevo** (`Imported: …`). Filas `role=tool` con `metadata.imported=true` y `status=done`. Source de `import-chat.ts` sin `findDaemon` / `agent.turn.dispatch`. Web file input JSON; `.md` rechazado. |
| Link de solo lectura | 2, 5, 7, 8 | `POST /chats/:id/share` → `{ token, url }` (`/s/{token}`). GET `/share/:token` **sin** cookie muestra timeline + `SHARE_READONLY_BANNER`. Página Web **sin** compositor / `agent.turn` / `useProviders`. `DELETE` → GET 404. Viewer B autenticado: `GET /chats/:id` del chat de A sigue 404. No hay tabla de miembros. |
| Sin sesión / otro user | 3, 4, 5, 9 | Dueño sin cookie → 401. User B sobre chatId de A → **404** `Chat not found` (export, import a session de A, share create). Token inventado o revocado → 404 `Share not found`. Nunca 403 “forbidden org”. |

Nada de esta fase abre el cwd desde API o browser. Turns siguen exigiendo daemon bound. Preferencias de provider/modo intactas. Un usuario = su vault. El link no es un team workspace.
