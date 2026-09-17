import { Hono } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chatMessages,
  chats,
  turnFileDiffs,
  workspaces,
} from "../db/schema";
import type { Session } from "../auth";
import { hub } from "../ws/hub";
import { UNAUTHORIZED } from "../ws/errors";
import {
  loadOwnedChat,
  loadOwnedSession,
  loadOwnedWorkspace,
  missingJson,
} from "./ownership";
import { toPreview, visibleStatus } from "../ws/diff-protocol";

const RECENT_MESSAGES_PER_CHAT = 3;

export function createWorkspaceRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, session.user.id))
      .orderBy(desc(workspaces.updatedAt));
    return c.json({
      workspaces: rows.map((w) => {
        const daemon = hub.findDaemon(session.user.id, w.id);
        return {
          ...w,
          userRulesEnabled: w.userRulesEnabled !== false,
          openConnections: hub.countForWorkspace(session.user.id, w.id),
          daemonBound: Boolean(daemon),
          daemonHostname: daemon?.hostname ?? null,
          daemonPath: daemon?.path ?? w.path,
        };
      }),
    });
  });

  app.put("/:workspaceId/preferences", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const workspaceId = c.req.param("workspaceId");
    const body = await c.req.json<{ userRulesEnabled?: boolean }>().catch(() => ({}));
    if (typeof body.userRulesEnabled !== "boolean") {
      return c.json({ error: "userRulesEnabled must be boolean" }, 400);
    }
    const ws = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.userId, session.user.id),
        ),
      )
      .limit(1);
    if (!ws[0]) return c.json({ error: "Workspace not found" }, 404);
    await db
      .update(workspaces)
      .set({ userRulesEnabled: body.userRulesEnabled, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    hub.broadcastToUser(
      session.user.id,
      hub.pushEvent("workspace.prefs.updated", {
        workspaceId,
        userRulesEnabled: body.userRulesEnabled,
      }),
    );
    return c.json({
      workspaceId,
      userRulesEnabled: body.userRulesEnabled,
    });
  });

  app.get("/:workspaceId/sessions", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    const workspaceId = c.req.param("workspaceId");
    const owned = await loadOwnedWorkspace(workspaceId, session.user.id);
    if (!owned) return c.json(missingJson("workspace"), 404);
    const ws = [owned];

    const sessionRows = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.workspaceId, workspaceId),
          eq(agentSessions.userId, session.user.id)
        )
      )
      .orderBy(desc(agentSessions.updatedAt));

    const daemon = hub.findDaemon(session.user.id, workspaceId);
    const daemonFields = {
      openConnections: hub.countForWorkspace(session.user.id, workspaceId),
      daemonBound: Boolean(daemon),
      daemonHostname: daemon?.hostname ?? null,
      daemonPath: daemon?.path ?? ws[0].path,
    };

    if (sessionRows.length === 0) {
      return c.json({
        workspace: ws[0],
        sessions: [],
        ...daemonFields,
      });
    }

    const sessionIds = sessionRows.map((s) => s.id);
    const chatRows = await db
      .select()
      .from(chats)
      .where(
        and(
          inArray(chats.sessionId, sessionIds),
          eq(chats.userId, session.user.id)
        )
      )
      .orderBy(desc(chats.updatedAt));

    const chatIds = chatRows.map((ch) => ch.id);
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
      const counts = await db
        .select({
          chatId: chatMessages.chatId,
          count: sql<number>`count(*)::int`,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.chatId, chatIds))
        .groupBy(chatMessages.chatId);
      for (const row of counts) {
        messageCountByChat.set(row.chatId, Number(row.count));
      }

      const allMessages = await db
        .select({
          id: chatMessages.id,
          chatId: chatMessages.chatId,
          role: chatMessages.role,
          content: chatMessages.content,
          metadata: chatMessages.metadata,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.chatId, chatIds))
        .orderBy(desc(chatMessages.createdAt));

      for (const m of allMessages) {
        const list = recentByChat.get(m.chatId) ?? [];
        if (list.length >= RECENT_MESSAGES_PER_CHAT) continue;
        list.push({
          id: m.id,
          role: m.role,
          content: m.content,
          metadata: (m.metadata as Record<string, unknown> | null) ?? null,
          createdAt: m.createdAt,
        });
        recentByChat.set(m.chatId, list);
      }

      for (const [chatId, list] of recentByChat) {
        recentByChat.set(chatId, list.reverse());
      }
    }

    const chatsBySession = new Map<string, typeof chatRows>();
    for (const ch of chatRows) {
      const list = chatsBySession.get(ch.sessionId) ?? [];
      list.push(ch);
      chatsBySession.set(ch.sessionId, list);
    }

    const nestedSessions = sessionRows.map((s) => ({
      ...s,
      chats: (chatsBySession.get(s.id) ?? []).map((ch) => ({
        ...ch,
        messageCount: messageCountByChat.get(ch.id) ?? 0,
        recentMessages: recentByChat.get(ch.id) ?? [],
      })),
    }));

    return c.json({
      workspace: ws[0],
      sessions: nestedSessions,
      ...daemonFields,
    });
  });

  return app;
}

export function createSessionChatRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>
) {
  const app = new Hono();

  app.get("/connections", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    return c.json({
      connections: hub.listForUser(session.user.id),
    });
  });

  app.get("/sessions/:sessionId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    const sessionId = c.req.param("sessionId");
    const owned = await loadOwnedSession(sessionId, session.user.id);
    if (!owned) return c.json(missingJson("session"), 404);
    const rows = await db
      .select({
        session: agentSessions,
        workspacePath: workspaces.path,
        workspaceName: workspaces.name,
      })
      .from(agentSessions)
      .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.userId, session.user.id)
        )
      )
      .limit(1);
    if (!rows[0]) return c.json(missingJson("session"), 404);
    return c.json({
      session: rows[0].session,
      workspace: {
        id: rows[0].session.workspaceId,
        path: rows[0].workspacePath,
        name: rows[0].workspaceName,
      },
    });
  });

  app.get("/sessions/:sessionId/chats", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    const sessionId = c.req.param("sessionId");
    const owned = await loadOwnedSession(sessionId, session.user.id);
    if (!owned) return c.json(missingJson("session"), 404);

    const rows = await db
      .select()
      .from(chats)
      .where(
        and(eq(chats.sessionId, sessionId), eq(chats.userId, session.user.id))
      )
      .orderBy(desc(chats.updatedAt));
    return c.json({ sessionId, chats: rows });
  });

  app.get("/chats/:chatId/diffs/:diffId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    const chatId = c.req.param("chatId");
    const diffId = c.req.param("diffId");
    const chatRows = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, session.user.id)))
      .limit(1);
    if (!chatRows[0]) return c.json({ error: "Chat not found" }, 404);
    const rows = await db
      .select()
      .from(turnFileDiffs)
      .where(
        and(
          eq(turnFileDiffs.id, diffId),
          eq(turnFileDiffs.chatId, chatId),
          eq(turnFileDiffs.userId, session.user.id),
        ),
      )
      .limit(1);
    if (!rows[0]) return c.json({ error: "Diff not found" }, 404);
    const preview = toPreview(rows[0]);
    return c.json({
      diff: {
        ...preview,
        body: rows[0].omitted ? null : rows[0].body ?? rows[0].preview,
        omitted: rows[0].omitted,
      },
    });
  });

  app.get("/chats/:chatId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: UNAUTHORIZED }, 401);
    const chatId = c.req.param("chatId");
    const ownedChat = await loadOwnedChat(chatId, session.user.id);
    if (!ownedChat) return c.json(missingJson("chat"), 404);
    const chatRows = [ownedChat];

    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.createdAt));

    const diffRows = await db
      .select()
      .from(turnFileDiffs)
      .where(
        and(
          eq(turnFileDiffs.chatId, chatId),
          eq(turnFileDiffs.userId, session.user.id),
        ),
      )
      .orderBy(asc(turnFileDiffs.createdAt));
    const diffs = diffRows.filter((r) => visibleStatus(r.status)).map(toPreview);
    return c.json({ chat: chatRows[0], messages, diffs });
  });

  return app;
}
