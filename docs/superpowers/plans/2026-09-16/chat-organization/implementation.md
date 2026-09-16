# Chat Organization Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not skip tests. Do not implement Cursor cloud, voz, extensión IDE, upload desde el navegador, org/roles, notificaciones OS/email, cola de turns (plan 29), worktrees paralelos (plan 28), export/share (plan 23), ni Cursor ejecutable (plan 4). Spec: [`plan.md`](./plan.md). Si un sibling (`ignore-secrets`, `slash-commands`, `onboarding`, `invariants`) ya creó un archivo citado, **extiéndelo**; no lo reescribas. Esta fase **no** reindexa disco ni toca tools: organiza sessions/chats que ya existen.

**Goal:** El hub de chats es usable con 1 o con 100 conversaciones. Un chat nuevo deja de mostrarse como el UUID cuando termina el **primer turn**: recibe un autotítulo recortado del primer prompt, editable en Web y TUI. Buscar por texto encuentra chats cuyo **título o mensajes user/assistant** coinciden; **no** se indexan outputs de tools (ni los secretos del [plan 8](../ignore-secrets/plan.md)). Pin sube en la lista; archivar oculta sin borrar; CLI lista puede filtrar archived. Crear/mover un chat respeta la session del **mismo workspace**. El overview Web no carga todos los mensajes de 100 chats: ventana + paginación. Pin en Web llega a TUI por el mismo `chat.updated`.

**Architecture:** El filesystem y el runner viven en el daemon (`cli/src/ws/daemon.ts` o TUI con `clientKind: "daemon"`). Organización de chats es **estado de API** (Postgres): no lee disco, no exige daemon. Mutaciones (`chat.update` / PATCH) y búsqueda (`chat.search` / GET `/chats/search`) las hace la API; el hub hace fan-out de `chat.updated`. Autotítulo corre en `chat.stream.end` del **primer** assistant persistido. Web, TUI y CLI `watch` ven el mismo chat; pin/título/archivo son el mismo row.

```
chat.create  title="Chat"  titleSource=default
        |
primer agent.turn  →  chat.stream.end (1er assistant)
        |  si titleSource !== user
        |  title = autotitleFromPrompt(primer user)
        |  titleSource = auto
        v
  broadcast chat.updated { chat }  →  Web / TUI / watch
        |
usuario edita título  →  titleSource=user  (nunca más autotítulo)
pin / archive / move  →  mismo event, mismo row
        |
GET /chats/search  /  chat.search
        |  title ILIKE  OR  messages user|assistant ILIKE
        |  NUNCA role=tool  NUNCA metadata.output  NUNCA secret
        v
listas: pinnedAt DESC, updatedAt DESC; archivedAt IS NULL por defecto
overview Web: ≤ CHATS_PER_SESSION_WINDOW chats/session + "Mostrar más"
```

Estado actual que este plan extiende (no reescribir):

- `api/src/db/schema.ts` `chats`: `id`, `sessionId`, `userId`, `title` default `"Chat"`, timestamps. **No** hay `pinnedAt`, `archivedAt`, `titleSource`.
- `chat.create` (`api/src/ws/handlers.ts`) no exige que la session sea del workspace bound: un cliente bound a A puede crear un chat en una session de B del mismo user.
- `chat.list` / GET `/sessions/:id/chats` / GET `/workspaces/:id/sessions` devuelven **todos** los chats, sin pin, sin archive, sin límite. El overview carga **todos** los `chat_messages` de esos chats para recortar 3 recientes (`RECENT_MESSAGES_PER_CHAT = 3` en `api/src/routes/workspaces.ts`). Con 100 chats eso explota.
- No hay `chat.rename` / `chat.update` / `chat.search` / `chat.move`. Títulos no se editan: Web `ChatDetailPanel.tsx` pinta `<strong>{chat.title}</strong>` de solo lectura; TUI crea `Chat ${time}` y no hay rename. El breadcrumb Web muestra `chatId.slice(0, 8)`, no el título.
- Autotítulo: `chat.stream.end` inserta assistant y `chats.updatedAt`; **no** toca `title`. Un chat nuevo se queda en `"Chat"` o en el timestamp de TUI.
- TUI `LIST_WINDOW = 12` ya ventanea sessions/chats en pantalla; no filtra archived ni reordena pin. `onPush` escucha `chat.created` / `session.created` / stream; **no** `chat.updated`.
- CLI `chavez headless chat`: `create|list|append|get|ask|watch`. Sin `search|pin|archive|rename|move` ni flags `--archived`.
- [ignore-secrets](../ignore-secrets/implementation.md) redacta keys en output de tools **antes** de persistir. Esta fase **no** re-redacta: la búsqueda **no lee** `role=tool` ni `metadata.output`. Si el sibling aún no aterrizó, el filtro de search sigue igual (no indexar tools).
- [slash-commands](../slash-commands/implementation.md) puede persistir `metadata.kind = "slash_result"`. Search los salta. `/` en compositor es slash; TUI en command mode usa `f` para buscar chats (no pelear el picker `/`).
- Cursor `runnable: false`. Autotítulo se dispara igual cuando un turn Claude termina; no simular un turn Cursor.

**Tech Stack:** Bun, Hono + Drizzle Postgres (`chats` columnas nuevas, `ILIKE` para search; sin motor de búsqueda), WebSocket hub in-memory, Better Auth (cookie Web + Bearer CLI), Ink TUI, Astro/React web. Tests: `bun test`. Web **no** importa CLI: duplicar `cli/src/chats/org.ts` en `api/src/chats/org.ts` y `web/src/lib/chat-org.ts` (comentario keep-in-sync). TUI importa `cli/src/chats/org.ts`.

**Global Constraints:**

1. El filesystem real vive en el daemon. Esta fase **cero** `readdir` / `readFile` en `api/` y `web/`. Pin, archive, título y search son filas Postgres del user, no del cwd.
2. Un turn de agente solo corre si hay daemon bound. Organización (list/search/pin/archive/rename/move) **no** exige daemon. Sin daemon, `agent.turn.request` sigue fallando con exactamente `"No daemon bound for this workspace. Run: chavez headless workspace open"`.
3. Web, CLI `watch` y TUI ven el mismo chat en vivo. `chat.updated` se broadcast a **todos** los sockets del user (incluido el emisor, para que TUI/Web no dependan de mutar estado local a ciegas). `watch` imprime el event; no es notificación OS.
4. Preferencias de provider/modelo/esfuerzo/modo **no** se tocan.
5. Claude es el provider ejecutable. Autotítulo se engancha a `chat.stream.end` (cualquier provider que persista assistant). No simular Cursor.
6. Tools por defecto siguen en el daemon. Search **no** indexa `role=tool` ni `metadata.output`. Outputs secretos del plan 8 no aparecen como hits aunque el query coincida con una key redactada o cruda en el tool row.
7. Lecturas (read/grep/glob) no piden confirmación. Pin/archive/rename no son tools y no entran en `canUseTool`.
8. `@` sigue siendo archivos del workspace (plan 1). Search de chats **no** es el picker `@` y **no** tiene tope 10: tope `SEARCH_LIMIT = 20`.
9. Un usuario = su vault. Search/list/patch filtran `chats.userId = session.user.id`. 404 si el chat es de otro user (no 403 “forbidden org”).
10. 1 turn por daemon. Pin/archive no cancelan el turn en curso. Autotítulo corre **después** de persistir el primer assistant, en el mismo `chat.stream.end`.
11. Aprobaciones siguen una a una (plan 13). Archive no es un lote de deletes.
12. Fuera de alcance: Cursor cloud, voz, extensión IDE, upload desde el navegador, notificaciones OS/email, full-text Postgres `tsvector`/pg_trgm, borrar chats, folders arbitrarios fuera de session, worktrees paralelos.

**Constantes (congeladas, no inventar otras):**

| Nombre | Valor |
|---|---|
| `DEFAULT_CHAT_TITLE` | `"Chat"` |
| `DEFAULT_SESSION_TITLE` | `"Session"` |
| `TITLE_SOURCES` | `"default"` \| `"auto"` \| `"user"` |
| `AUTOTITLE_MAX_CHARS` | `60` |
| `TITLE_MAX_CHARS` | `120` |
| `CHAT_UPDATED_EVENT` | `"chat.updated"` |
| `CHATS_PER_SESSION_WINDOW` | `20` |
| `SESSIONS_PAGE_SIZE` | `50` |
| `SEARCH_LIMIT` | `20` |
| `SEARCH_MIN_CHARS` | `2` |
| `SEARCH_DEBOUNCE_MS` | `150` |
| `RECENT_MESSAGES_PER_CHAT` | `3` (ya en `workspaces.ts`; **no cambiar**) |
| `TUI_LIST_WINDOW` | `12` (ya en TUI; **no cambiar**) |
| `NO_DAEMON_ERROR` | `"No daemon bound for this workspace. Run: chavez headless workspace open"` |
| `TITLE_REQUIRED` | `"title is required"` |
| `TITLE_TOO_LONG` | `"title must be at most 120 characters"` |
| `QUERY_TOO_SHORT` | `"query must be at least 2 characters"` |
| `CROSS_WORKSPACE_SESSION` | `"sessionId does not belong to the bound workspace"` |
| `CROSS_WORKSPACE_MOVE` | `"Cannot move chat to a session in another workspace"` |
| `SESSION_NOT_FOUND` | `"Session not found"` |
| `CHAT_NOT_FOUND` | `"Chat not found"` |
| `PIN_LABEL` | `"Pin"` |
| `UNPIN_LABEL` | `"Unpin"` |
| `ARCHIVE_LABEL` | `"Archivar"` |
| `UNARCHIVE_LABEL` | `"Desarchivar"` |
| `SEARCH_PLACEHOLDER` | `"Buscar chats…"` |
| `NO_SEARCH_MATCHES` | `"Ningún chat coincide"` |
| `SHOW_MORE_CHATS` | `"Mostrar más"` |
| `SHOW_ARCHIVED_LABEL` | `"Ver archivados"` |
| `HIDDEN_ARCHIVED_HINT` | `"Archivado — oculto en la lista"` |
| `RENAME_PROMPT` | `"Nuevo título"` |
| `AUTOTITLE_PENDING_HINT` | `"El título se asigna al terminar el primer turn"` |

`titleSource`: `"default"` (recién creado, placeholder), `"auto"` (primer turn), `"user"` (editado a mano). Autotítulo **solo** si `titleSource === "default"`.

`isPlaceholderTitle(title, chatId)` = título vacío, o igual a `DEFAULT_CHAT_TITLE`, o igual al `chatId` (entero o primeros 8 chars).

`isSearchableMessage(role, metadata)` = `role` es `"user"` o `"assistant"`, y `metadata.kind !== "slash_result"`, y `metadata.secret !== true`, y `metadata.vault !== true`. `role === "tool"` → **siempre** false.

Orden de lista (SQL y cliente): `pinnedAt IS NOT NULL DESC`, `pinnedAt DESC NULLS LAST`, `updatedAt DESC`. Archivados (`archivedAt IS NOT NULL`) fuera de las listas por defecto.

---

## Task 1: Módulo puro — autotítulo, searchability, sort

**Files:**

- Create: `cli/src/chats/org.ts`
- Test: `cli/src/chats/org.test.ts`
- Create: `api/src/chats/org.ts`
- Test: `api/src/chats/org.test.ts`
- Create: `web/src/lib/chat-org.ts`
- Test: `web/src/lib/chat-org.test.ts`
- Modify: `cli/package.json`
- Modify: `api/package.json`
- Modify: `web/package.json`

Sin I/O de red ni Postgres. TUI importa CLI. API y Web **duplican** el módulo (keep-in-sync en la primera línea). Tres copias, misma semántica.

- [ ] Añadir `"test": "bun test"` en `cli/package.json`, `api/package.json` y `web/package.json` `scripts` si aún no existe (dejar `start`/`dev`/`bin`/`db:*`/`test:e2e`/`build` intactos).

- [ ] Crear `cli/src/chats/org.ts`:

```ts
/** keep-in-sync: api/src/chats/org.ts, web/src/lib/chat-org.ts */

export const DEFAULT_CHAT_TITLE = "Chat";
export const DEFAULT_SESSION_TITLE = "Session";
export const TITLE_SOURCES = ["default", "auto", "user"] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];
export const DEFAULT_TITLE_SOURCE: TitleSource = "default";

export const AUTOTITLE_MAX_CHARS = 60;
export const TITLE_MAX_CHARS = 120;
export const CHAT_UPDATED_EVENT = "chat.updated";
export const CHATS_PER_SESSION_WINDOW = 20;
export const SESSIONS_PAGE_SIZE = 50;
export const SEARCH_LIMIT = 20;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 150;
export const TUI_LIST_WINDOW = 12;

export const TITLE_REQUIRED = "title is required";
export const TITLE_TOO_LONG = "title must be at most 120 characters";
export const QUERY_TOO_SHORT = "query must be at least 2 characters";
export const CROSS_WORKSPACE_SESSION =
  "sessionId does not belong to the bound workspace";
export const CROSS_WORKSPACE_MOVE =
  "Cannot move chat to a session in another workspace";
export const SESSION_NOT_FOUND = "Session not found";
export const CHAT_NOT_FOUND = "Chat not found";
export const PIN_LABEL = "Pin";
export const UNPIN_LABEL = "Unpin";
export const ARCHIVE_LABEL = "Archivar";
export const UNARCHIVE_LABEL = "Desarchivar";
export const SEARCH_PLACEHOLDER = "Buscar chats…";
export const NO_SEARCH_MATCHES = "Ningún chat coincide";
export const SHOW_MORE_CHATS = "Mostrar más";
export const SHOW_ARCHIVED_LABEL = "Ver archivados";
export const HIDDEN_ARCHIVED_HINT = "Archivado — oculto en la lista";
export const RENAME_PROMPT = "Nuevo título";
export const AUTOTITLE_PENDING_HINT =
  "El título se asigna al terminar el primer turn";

export type ChatOrgFields = {
  id: string;
  title: string;
  titleSource?: TitleSource | string | null;
  pinnedAt?: Date | string | null;
  archivedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  sessionId?: string;
};

export function isPlaceholderTitle(title: string, chatId: string): boolean {
  const t = (title || "").trim();
  if (!t) return true;
  if (t === DEFAULT_CHAT_TITLE) return true;
  if (t === chatId) return true;
  if (t === chatId.slice(0, 8) || t === `${chatId.slice(0, 8)}…`) return true;
  return false;
}

export function shouldAutotitle(chat: {
  id: string;
  title: string;
  titleSource?: string | null;
}): boolean {
  const source = chat.titleSource || DEFAULT_TITLE_SOURCE;
  if (source === "user" || source === "auto") return false;
  return source === "default" || isPlaceholderTitle(chat.title, chat.id);
}

export function autotitleFromPrompt(prompt: string): string {
  const firstLine = (prompt || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return DEFAULT_CHAT_TITLE;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= AUTOTITLE_MAX_CHARS) return collapsed;
  const sliced = collapsed.slice(0, AUTOTITLE_MAX_CHARS);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace >= 24 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:]+$/, "")}…`;
}

export function normalizeTitleInput(raw: string): {
  ok: true;
  title: string;
} | { ok: false; error: string } {
  const title = (raw || "").replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, error: TITLE_REQUIRED };
  if (title.length > TITLE_MAX_CHARS) return { ok: false, error: TITLE_TOO_LONG };
  return { ok: true, title };
}

export function normalizeSearchQuery(raw: string): {
  ok: true;
  query: string;
} | { ok: false; error: string } {
  const query = (raw || "").trim();
  if (query.length < SEARCH_MIN_CHARS) {
    return { ok: false, error: QUERY_TOO_SHORT };
  }
  return { ok: true, query };
}

export function escapeIlike(query: string): string {
  return query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function ilikePattern(query: string): string {
  return `%${escapeIlike(query)}%`;
}

export function isSearchableMessage(
  role: string,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (role === "tool") return false;
  if (role !== "user" && role !== "assistant") return false;
  const meta = metadata || {};
  if (meta.kind === "slash_result") return false;
  if (meta.secret === true) return false;
  if (meta.vault === true) return false;
  return true;
}

export function messageMatchesQuery(
  role: string,
  content: string,
  query: string,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (!isSearchableMessage(role, metadata)) return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (content || "").toLowerCase().includes(q);
}

export function chatMatchesQuery(
  chat: { title: string },
  messages: Array<{
    role: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  }>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if ((chat.title || "").toLowerCase().includes(q)) return true;
  return messages.some((m) =>
    messageMatchesQuery(m.role, m.content, query, m.metadata),
  );
}

function ts(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const n = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
}

export function compareChatsForList(a: ChatOrgFields, b: ChatOrgFields): number {
  const ap = a.pinnedAt ? 1 : 0;
  const bp = b.pinnedAt ? 1 : 0;
  if (ap !== bp) return bp - ap;
  if (ap && bp) {
    const pd = ts(b.pinnedAt) - ts(a.pinnedAt);
    if (pd) return pd;
  }
  return ts(b.updatedAt) - ts(a.updatedAt);
}

export function visibleChats<T extends ChatOrgFields>(
  chats: T[],
  opts: { includeArchived?: boolean; archivedOnly?: boolean } = {},
): T[] {
  let rows = chats;
  if (opts.archivedOnly) {
    rows = rows.filter((c) => Boolean(c.archivedAt));
  } else if (!opts.includeArchived) {
    rows = rows.filter((c) => !c.archivedAt);
  }
  return [...rows].sort(compareChatsForList);
}

export function windowSlice<T>(
  items: T[],
  offset: number,
  limit: number,
): { items: T[]; offset: number; hasMore: boolean; total: number } {
  const off = Math.max(0, offset | 0);
  const lim = Math.max(1, limit | 0);
  return {
    items: items.slice(off, off + lim),
    offset: off,
    hasMore: off + lim < items.length,
    total: items.length,
  };
}

export function displayChatTitle(chat: {
  id: string;
  title?: string | null;
}): string {
  const t = (chat.title || "").trim();
  return t || chat.id.slice(0, 8);
}
```

- [ ] Crear `cli/src/chats/org.test.ts` con al menos:

```ts
import { describe, expect, test } from "bun:test";
import {
  AUTOTITLE_MAX_CHARS,
  autotitleFromPrompt,
  chatMatchesQuery,
  compareChatsForList,
  DEFAULT_CHAT_TITLE,
  displayChatTitle,
  escapeIlike,
  ilikePattern,
  isPlaceholderTitle,
  isSearchableMessage,
  messageMatchesQuery,
  normalizeSearchQuery,
  normalizeTitleInput,
  shouldAutotitle,
  TITLE_MAX_CHARS,
  visibleChats,
  windowSlice,
} from "./org";

describe("autotitleFromPrompt", () => {
  test("first non-empty line, collapsed whitespace", () => {
    expect(autotitleFromPrompt("  Fix   auth   bug\nmore")).toBe("Fix auth bug");
  });
  test("empty → default", () => {
    expect(autotitleFromPrompt("  \n  ")).toBe(DEFAULT_CHAT_TITLE);
  });
  test("truncates at word boundary under AUTOTITLE_MAX_CHARS", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const title = autotitleFromPrompt(words);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(AUTOTITLE_MAX_CHARS + 1);
    expect(title.includes("word0")).toBe(true);
  });
});

describe("shouldAutotitle", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  test("default placeholder yes", () => {
    expect(shouldAutotitle({ id, title: "Chat", titleSource: "default" })).toBe(true);
  });
  test("title equals id yes if default", () => {
    expect(shouldAutotitle({ id, title: id, titleSource: "default" })).toBe(true);
  });
  test("user title never", () => {
    expect(shouldAutotitle({ id, title: "Chat", titleSource: "user" })).toBe(false);
  });
  test("already auto never", () => {
    expect(shouldAutotitle({ id, title: "Fix auth", titleSource: "auto" })).toBe(false);
  });
});

describe("isSearchableMessage", () => {
  test("user and assistant yes", () => {
    expect(isSearchableMessage("user", null)).toBe(true);
    expect(isSearchableMessage("assistant", {})).toBe(true);
  });
  test("tool never — includes secret tool outputs (plan 8)", () => {
    expect(isSearchableMessage("tool", { toolName: "Bash", output: "sk-ant-secret" })).toBe(false);
    expect(isSearchableMessage("tool", { secret: true, output: "***" })).toBe(false);
  });
  test("slash_result and secret flags skipped", () => {
    expect(isSearchableMessage("assistant", { kind: "slash_result" })).toBe(false);
    expect(isSearchableMessage("user", { secret: true })).toBe(false);
    expect(isSearchableMessage("assistant", { vault: true })).toBe(false);
  });
});

describe("messageMatchesQuery", () => {
  test("does not match tool output even if query hits content", () => {
    expect(
      messageMatchesQuery("tool", "API key sk-ant-abc", "sk-ant", {
        output: "sk-ant-abc",
      }),
    ).toBe(false);
  });
  test("matches assistant body", () => {
    expect(messageMatchesQuery("assistant", "Fixed the login form", "login", null)).toBe(true);
  });
});

describe("chatMatchesQuery", () => {
  test("title hit", () => {
    expect(chatMatchesQuery({ title: "Auth rewrite" }, [], "auth")).toBe(true);
  });
  test("tool-only hit does not count", () => {
    expect(
      chatMatchesQuery({ title: "Chat" }, [
        { role: "tool", content: "sk-ant-abc", metadata: { output: "sk-ant-abc" } },
      ], "sk-ant"),
    ).toBe(false);
  });
});

describe("visibleChats", () => {
  const chats = [
    { id: "1", title: "old", updatedAt: "2026-01-01T00:00:00Z", pinnedAt: null, archivedAt: null },
    { id: "2", title: "pinned", updatedAt: "2026-01-02T00:00:00Z", pinnedAt: "2026-01-03T00:00:00Z", archivedAt: null },
    { id: "3", title: "archived", updatedAt: "2026-01-04T00:00:00Z", pinnedAt: null, archivedAt: "2026-01-05T00:00:00Z" },
  ];
  test("pin rises; archived hidden", () => {
    expect(visibleChats(chats).map((c) => c.id)).toEqual(["2", "1"]);
  });
  test("archivedOnly", () => {
    expect(visibleChats(chats, { archivedOnly: true }).map((c) => c.id)).toEqual(["3"]);
  });
  test("includeArchived keeps pin first", () => {
    expect(visibleChats(chats, { includeArchived: true }).map((c) => c.id)).toEqual(["2", "3", "1"]);
  });
});

describe("windowSlice", () => {
  test("100 items window 20", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const page = windowSlice(items, 0, 20);
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(100);
    expect(windowSlice(items, 80, 20).hasMore).toBe(false);
  });
});

describe("normalize", () => {
  test("title and query bounds", () => {
    expect(normalizeTitleInput("  ").ok).toBe(false);
    expect(normalizeTitleInput("x".repeat(TITLE_MAX_CHARS + 1)).ok).toBe(false);
    expect(normalizeSearchQuery("a").ok).toBe(false);
    expect(normalizeSearchQuery("ab").ok).toBe(true);
  });
  test("ilike escape", () => {
    expect(escapeIlike("100%_id")).toBe("100\\%\\_id");
    expect(ilikePattern("ab")).toBe("%ab%");
  });
});

describe("displayChatTitle", () => {
  test("falls back to short id, never empty", () => {
    expect(displayChatTitle({ id: "abcdef12-xxxx", title: "" })).toBe("abcdef12");
    expect(displayChatTitle({ id: "abcdef12-xxxx", title: "Fix auth" })).toBe("Fix auth");
  });
});
```

- [ ] Copiar `org.ts` a `api/src/chats/org.ts` (cambiar el comentario keep-in-sync). Copiar el test a `api/src/chats/org.test.ts` ajustando el import a `./org`.

- [ ] Copiar a `web/src/lib/chat-org.ts` y `web/src/lib/chat-org.test.ts` (import `./chat-org`). Incluir **todas** las constantes y funciones: Web las usa en overview, search y labels.

- [ ] Correr:

```bash
cd cli && bun test src/chats/org.test.ts
cd api && bun test src/chats/org.test.ts
cd web && bun test src/lib/chat-org.test.ts
```

Los tres suites pasan. Cero I/O.

- [ ] Commit:

```bash
git add cli/src/chats/org.ts cli/src/chats/org.test.ts cli/package.json \
  api/src/chats/org.ts api/src/chats/org.test.ts api/package.json \
  web/src/lib/chat-org.ts web/src/lib/chat-org.test.ts web/package.json
git commit -m "feat(chats): autotitle, searchability and pin-sort helpers"
```

---

## Task 2: Schema — pin, archive, titleSource

**Files:**

- Modify: `api/src/db/schema.ts`
- Create: `api/drizzle/0001_chat_organization.sql` (si un sibling ya usó `0001_*.sql`, el siguiente número libre; el SQL es `ADD COLUMN IF NOT EXISTS`)

No hay tabla nueva. Search es `ILIKE` sobre `chats.title` + `chat_messages.content` filtrado. Sin `tsvector`.

- [ ] En `api/src/db/schema.ts`, ampliar `chats` **añadiendo** columnas; no borrar `id` / `sessionId` / `userId` / `title` / timestamps:

```ts
export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Chat"),
    titleSource: text("title_source").notNull().default("default"),
    pinnedAt: timestamp("pinned_at"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chats_user_session_updated_idx").on(
      table.userId,
      table.sessionId,
      table.updatedAt,
    ),
  ],
);
```

Si Drizzle se queja porque `uniqueIndex` no es el helper correcto para un índice no-único, usar `index("chats_user_session_updated_idx").on(...)` importando `index` de `drizzle-orm/pg-core`. El índice es de lista, no unique.

Añadir también (mismo archivo, imports `index` si hace falta):

```ts
index("chats_user_archived_pinned_idx").on(
  table.userId,
  table.archivedAt,
  table.pinnedAt,
),
```

sobre la misma tabla. `chat_messages` no cambia (jsonb `metadata` ya existe).

- [ ] Crear `api/drizzle/0001_chat_organization.sql` (o el siguiente número libre):

```sql
ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "title_source" text NOT NULL DEFAULT 'default';
ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "pinned_at" timestamp;
ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp;

CREATE INDEX IF NOT EXISTS "chats_user_session_updated_idx"
  ON "chats" ("user_id", "session_id", "updated_at");
CREATE INDEX IF NOT EXISTS "chats_user_archived_pinned_idx"
  ON "chats" ("user_id", "archived_at", "pinned_at");
CREATE INDEX IF NOT EXISTS "chat_messages_chat_role_idx"
  ON "chat_messages" ("chat_id", "role");
```

Filas existentes: `title_source = 'default'`. El primer turn posterior autotitula si el título sigue siendo placeholder.

- [ ] Aplicar el schema (dev usa push):

```bash
cd api && bun run db:push
```

Si el entorno de CI usa migrate, `bun run db:migrate` debe aplicar el SQL de `IF NOT EXISTS` sin fallar al re-ejecutar.

- [ ] Commit:

```bash
git add api/src/db/schema.ts api/drizzle/0001_chat_organization.sql
git commit -m "feat(chats): persist pin, archive and titleSource"
```

---

## Task 3: Persistencia compartida + HTTP (PATCH, search, overview paginado)

**Files:**

- Create: `api/src/chats/store.ts`
- Test: `api/src/chats/store.test.ts`
- Create: `api/src/routes/chats.ts`
- Modify: `api/src/routes/workspaces.ts`
- Modify: `api/src/index.ts`
- Modify: `api/openapi/openapi.yaml`

Cierra: overview con 100 chats no carga todos los mensajes; search HTTP; pin/archive/rename/move sin daemon.

- [ ] Crear `api/src/chats/store.ts` con helpers que HTTP y WS reutilizan. Firma mínima:

```ts
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, chatMessages, chats, workspaces } from "../db/schema";
import {
  CHATS_PER_SESSION_WINDOW,
  CHAT_NOT_FOUND,
  CROSS_WORKSPACE_MOVE,
  CROSS_WORKSPACE_SESSION,
  DEFAULT_CHAT_TITLE,
  DEFAULT_TITLE_SOURCE,
  SEARCH_LIMIT,
  SESSION_NOT_FOUND,
  SESSIONS_PAGE_SIZE,
  autotitleFromPrompt,
  ilikePattern,
  normalizeSearchQuery,
  normalizeTitleInput,
  shouldAutotitle,
  type TitleSource,
} from "./org";

export const chatListOrder = [
  sql`${chats.pinnedAt} IS NOT NULL DESC`,
  desc(chats.pinnedAt),
  desc(chats.updatedAt),
];

export function archivedClause(opts: {
  includeArchived?: boolean;
  archivedOnly?: boolean;
}) {
  if (opts.archivedOnly) return isNotNull(chats.archivedAt);
  if (opts.includeArchived) return undefined;
  return isNull(chats.archivedAt);
}

export async function loadOwnedChat(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadOwnedSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function assertSessionInWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string | null,
): Promise<{ ok: true; session: typeof agentSessions.$inferSelect } | { ok: false; error: string }> {
  const session = await loadOwnedSession(sessionId, userId);
  if (!session) return { ok: false, error: SESSION_NOT_FOUND };
  if (workspaceId && session.workspaceId !== workspaceId) {
    return { ok: false, error: CROSS_WORKSPACE_SESSION };
  }
  return { ok: true, session };
}

export type ChatPatch = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  sessionId?: string;
};

export async function patchChat(
  chatId: string,
  userId: string,
  patch: ChatPatch,
): Promise<{ ok: true; chat: typeof chats.$inferSelect } | { ok: false; error: string }> {
  const current = await loadOwnedChat(chatId, userId);
  if (!current) return { ok: false, error: CHAT_NOT_FOUND };

  const now = new Date();
  const next: Partial<typeof chats.$inferInsert> & { updatedAt: Date } = {
    updatedAt: now,
  };

  if (patch.title !== undefined) {
    const n = normalizeTitleInput(patch.title);
    if (!n.ok) return n;
    next.title = n.title;
    next.titleSource = "user";
  }
  if (patch.pinned === true) next.pinnedAt = current.pinnedAt ?? now;
  if (patch.pinned === false) next.pinnedAt = null;
  if (patch.archived === true) next.archivedAt = current.archivedAt ?? now;
  if (patch.archived === false) next.archivedAt = null;

  if (patch.sessionId && patch.sessionId !== current.sessionId) {
    const from = await loadOwnedSession(current.sessionId, userId);
    const to = await loadOwnedSession(patch.sessionId, userId);
    if (!from || !to) return { ok: false, error: SESSION_NOT_FOUND };
    if (from.workspaceId !== to.workspaceId) {
      return { ok: false, error: CROSS_WORKSPACE_MOVE };
    }
    next.sessionId = patch.sessionId;
  }

  const rows = await db
    .update(chats)
    .set(next)
    .where(eq(chats.id, chatId))
    .returning();
  return { ok: true, chat: rows[0] };
}

export async function maybeAutotitleAfterFirstAssistant(input: {
  chatId: string;
  userId: string;
}): Promise<typeof chats.$inferSelect | null> {
  const chat = await loadOwnedChat(input.chatId, input.userId);
  if (!chat || !shouldAutotitle(chat)) return null;

  const assistantCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(
      and(eq(chatMessages.chatId, input.chatId), eq(chatMessages.role, "assistant")),
    );
  if (Number(assistantCount[0]?.n ?? 0) !== 1) return null;

  const users = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.chatId, input.chatId), eq(chatMessages.role, "user")))
    .orderBy(asc(chatMessages.createdAt))
    .limit(1);
  const prompt = users[0]?.content || "";
  const title = autotitleFromPrompt(prompt);
  if (!title || title === DEFAULT_CHAT_TITLE) return null;

  const rows = await db
    .update(chats)
    .set({
      title,
      titleSource: "auto" satisfies TitleSource,
      updatedAt: new Date(),
    })
    .where(eq(chats.id, input.chatId))
    .returning();
  return rows[0] ?? null;
}

const SEARCHABLE_ROLES = ["user", "assistant"] as const;

export async function searchChats(input: {
  userId: string;
  query: string;
  workspaceId?: string;
  sessionId?: string;
  includeArchived?: boolean;
  limit?: number;
}) {
  const q = normalizeSearchQuery(input.query);
  if (!q.ok) return q;
  const limit = Math.min(Math.max(input.limit ?? SEARCH_LIMIT, 1), SEARCH_LIMIT);

  const pattern = ilikePattern(q.query);
  const titleHit = ilike(chats.title, pattern);
  const msgHit = and(
    inArray(chatMessages.role, [...SEARCHABLE_ROLES]),
    ilike(chatMessages.content, pattern),
    sql`coalesce(${chatMessages.metadata}->>'kind','') <> 'slash_result'`,
    sql`coalesce(${chatMessages.metadata}->>'secret','') <> 'true'`,
    sql`coalesce(${chatMessages.metadata}->>'vault','') <> 'true'`,
  );

  const filters = [eq(chats.userId, input.userId)];
  const arch = archivedClause({ includeArchived: input.includeArchived });
  if (arch) filters.push(arch);
  if (input.sessionId) filters.push(eq(chats.sessionId, input.sessionId));

  if (input.workspaceId) {
    filters.push(eq(agentSessions.workspaceId, input.workspaceId));
  }

  const rows = await db
    .selectDistinctOn([chats.id], {
      chat: chats,
      sessionTitle: agentSessions.title,
      workspaceId: agentSessions.workspaceId,
      workspaceName: workspaces.name,
      workspacePath: workspaces.path,
    })
    .from(chats)
    .innerJoin(agentSessions, eq(chats.sessionId, agentSessions.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .leftJoin(
      chatMessages,
      and(eq(chatMessages.chatId, chats.id), msgHit),
    )
    .where(
      and(
        ...filters,
        or(titleHit, sql`${chatMessages.id} IS NOT NULL`),
      ),
    )
    .orderBy(chats.id, ...chatListOrder)
    .limit(limit);

  // distinctOn([id]) no garantiza el orden de lista; reordenar en memoria
  const chatsOut = rows.map((r) => ({
    ...r.chat,
    sessionTitle: r.sessionTitle,
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    workspacePath: r.workspacePath,
  }));
  chatsOut.sort((a, b) => {
    const ap = a.pinnedAt ? 1 : 0;
    const bp = b.pinnedAt ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const pu = (b.pinnedAt?.getTime() ?? 0) - (a.pinnedAt?.getTime() ?? 0);
    if (pu) return pu;
    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
  });
  return { ok: true as const, query: q.query, chats: chatsOut.slice(0, limit) };
}
```

Si `selectDistinctOn` + `leftJoin` filtrado resulta frágil en Drizzle, partir en dos queries: (1) `chats` cuyo `title ILIKE`, (2) `chat_messages` searchable cuyo `content ILIKE` → `inArray(chats.id, ids)` y merge + sort. **Prohibido** hacer `ILIKE` sobre `role = 'tool'` o sobre `metadata->>'output'`.

- [ ] Test `api/src/chats/store.test.ts` de la lógica que no necesita Postgres: re-exportar y cubrir que `archivedClause({ archivedOnly: true })` no es `isNull`, y un test de `shouldAutotitle` + `autotitleFromPrompt` importados (el SQL se cubre en el smoke de Task 8). Añadir un test puro del predicado SQL documentado:

```ts
test("search never includes tool role in SEARCHABLE_ROLES", () => {
  expect(["user", "assistant"]).not.toContain("tool");
});
```

- [ ] Extraer de `api/src/routes/workspaces.ts` el overview a un helper `listWorkspaceOverview` en `api/src/chats/store.ts` (o `api/src/chats/overview.ts` si `store.ts` crece):

  1. Sessions del workspace: `orderBy desc(updatedAt)`, `limit = SESSIONS_PAGE_SIZE` (query `sessionsLimit`, default 50), `offset` query `sessionsOffset`.
  2. Devolver `sessionCount` total y `hasMoreSessions`.
  3. Chats por session: `archivedAt IS NULL`, `chatListOrder`, **ventana** `chatsLimit` (default `CHATS_PER_SESSION_WINDOW`, máx 20) — **no** todos.
  4. Cada session incluye `chatCount` (no archivados) y `hasMoreChats`.
  5. `recentMessages`: **solo** para los chats de la ventana, con `row_number() OVER (PARTITION BY chat_id ORDER BY created_at DESC) <= 3`. **Prohibido** el `select()` de todos los mensajes del workspace que hay hoy.

Sustituir el bloque actual que hace `from(chatMessages).where(inArray(chatIds))` sin límite.

Query params de `GET /workspaces/:workspaceId/sessions`:

| Param | Default | Semántica |
|---|---|---|
| `sessionsLimit` | `50` | cap `SESSIONS_PAGE_SIZE` |
| `sessionsOffset` | `0` | |
| `chatsLimit` | `20` | cap `CHATS_PER_SESSION_WINDOW` |
| `includeArchived` | `false` | si `1`/`true`, incluye archivados |

- [ ] `GET /sessions/:sessionId/chats` acepta `limit` (default 50, cap 100), `offset`, `includeArchived`, `archivedOnly`. Orden `chatListOrder`. Respuesta `{ sessionId, chats, total, offset, hasMore }`.

- [ ] Crear `api/src/routes/chats.ts` montado **antes** de `GET /chats/:chatId` para que `search` no se capture como id.

```ts
import { Hono } from "hono";
import type { Session } from "../auth";
import { hub } from "../ws/hub";
import { CHAT_UPDATED_EVENT, SEARCH_LIMIT } from "../chats/org";
import { loadOwnedChat, patchChat, searchChats } from "../chats/store";

export function createChatOrgRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>,
) {
  const app = new Hono();

  app.get("/chats/search", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const q = c.req.query("q") || "";
    const res = await searchChats({
      userId: session.user.id,
      query: q,
      workspaceId: c.req.query("workspaceId") || undefined,
      sessionId: c.req.query("sessionId") || undefined,
      includeArchived: c.req.query("includeArchived") === "1",
      limit: Number(c.req.query("limit") || SEARCH_LIMIT),
    });
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json(res);
  });

  app.patch("/chats/:chatId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const chatId = c.req.param("chatId");
    const body = await c.req.json().catch(() => ({})) as {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      sessionId?: string;
    };
    const res = await patchChat(chatId, session.user.id, body);
    if (!res.ok) {
      const status =
        res.error === "Chat not found" || res.error === "Session not found"
          ? 404
          : 400;
      return c.json({ error: res.error }, status);
    }
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent(CHAT_UPDATED_EVENT, { chat: res.chat }),
    );
    return c.json({ chat: res.chat });
  });

  return app;
}
```

Montar en `api/src/index.ts`:

```ts
import { createChatOrgRoutes } from "./routes/chats";
// ...
app.route("/", createChatOrgRoutes(requireSession));
app.route("/", createSessionChatRoutes(requireSession));
```

`createChatOrgRoutes` **antes** de `createSessionChatRoutes`. CORS `/chats/*` ya cubre PATCH y `/chats/search`.

- [ ] Extender `GET /chats/:chatId` para devolver las columnas nuevas (`titleSource`, `pinnedAt`, `archivedAt`) — el `select()` de Drizzle ya las trae tras Task 2; no hace falta query extra. Documentarlas en OpenAPI.

- [ ] En `api/openapi/openapi.yaml`:

  - Schema `Chat`: añadir `titleSource` (`default|auto|user`), `pinnedAt`, `archivedAt` (date-time nullable).
  - Path `GET /chats/search` (query `q` required, `workspaceId`, `sessionId`, `includeArchived`, `limit`) → `{ query, chats: Chat[] }`.
  - Path `PATCH /chats/{chatId}` body `{ title?, pinned?, archived?, sessionId? }` → `{ chat }`. 404/400.
  - `GET /workspaces/{workspaceId}/sessions` params de paginación; schema de session anidada con `chats`, `chatCount`, `hasMoreChats`, `recentMessages`.
  - `GET /sessions/{sessionId}/chats` params `limit`/`offset`/`includeArchived`/`archivedOnly`.

- [ ] Correr:

```bash
cd api && bun test src/chats/org.test.ts src/chats/store.test.ts
```

- [ ] Commit:

```bash
git add api/src/chats/store.ts api/src/chats/store.test.ts \
  api/src/routes/chats.ts api/src/routes/workspaces.ts api/src/index.ts \
  api/openapi/openapi.yaml
git commit -m "feat(chats): HTTP search, patch, and paginated workspace overview"
```

---

## Task 4: WebSocket — update, search, autotítulo, create respeta workspace

**Files:**

- Modify: `api/src/ws/protocol.ts`
- Modify: `api/src/ws/handlers.ts`
- Modify: `cli/src/ws/client.ts`
- Modify: `web/src/lib/ws-client.ts`
- Modify: `web/src/lib/ws-context.tsx`
- Modify: `api/openapi/openapi.yaml`

El daemon **no** calcula el título: la API lo hace en `chat.stream.end` para que Web (turn disparado desde el hub) y TUI (turn local) compartan el mismo path.

- [ ] En `api/src/ws/protocol.ts`, `cli/src/ws/client.ts` y `web/src/lib/ws-client.ts`, ampliar `ClientMessage` / `WsRequest` con campos opcionales (no romper los existentes):

```ts
query?: string;
includeArchived?: boolean;
archivedOnly?: boolean;
pinned?: boolean;
archived?: boolean;
limit?: number;
offset?: number;
```

Mismo shape en `web/src/lib/ws-context.tsx` `request(partial)`.

- [ ] En `api/src/ws/handlers.ts`:

**`session.create` / `chat.create`:** seguir usando `DEFAULT_SESSION_TITLE` / `DEFAULT_CHAT_TITLE` del módulo org cuando `msg.title` viene vacío. En `chat.create` persistir `titleSource: "default"` si el título es placeholder; `"user"` si el cliente mandó un título no-placeholder (`!isPlaceholderTitle(title, id)` — el id ya está generado).

**`chat.create` workspace check:**

```ts
case "chat.create": {
  if (!msg.sessionId) return fail(type, id, "sessionId is required");
  const boundId = hub.get(connectionId)?.workspaceId ?? null;
  const checked = await assertSessionInWorkspace(
    msg.sessionId,
    userId,
    boundId,
  );
  if (!checked.ok) return fail(type, id, checked.error);
  // insert con titleSource como arriba
  broadcast(userId, "chat.created", { chat: row }); // incluir al emisor: quitar except
  return ok(type, id, { chat: row });
}
```

Si el socket **no** está bound (`boundId === null`), `assertSessionInWorkspace` solo verifica ownership (HTTP-like). Si **está** bound, la session **debe** ser de ese workspace (`CROSS_WORKSPACE_SESSION`).

Cambiar `broadcast(..., except: connectionId)` de `session.created` / `chat.created` para **no** excluir al emisor, o dejar except y que el cliente use `res.data` (hoy TUI ya usa `res.data`). Pin sync (escenario Gherkin) necesita que el **otro** cliente reciba el push: `chat.updated` **sin** `except`.

**`chat.list`:**

```ts
case "chat.list": {
  if (!msg.sessionId) return fail(type, id, "sessionId is required");
  const owned = await loadOwnedSession(msg.sessionId, userId);
  if (!owned) return fail(type, id, SESSION_NOT_FOUND);
  const arch = archivedClause({
    includeArchived: msg.includeArchived,
    archivedOnly: msg.archivedOnly,
  });
  const rows = await db
    .select()
    .from(chats)
    .where(
      and(
        eq(chats.sessionId, msg.sessionId),
        eq(chats.userId, userId),
        ...(arch ? [arch] : []),
      ),
    )
    .orderBy(...chatListOrder);
  return ok(type, id, { chats: rows });
}
```

**`chat.update`** (un solo RPC para rename/pin/archive/move):

```ts
case "chat.update": {
  if (!msg.chatId) return fail(type, id, "chatId is required");
  const res = await patchChat(msg.chatId, userId, {
    title: msg.title,
    pinned: msg.pinned,
    archived: msg.archived,
    sessionId: msg.sessionId,
  });
  if (!res.ok) return fail(type, id, res.error);
  broadcast(userId, CHAT_UPDATED_EVENT, { chat: res.chat }); // sin except
  return ok(type, id, { chat: res.chat });
}
```

**`chat.search`:**

```ts
case "chat.search": {
  const boundId = hub.get(connectionId)?.workspaceId ?? null;
  const res = await searchChats({
    userId,
    query: msg.query || msg.content || "",
    workspaceId: boundId || undefined,
    sessionId: msg.sessionId,
    includeArchived: msg.includeArchived,
    limit: msg.limit,
  });
  if (!res.ok) return fail(type, id, res.error);
  return ok(type, id, res);
}
```

TUI bound busca **en el workspace abierto**, no en todos. Web overview usa HTTP (puede pasar `workspaceId`). CLI headless bound se comporta como TUI.

**`chat.stream.end`:** después de insertar el assistant (el bloque que ya existe), llamar:

```ts
const titled = await maybeAutotitleAfterFirstAssistant({
  chatId: msg.chatId,
  userId,
});
if (titled) {
  broadcast(userId, CHAT_UPDATED_EVENT, { chat: titled });
}
```

Si el stream no persiste assistant (content vacío), no autotitular. Un `chat.stream.error` no toca el título.

Reusar `loadOwnedChat` de `store.ts` en vez de la función local si queda duplicada; no dejar dos `loadChatForUser` divergentes.

- [ ] OpenAPI: descripción de `/ws` añadir tipos `chat.update`, `chat.search`. Schemas `WsClientChatUpdate` y `WsClientChatSearch`. Push `chat.updated`. Lista de tipos implementados en el `description` del upgrade.

- [ ] `web/src/lib/ws-context.tsx`: en el `onPush` global, invalidar queries cuando `msg.type === "chat.updated"` (mismos keys que `chat.created`: `workspaceSessions`, `sessionChats`, `chat`).

- [ ] Correr tests de org otra vez (handlers no tienen unit test de DB; el smoke de Task 8 cubre el RPC).

- [ ] Commit:

```bash
git add api/src/ws/protocol.ts api/src/ws/handlers.ts \
  cli/src/ws/client.ts web/src/lib/ws-client.ts web/src/lib/ws-context.tsx \
  api/openapi/openapi.yaml
git commit -m "feat(chats): WS update, search, autotitle and workspace-scoped create"
```

---

## Task 5: CLI headless — list filters, pin, archive, search, rename, move

**Files:**

- Modify: `cli/src/commands/headless.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/src/commands/headless-chat-org.test.ts`

Sin TTY. JSON stdout. Flags, no prompts.

- [ ] Extender usage en `cli/src/index.ts`:

```
chavez headless chat create|list|append|get|ask|watch|search|pin|unpin|archive|unarchive|rename|move
```

y el `throw new Error("Uso: …")` de `headless.ts`.

- [ ] Parser de flags al final de `rest` (no dependencias nuevas):

```ts
function takeFlags(args: string[]): { rest: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--archived") flags.archivedOnly = true;
    else if (a === "--include-archived") flags.includeArchived = true;
    else if (a === "--json" || a === "--help") flags[a.slice(2)] = true;
    else rest.push(a);
  }
  return { rest, flags };
}
```

- [ ] Acciones nuevas en el bloque `group === "chat"` (mismo `ensureClient()` / `finally` close, excepto `watch`):

| Acción | Uso | RPC / HTTP |
|---|---|---|
| `list` | `chat list <sessionId> [--archived \| --include-archived]` | `chat.list` con flags |
| `search` | `chat search <query…>` (workspace bound) | `chat.search` `{ query }` |
| `pin` | `chat pin <chatId>` | `chat.update` `{ chatId, pinned: true }` |
| `unpin` | `chat unpin <chatId>` | `chat.update` `{ chatId, pinned: false }` |
| `archive` | `chat archive <chatId>` | `chat.update` `{ chatId, archived: true }` |
| `unarchive` | `chat unarchive <chatId>` | `chat.update` `{ chatId, archived: false }` |
| `rename` | `chat rename <chatId> <title…>` | `chat.update` `{ chatId, title }` |
| `move` | `chat move <chatId> <sessionId>` | `chat.update` `{ chatId, sessionId }` |

`list` sin flags **omite** archivados. `--archived` = `archivedOnly: true`. `--include-archived` = todos, pin sigue primero.

Stdout: `JSON.stringify(res.data, null, 2)` como el resto de headless. Errores: `throw new Error(res.error)` (exit 1 vía `index.ts`).

- [ ] Test `cli/src/commands/headless-chat-org.test.ts` del parser y del mapa de acciones (extraer `takeFlags` y `chatOrgAction` a `cli/src/commands/chat-org-args.ts` si hace falta para testear sin WS):

```ts
test("list flags", () => {
  expect(takeFlags(["sid", "--archived"]).flags.archivedOnly).toBe(true);
  expect(takeFlags(["sid", "--include-archived"]).flags.includeArchived).toBe(true);
  expect(takeFlags(["sid"]).flags.archivedOnly).toBeUndefined();
});
```

```bash
cd cli && bun test src/chats/org.test.ts src/commands/headless-chat-org.test.ts
```

- [ ] Commit:

```bash
git add cli/src/commands/headless.ts cli/src/index.ts \
  cli/src/commands/headless-chat-org.test.ts cli/src/commands/chat-org-args.ts
git commit -m "feat(cli): chat pin, archive, search, rename and list filters"
```

---

## Task 6: TUI — autotítulo visible, pin, archive, rename, search, sync

**Files:**

- Modify: `tui/src/App.tsx`
- Modify: `tui/package.json` (añadir `"test": "bun test"` si falta; TUI no necesita test de render)

TUI importa `cli/src/chats/org.ts`. No duplicar constantes.

- [ ] Ampliar tipos locales:

```ts
import {
  ARCHIVE_LABEL,
  AUTOTITLE_PENDING_HINT,
  CHAT_UPDATED_EVENT,
  DEFAULT_CHAT_TITLE,
  NO_SEARCH_MATCHES,
  SEARCH_PLACEHOLDER,
  SHOW_ARCHIVED_LABEL,
  UNARCHIVE_LABEL,
  compareChatsForList,
  displayChatTitle,
  visibleChats,
  type ChatOrgFields,
} from "../../cli/src/chats/org";

type Chat = ChatOrgFields & { sessionId: string };
```

`Session` se queda `{ id, title }` (sessions no se pinean en esta fase).

- [ ] Crear chat con `title: DEFAULT_CHAT_TITLE` (quitar `` `Chat ${new Date().toLocaleTimeString()}` ``). Si no, `titleSource` cae en `"user"` y el autotítulo **no** corre.

- [ ] Estado nuevo:

```ts
const [showArchived, setShowArchived] = useState(false);
const [findMode, setFindMode] = useState(false);
const [findQuery, setFindQuery] = useState("");
const [findHits, setFindHits] = useState<Chat[]>([]);
const [renameMode, setRenameMode] = useState(false);
```

`refreshChats` pasa `includeArchived: showArchived` al `chat.list`. Tras recibir rows, `setChats(visibleChats(rows, { includeArchived: showArchived }))` (defensivo; el server ya ordena).

Lista pintada: `displayChatTitle(c)` + prefijo `*` si `pinnedAt`, + `(archivado)` si `archivedAt`. El id corto se queda en dim (`id.slice(0, 8)`), **no** como título.

Si el chat activo tiene `titleSource === "default"` y sin mensajes assistant, log/hint `AUTOTITLE_PENDING_HINT`.

- [ ] `onPush`:

```ts
if (msg.type === CHAT_UPDATED_EVENT) {
  const chat = (msg.data as { chat?: Chat })?.chat;
  if (!chat) return;
  if (chat.sessionId === activeSessionIdRef.current) {
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== chat.id);
      if (!showArchived && chat.archivedAt) return visibleChats(next);
      return visibleChats([...next, chat], { includeArchived: showArchived });
    });
  }
  if (chat.id === activeChatIdRef.current) {
    setLog(`Chat: ${displayChatTitle(chat)}`);
  }
}
```

Esto cierra el escenario **Sync**: pin en Web → TUI ve `*` y el chat sube.

También invalidar `refreshChats` si el `sessionId` del chat actual cambió (move).

- [ ] Teclas en **command** mode (no compose; `busy` no bloquea nav; sí bloquea mutaciones como hoy):

| Tecla | Acción |
|---|---|
| `*` | `chat.update` `{ pinned: !chat.pinnedAt }` del chat enfocado (o activo si focus chats) |
| `x` | archive/unarchive el chat enfocado |
| `r` | entra `renameMode` (input título, Enter envía `chat.update` `{ title }`, Esc cancela) |
| `f` | entra `findMode` (input query, debounce no hace falta: Enter dispara `chat.search`) |
| `v` | toggle `showArchived` y `refreshChats` |

No usar `p` (ya es provider) ni `/` (plan 11 slash en compose).

Find: `client.request({ type: "chat.search", query: findQuery })`. Lista temporal `findHits`; Enter sobre un hit llama `selectChat` (si `sessionId` distinto, `selectSession` primero). Query `< 2` chars → log `QUERY_TOO_SHORT`. Cero hits → `NO_SEARCH_MATCHES`. `Esc` sale de find/rename.

Rename: `normalizeTitleInput` en cliente para no mandar vacío; el server revalida.

- [ ] Help line:

```
[Tab] listas  [↑↓]  [Enter] abrir  [s][c][m]  [*] pin  [x] archivar  [r] título  [f] buscar  [v] archivados  [q]
```

- [ ] Commit:

```bash
git add tui/src/App.tsx tui/package.json
git commit -m "feat(tui): pin, archive, rename, search and live chat.updated"
```

---

## Task 7: Web — título editable, pin/archivo, search, ventana de 100 chats

**Files:**

- Modify: `web/src/lib/hooks.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/lib/ws-hooks.ts`
- Create: `web/src/components/ChatOrgBar.tsx`
- Test: `web/src/components/ChatOrgBar.test.ts` (helpers de labels; si no hay runtime DOM, testear solo imports de `chat-org`)
- Modify: `web/src/components/ChatDetailPanel.tsx`
- Modify: `web/src/components/SessionDetailPanel.tsx`
- Modify: `web/src/components/WorkspaceDetailPanel.tsx`
- Modify: `web/src/components/HubPanel.tsx`
- Create: `web/src/pages/chats/search.astro` (opcional si el search vive en workspace; **sí** crear la página para deep-link `/chats/search?q=`)
- Create: `web/src/components/ChatSearchPanel.tsx`
- Modify: `web/src/layouts/BaseLayout.astro`
- Modify: `web/src/styles/global.css`

Web usa HTTP para search/overview (funciona sin daemon) y WS `chat.update` cuando el socket está `open`; si WS no está open, fallback `PATCH /chats/:id` (mismo `patchChat` + broadcast).

- [ ] Tipos en `web/src/lib/hooks.ts`:

```ts
export type Chat = {
  id: string;
  sessionId: string;
  userId?: string;
  title: string;
  titleSource?: "default" | "auto" | "user";
  pinnedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  recentMessages?: ChatMessage[];
  sessionTitle?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
};

export type WorkspaceSessionOverview = AgentSession & {
  chats: Chat[];
  chatCount?: number;
  hasMoreChats?: boolean;
};
```

- [ ] `queryKeys.chatSearch = (q: string, workspaceId?: string) => ["chatSearch", q, workspaceId ?? ""]`

- [ ] Hooks:

```ts
export function useChatSearch(
  q: string,
  opts: { workspaceId?: string; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.chatSearch(q, opts.workspaceId),
    enabled: (opts.enabled ?? true) && q.trim().length >= 2,
    queryFn: () =>
      apiJson<{ query: string; chats: Chat[] }>(
        `/chats/search?q=${encodeURIComponent(q)}` +
          (opts.workspaceId
            ? `&workspaceId=${encodeURIComponent(opts.workspaceId)}`
            : ""),
      ),
  });
}

export function usePatchChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      sessionId?: string;
    }) =>
      apiJson<{ chat: Chat }>(`/chats/${input.chatId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: input.title,
          pinned: input.pinned,
          archived: input.archived,
          sessionId: input.sessionId,
        }),
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chat(input.chatId) });
      void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
      void qc.invalidateQueries({ queryKey: ["sessionChats"] });
      void qc.invalidateQueries({ queryKey: ["chatSearch"] });
    },
  });
}
```

- [ ] `useWsChatUpdate` en `web/src/lib/ws-hooks.ts`:

```ts
export function useWsChatUpdate() {
  const ws = useWs();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      sessionId?: string;
    }) => ws.request({ type: "chat.update", ...input }),
  });
}
```

`ChatOrgBar` prefiere WS si `ws.status === "open"`, si no PATCH.

- [ ] `web/src/components/ChatOrgBar.tsx` — barra reutilizable (detalle de chat y filas de lista):

  - Título: `<input>` o `<strong>` + botón “Editar”. Submit → `normalizeTitleInput` → update `{ title }`.
  - Botón pin: `PIN_LABEL` / `UNPIN_LABEL` según `pinnedAt`.
  - Botón archivo: `ARCHIVE_LABEL` / `UNARCHIVE_LABEL`.
  - Select “Mover a session” (solo en detalle, lista de sessions del mismo workspace).
  - Si `titleSource === "default"`: hint `AUTOTITLE_PENDING_HINT`.

No pedir daemon. Disabled solo mientras la mutation está pending.

- [ ] `ChatDetailPanel.tsx`:

  - Breadcrumb: `displayChatTitle(chat)` en vez de `chatId.slice(0, 8)`.
  - Sustituir `<strong>{chat.data.chat.title}</strong>` por `<ChatOrgBar chat={...} sessions={...} />`.
  - Invalidar `queryKeys.chat(chatId)` en `chat.updated` (el `onPush` local ya invalida `message.appended`; añadir el tipo).

- [ ] `WorkspaceDetailPanel.tsx` — cierra “100 chats no explotan”:

  - Search box (`SEARCH_PLACEHOLDER`) con debounce `SEARCH_DEBOUNCE_MS` → `useChatSearch(q, { workspaceId })`. Hits debajo del input; click → `/chats/:id`. Vacío → `NO_SEARCH_MATCHES`.
  - Por session: pintar `s.chats` (ya vienen ≤ 20). Badge `chatCount`. Si `hasMoreChats`, botón `SHOW_MORE_CHATS` que pide `GET /sessions/:id/chats?offset={chats.length}&limit=20` y concatena (pin-sort: re-correr `visibleChats` del merge).
  - Cada fila de chat: `*` si pinned, link con `displayChatTitle`, botones pin/archivo compactos (reusar `ChatOrgBar` variant=`row`).
  - Toggle `SHOW_ARCHIVED_LABEL` recarga overview con `includeArchived=1`.
  - Crear chat sigue eligiendo session del **mismo** workspace (el `<select>` ya lista sessions del overview). Título placeholder vacío → server pone `"Chat"` + `titleSource=default`.

- [ ] `SessionDetailPanel.tsx`: misma lista pin-sort, toggle archivados, `ChatOrgBar` row, search acotado `sessionId` (query extra en `useChatSearch` o fetch `/chats/search?q=&sessionId=`).

- [ ] `ChatSearchPanel` + `web/src/pages/chats/search.astro`:

```astro
---
export const prerender = false;
import BaseLayout from "../../layouts/BaseLayout.astro";
import { ChatSearchPanel } from "../../components/ChatSearchPanel";
const q = Astro.url.searchParams.get("q") || "";
---
<BaseLayout title="Buscar chats">
  <ChatSearchPanel client:only="react" initialQuery={q} />
</BaseLayout>
```

Input + resultados (título, session, workspace path). Sin filesystem.

- [ ] `BaseLayout.astro`: link `Buscar` → `/chats/search` junto a Workspaces.

- [ ] `HubPanel.tsx`: el mismo input de search (navega a `/chats/search?q=`). No listar 100 chats en el hub.

- [ ] CSS mínimo en `web/src/styles/global.css`:

```css
.chat-org-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.chat-org-bar input[type="text"] { min-width: 12rem; }
.chat-pin { font-weight: 700; }
.chat-row.archived { opacity: 0.65; }
```

Sin framework nuevo.

- [ ] `useWorkspaceSessions` pasa query string si el panel pide `includeArchived` / offsets:

```ts
`/workspaces/${workspaceId}/sessions?chatsLimit=20&includeArchived=${includeArchived ? "1" : "0"}`
```

- [ ] Correr:

```bash
cd web && bun test src/lib/chat-org.test.ts
```

- [ ] Commit:

```bash
git add web/src/lib/hooks.ts web/src/lib/query-keys.ts web/src/lib/ws-hooks.ts \
  web/src/components/ChatOrgBar.tsx web/src/components/ChatDetailPanel.tsx \
  web/src/components/SessionDetailPanel.tsx web/src/components/WorkspaceDetailPanel.tsx \
  web/src/components/HubPanel.tsx web/src/components/ChatSearchPanel.tsx \
  web/src/pages/chats/search.astro web/src/layouts/BaseLayout.astro \
  web/src/styles/global.css
git commit -m "feat(web): editable titles, pin/archive, search and chat window"
```

---

## Task 8: Smoke de sync + autotítulo + search que no indexa tools

**Files:**

- Create: `cli/scripts/chat-org-smoke.ts`
- Modify: `cli/package.json` (script opcional `"test:chat-org": "bun run scripts/chat-org-smoke.ts"`)

Integra Gherkin: autotítulo, search, pin/archive, session, sync. Requiere API + Postgres + login (mismo patrón que `cli/scripts/nav-sync-smoke.ts`).

- [ ] Crear `cli/scripts/chat-org-smoke.ts`:

```ts
/**
 * Smoke: autotitle, pin sync, archive filter, search skips tool output, move same workspace.
 */
import { loadConfig } from "../src/config";
import { ChavezWsClient } from "../src/ws/client";
import { cwdPath } from "../src/workspace";
import {
  CHAT_UPDATED_EVENT,
  DEFAULT_CHAT_TITLE,
  displayChatTitle,
} from "../src/chats/org";

const config = loadConfig();
const token = process.env.CHAVEZ_ACCESS_TOKEN || config.accessToken;
if (!token) {
  console.error("Need login");
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

function waitPush(client: ChavezWsClient, type: string, timeout = 8000) {
  return new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type}`)), timeout);
    const off = client.onPush((msg) => {
      if (msg.type === type) {
        clearTimeout(t);
        off();
        resolve(msg.data);
      }
    });
  });
}

const session = await web.request({ type: "session.create", title: "org-smoke" });
if (!session.ok) throw new Error(session.error);
const sessionId = (session.data as { session: { id: string } }).session.id;

const otherSession = await web.request({
  type: "session.create",
  title: "org-smoke-2",
});
if (!otherSession.ok) throw new Error(otherSession.error);
const sessionId2 = (otherSession.data as { session: { id: string } }).session.id;

const chatRes = await web.request({ type: "chat.create", sessionId });
if (!chatRes.ok) throw new Error(chatRes.error);
const chat = (chatRes.data as { chat: { id: string; title: string; titleSource: string } }).chat;
if (chat.title !== DEFAULT_CHAT_TITLE) throw new Error(`expected default title, got ${chat.title}`);
if (chat.titleSource !== "default") throw new Error("titleSource default");

// Autotitle: primer user + primer assistant via stream.end
const append = await web.request({
  type: "chat.append",
  chatId: chat.id,
  role: "user",
  content: "Rewrite the login form validation",
});
if (!append.ok) throw new Error(append.error);

const titled = waitPush(daemon, CHAT_UPDATED_EVENT);
const end = await web.request({
  type: "chat.stream.end",
  chatId: chat.id,
  streamId: crypto.randomUUID(),
  content: "Done with the login form.",
});
if (!end.ok) throw new Error(end.error);
const updated = (await titled) as { chat: { title: string; titleSource: string; id: string } };
if (updated.chat.id !== chat.id) throw new Error("autotitle wrong chat");
if (updated.chat.titleSource !== "auto") throw new Error("expected auto");
if (updated.chat.title === chat.id || updated.chat.title === DEFAULT_CHAT_TITLE) {
  throw new Error(`title still placeholder: ${updated.chat.title}`);
}
if (!/login form/i.test(updated.chat.title)) {
  throw new Error(`autotitle missed prompt: ${updated.chat.title}`);
}
console.log("autotitle OK", displayChatTitle(updated.chat));

// Pin on web → daemon sees chat.updated
const pinPush = waitPush(daemon, CHAT_UPDATED_EVENT);
const pin = await web.request({
  type: "chat.update",
  chatId: chat.id,
  pinned: true,
});
if (!pin.ok) throw new Error(pin.error);
const pinned = (await pinPush) as { chat: { pinnedAt: string | null } };
if (!pinned.chat.pinnedAt) throw new Error("pin not synced to daemon socket");
const listed = await daemon.request({ type: "chat.list", sessionId });
const chats = (listed.data as { chats: Array<{ id: string; pinnedAt: string | null }> }).chats;
if (chats[0]?.id !== chat.id || !chats[0]?.pinnedAt) throw new Error("pin did not rise");
console.log("pin sync OK");

// Archive hides
await web.request({ type: "chat.update", chatId: chat.id, archived: true });
const hidden = await daemon.request({ type: "chat.list", sessionId });
const visible = (hidden.data as { chats: Array<{ id: string }> }).chats;
if (visible.some((c) => c.id === chat.id)) throw new Error("archived still listed");
const onlyArch = await daemon.request({
  type: "chat.list",
  sessionId,
  archivedOnly: true,
});
const archRows = (onlyArch.data as { chats: Array<{ id: string }> }).chats;
if (!archRows.some((c) => c.id === chat.id)) throw new Error("archivedOnly missed chat");
await web.request({ type: "chat.update", chatId: chat.id, archived: false });
console.log("archive filter OK");

// Search: title/message hit; tool output secret not indexed
const secretChat = await web.request({
  type: "chat.create",
  sessionId,
  title: "unrelated",
});
const secretId = (secretChat.data as { chat: { id: string } }).chat.id;
await web.request({
  type: "chat.append",
  chatId: secretId,
  role: "tool",
  content: "sk-ant-secret-token-value",
  metadata: { toolName: "Grep", output: "sk-ant-secret-token-value", secret: true },
});
const miss = await daemon.request({
  type: "chat.search",
  query: "sk-ant-secret-token-value",
});
const missChats = (miss.data as { chats: Array<{ id: string }> }).chats ?? [];
if (missChats.some((c) => c.id === secretId)) {
  throw new Error("search indexed secret tool output");
}
const hit = await daemon.request({
  type: "chat.search",
  query: "login form",
});
const hitChats = (hit.data as { chats: Array<{ id: string }> }).chats ?? [];
if (!hitChats.some((c) => c.id === chat.id)) throw new Error("search missed title/message");
console.log("search skip tool secrets OK");

// Move stays in workspace
const moved = await web.request({
  type: "chat.update",
  chatId: chat.id,
  sessionId: sessionId2,
});
if (!moved.ok) throw new Error(moved.error);
const movedChat = (moved.data as { chat: { sessionId: string } }).chat;
if (movedChat.sessionId !== sessionId2) throw new Error("move failed");
console.log("move same workspace OK");

daemon.close();
web.close();
console.log("chat-org-smoke OK");
```

- [ ] Correr (API + Postgres + `chavez login` + `db:push` de Task 2):

```bash
cd cli && bun run scripts/chat-org-smoke.ts
```

Sale `chat-org-smoke OK`. Si el entorno no tiene daemon real, el smoke **no** llama `agent.turn.request`: usa `chat.stream.end` directo (mismo handler de autotítulo).

- [ ] Añadir script en `cli/package.json` si no existe:

```json
"test:chat-org": "bun run scripts/chat-org-smoke.ts"
```

- [ ] Commit:

```bash
git add cli/scripts/chat-org-smoke.ts cli/package.json
git commit -m "test(chats): smoke autotitle, pin sync, archive and secret-safe search"
```

---

## Orden de implementación y verificación Gherkin

| Escenario | Tasks | Cómo se demuestra |
|---|---|---|
| Autotítulo | 1, 2, 4, 6, 7, 8 | Chat nuevo `title=Chat` / `titleSource=default`. Tras primer `chat.stream.end` el título es el prompt recortado, no el UUID. Web `ChatOrgBar` y TUI `r` editan (`titleSource=user`). |
| Buscar | 1, 3, 4, 5, 6, 7, 8 | `GET /chats/search` / `chat.search` / TUI `f` / Web input. Hit por título o user/assistant. Tool `sk-ant-…` **no** sale. |
| Pin y archivar | 2–8 | Pin → primera fila. Archive → desaparece. `chavez headless chat list <sid> --archived` lo muestra. Unarchive restaura. |
| Session agrupa chats | 3, 4, 5, 7 | `chat.create` bound a workspace A rechaza session de B. Move solo intra-workspace. Overview `chatsLimit=20` + `SHOW_MORE_CHATS`; no se bajan todos los mensajes. |
| Sync | 4, 6, 8 | Pin vía socket “web”; socket “daemon” (TUI) recibe `chat.updated` y reordena. |

Nada de esta fase abre el cwd desde API o browser. Turns siguen exigiendo daemon bound. Preferencias de provider/modo intactas.
