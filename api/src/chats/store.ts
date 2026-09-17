import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { db } from "../db";
import { agentSessions, chatMessages, chats, workspaces } from "../db/schema";
import {
  CHATS_PER_SESSION_WINDOW,
  CHAT_NOT_FOUND,
  CROSS_WORKSPACE_MOVE,
  CROSS_WORKSPACE_SESSION,
  DEFAULT_CHAT_TITLE,
  SEARCH_LIMIT,
  SESSION_NOT_FOUND,
  SESSIONS_PAGE_SIZE,
  autotitleFromPrompt,
  compareChatsForList,
  firstSearchableUserPrompt,
  hasMoreNonArchivedChats,
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

function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  min = 1,
) {
  const parsed = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(parsed, min), max);
}

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
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function assertSessionInWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string | null,
): Promise<
  | { ok: true; session: typeof agentSessions.$inferSelect }
  | { ok: false; error: string }
> {
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
): Promise<
  | { ok: true; chat: typeof chats.$inferSelect }
  | { ok: false; error: string }
> {
  const current = await loadOwnedChat(chatId, userId);
  if (!current) return { ok: false, error: CHAT_NOT_FOUND };

  const now = new Date();
  const next: Partial<typeof chats.$inferInsert> & { updatedAt: Date } = {
    updatedAt: now,
  };

  if (patch.title !== undefined) {
    const normalized = normalizeTitleInput(patch.title);
    if (!normalized.ok) return normalized;
    next.title = normalized.title;
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
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
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
      and(
        eq(chatMessages.chatId, input.chatId),
        eq(chatMessages.role, "assistant"),
      ),
    );
  if (Number(assistantCount[0]?.n ?? 0) !== 1) return null;

  const users = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, input.chatId),
        eq(chatMessages.role, "user"),
      ),
    )
    .orderBy(asc(chatMessages.createdAt));
  const title = autotitleFromPrompt(firstSearchableUserPrompt(users) || "");
  if (!title || title === DEFAULT_CHAT_TITLE) return null;

  const rows = await db
    .update(chats)
    .set({
      title,
      titleSource: "auto" satisfies TitleSource,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chats.id, input.chatId),
        eq(chats.userId, input.userId),
        eq(chats.titleSource, "default"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export const SEARCHABLE_ROLES = ["user", "assistant"] as const;

export async function searchChats(input: {
  userId: string;
  query: string;
  workspaceId?: string;
  sessionId?: string;
  includeArchived?: boolean;
  limit?: number;
}) {
  const normalized = normalizeSearchQuery(input.query);
  if (!normalized.ok) return normalized;
  const limit = boundedInteger(input.limit, SEARCH_LIMIT, SEARCH_LIMIT);
  const pattern = ilikePattern(normalized.query);

  const archived = archivedClause({
    includeArchived: input.includeArchived,
  });
  const titleFilters = [
    eq(chats.userId, input.userId),
    ilike(chats.title, pattern),
  ];
  const messageFilters = [
    eq(chats.userId, input.userId),
    inArray(chatMessages.role, [...SEARCHABLE_ROLES]),
    ilike(chatMessages.content, pattern),
    sql`coalesce(${chatMessages.metadata}->>'kind','') <> 'slash_result'`,
    sql`coalesce(${chatMessages.metadata}->>'secret','') <> 'true'`,
    sql`coalesce(${chatMessages.metadata}->>'vault','') <> 'true'`,
  ];
  if (archived) {
    titleFilters.push(archived);
    messageFilters.push(archived);
  }
  if (input.sessionId) {
    titleFilters.push(eq(chats.sessionId, input.sessionId));
    messageFilters.push(eq(chats.sessionId, input.sessionId));
  }
  if (input.workspaceId) {
    titleFilters.push(eq(agentSessions.workspaceId, input.workspaceId));
    messageFilters.push(eq(agentSessions.workspaceId, input.workspaceId));
  }

  const [titleHits, messageHits] = await Promise.all([
    db
      .select({ chatId: chats.id })
      .from(chats)
      .innerJoin(agentSessions, eq(chats.sessionId, agentSessions.id))
      .where(and(...titleFilters))
      .orderBy(...chatListOrder)
      .limit(limit),
    db
      .select({ chatId: chatMessages.chatId })
      .from(chatMessages)
      .innerJoin(chats, eq(chatMessages.chatId, chats.id))
      .innerJoin(agentSessions, eq(chats.sessionId, agentSessions.id))
      .where(and(...messageFilters))
      .groupBy(chatMessages.chatId, chats.pinnedAt, chats.updatedAt)
      .orderBy(...chatListOrder)
      .limit(limit),
  ]);
  const matchingIds = [
    ...new Set([
      ...titleHits.map((row) => row.chatId),
      ...messageHits.map((row) => row.chatId),
    ]),
  ];
  if (matchingIds.length === 0) {
    return {
      ok: true as const,
      query: normalized.query,
      chats: [],
    };
  }

  const filters = [
    eq(chats.userId, input.userId),
    inArray(chats.id, matchingIds),
  ];
  if (archived) filters.push(archived);
  if (input.sessionId) filters.push(eq(chats.sessionId, input.sessionId));
  if (input.workspaceId) {
    filters.push(eq(agentSessions.workspaceId, input.workspaceId));
  }

  const rows = await db
    .select({
      chat: chats,
      sessionTitle: agentSessions.title,
      workspaceId: agentSessions.workspaceId,
      workspaceName: workspaces.name,
      workspacePath: workspaces.path,
    })
    .from(chats)
    .innerJoin(agentSessions, eq(chats.sessionId, agentSessions.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .where(and(...filters))
    .orderBy(...chatListOrder)
    .limit(limit);

  const chatsOut = rows.map((row) => ({
    ...row.chat,
    sessionTitle: row.sessionTitle,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspacePath: row.workspacePath,
  }));
  chatsOut.sort(compareChatsForList);
  return {
    ok: true as const,
    query: normalized.query,
    chats: chatsOut.slice(0, limit),
  };
}

type OverviewInput = {
  workspaceId: string;
  userId: string;
  sessionsLimit?: number;
  sessionsOffset?: number;
  chatsLimit?: number;
  includeArchived?: boolean;
  recentMessagesPerChat: number;
};

export async function listWorkspaceOverview(input: OverviewInput) {
  const sessionsLimit = boundedInteger(
    input.sessionsLimit,
    SESSIONS_PAGE_SIZE,
    SESSIONS_PAGE_SIZE,
  );
  const sessionsOffset = boundedInteger(
    input.sessionsOffset,
    0,
    Number.MAX_SAFE_INTEGER,
    0,
  );
  const chatsLimit = boundedInteger(
    input.chatsLimit,
    CHATS_PER_SESSION_WINDOW,
    CHATS_PER_SESSION_WINDOW,
  );
  const sessionFilter = and(
    eq(agentSessions.workspaceId, input.workspaceId),
    eq(agentSessions.userId, input.userId),
  );
  const [sessionRows, sessionCounts] = await Promise.all([
    db
      .select()
      .from(agentSessions)
      .where(sessionFilter)
      .orderBy(desc(agentSessions.updatedAt))
      .limit(sessionsLimit)
      .offset(sessionsOffset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSessions)
      .where(sessionFilter),
  ]);
  const sessionCount = Number(sessionCounts[0]?.count ?? 0);
  if (sessionRows.length === 0) {
    return {
      sessions: [],
      sessionCount,
      sessionsOffset,
      hasMoreSessions: sessionsOffset + sessionsLimit < sessionCount,
    };
  }

  const archived = archivedClause({
    includeArchived: input.includeArchived,
  });
  const chatRowsBySession = await Promise.all(
    sessionRows.map(async (session) => {
      const filters = [
        eq(chats.sessionId, session.id),
        eq(chats.userId, input.userId),
      ];
      if (archived) filters.push(archived);
      return db
        .select()
        .from(chats)
        .where(and(...filters))
        .orderBy(...chatListOrder)
        .limit(chatsLimit);
    }),
  );
  const sessionIds = sessionRows.map((session) => session.id);
  const countFilters = [
    inArray(chats.sessionId, sessionIds),
    eq(chats.userId, input.userId),
    isNull(chats.archivedAt),
  ];
  const chatCounts = await db
    .select({
      sessionId: chats.sessionId,
      count: sql<number>`count(*)::int`,
    })
    .from(chats)
    .where(and(...countFilters))
    .groupBy(chats.sessionId);
  const chatCountBySession = new Map(
    chatCounts.map((row) => [row.sessionId, Number(row.count)]),
  );

  const chatRows = chatRowsBySession.flat();
  const chatIds = chatRows.map((chat) => chat.id);
  const messageCountByChat = new Map<string, number>();
  const recentByChat = new Map<
    string,
    Array<{
      id: string;
      role: string;
      content: string;
      metadata: Record<string, unknown> | null;
      createdAt: Date;
    }>
  >();
  if (chatIds.length > 0) {
    const [messageCounts, recentRows] = await Promise.all([
      db
        .select({
          chatId: chatMessages.chatId,
          count: sql<number>`count(*)::int`,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.chatId, chatIds))
        .groupBy(chatMessages.chatId),
      (() => {
        const ranked = db
          .select({
            id: chatMessages.id,
            chatId: chatMessages.chatId,
            role: chatMessages.role,
            content: chatMessages.content,
            metadata: chatMessages.metadata,
            createdAt: chatMessages.createdAt,
            rowNumber:
              sql<number>`row_number() over (partition by ${chatMessages.chatId} order by ${chatMessages.createdAt} desc)`.as(
                "row_number",
              ),
          })
          .from(chatMessages)
          .where(inArray(chatMessages.chatId, chatIds))
          .as("ranked_messages");
        return db
          .select({
            id: ranked.id,
            chatId: ranked.chatId,
            role: ranked.role,
            content: ranked.content,
            metadata: ranked.metadata,
            createdAt: ranked.createdAt,
          })
          .from(ranked)
          .where(lte(ranked.rowNumber, input.recentMessagesPerChat))
          .orderBy(asc(ranked.createdAt));
      })(),
    ]);
    for (const row of messageCounts) {
      messageCountByChat.set(row.chatId, Number(row.count));
    }
    for (const row of recentRows) {
      const list = recentByChat.get(row.chatId) ?? [];
      list.push({
        ...row,
        metadata:
          (row.metadata as Record<string, unknown> | null | undefined) ?? null,
      });
      recentByChat.set(row.chatId, list);
    }
  }

  return {
    sessions: sessionRows.map((session, index) => {
      const chatCount = chatCountBySession.get(session.id) ?? 0;
      const sessionChatRows = chatRowsBySession[index];
      return {
        ...session,
        chats: sessionChatRows.map((chat) => ({
          ...chat,
          messageCount: messageCountByChat.get(chat.id) ?? 0,
          recentMessages: recentByChat.get(chat.id) ?? [],
        })),
        chatCount,
        hasMoreChats: hasMoreNonArchivedChats(sessionChatRows, chatCount),
      };
    }),
    sessionCount,
    sessionsOffset,
    hasMoreSessions: sessionsOffset + sessionsLimit < sessionCount,
  };
}
