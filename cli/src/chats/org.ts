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

export type ChatPatchInput = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  sessionId?: string;
};

export function validateChatPatchInput(
  raw: unknown,
):
  | { ok: true; patch: ChatPatchInput }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "request body must be an object" };
  }

  const body = raw as Record<string, unknown>;
  if (body.title !== undefined && typeof body.title !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
    return { ok: false, error: "sessionId must be a string" };
  }
  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    return { ok: false, error: "pinned must be a boolean" };
  }
  if (body.archived !== undefined && typeof body.archived !== "boolean") {
    return { ok: false, error: "archived must be a boolean" };
  }

  const patch: ChatPatchInput = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.sessionId === "string") patch.sessionId = body.sessionId;
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  return { ok: true, patch };
}

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

export function firstSearchableUserPrompt(
  messages: Array<{
    role: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  }>,
): string | null {
  const message = messages.find((candidate) =>
    candidate.role === "user" &&
    isSearchableMessage(candidate.role, candidate.metadata),
  );
  return message?.content ?? null;
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

export function hasMoreNonArchivedChats(
  window: Array<{ archivedAt?: Date | string | null }>,
  nonArchivedTotal: number,
): boolean {
  const visibleNonArchived = window.filter((chat) => !chat.archivedAt).length;
  return visibleNonArchived < nonArchivedTotal;
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
