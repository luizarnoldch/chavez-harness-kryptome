import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chatMessages,
  chats,
  workspaces,
} from "../db/schema";
import type { Session } from "../auth";
import { hub } from "../ws/hub";

export function createWorkspaceRoutes(
  requireSession: (c: { req: { raw: Request } }) => Promise<Session | null>
) {
  const app = new Hono();

  app.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, session.user.id))
      .orderBy(desc(workspaces.updatedAt));
    return c.json({
      workspaces: rows.map((w) => ({
        ...w,
        openConnections: hub.countForWorkspace(session.user.id, w.id),
      })),
    });
  });

  app.get("/:workspaceId/sessions", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const workspaceId = c.req.param("workspaceId");
    const ws = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.userId, session.user.id)
        )
      )
      .limit(1);
    if (!ws[0]) return c.json({ error: "Workspace not found" }, 404);

    const rows = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.workspaceId, workspaceId),
          eq(agentSessions.userId, session.user.id)
        )
      )
      .orderBy(desc(agentSessions.updatedAt));

    return c.json({
      workspace: ws[0],
      sessions: rows,
      openConnections: hub.countForWorkspace(session.user.id, workspaceId),
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
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      connections: hub.listForUser(session.user.id),
    });
  });

  app.get("/sessions/:sessionId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const sessionId = c.req.param("sessionId");
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
    if (!rows[0]) return c.json({ error: "Session not found" }, 404);
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
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const sessionId = c.req.param("sessionId");
    const owned = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.userId, session.user.id)
        )
      )
      .limit(1);
    if (!owned[0]) return c.json({ error: "Session not found" }, 404);

    const rows = await db
      .select()
      .from(chats)
      .where(
        and(eq(chats.sessionId, sessionId), eq(chats.userId, session.user.id))
      )
      .orderBy(desc(chats.updatedAt));
    return c.json({ sessionId, chats: rows });
  });

  app.get("/chats/:chatId", async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const chatId = c.req.param("chatId");
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

    return c.json({ chat: chatRows[0], messages });
  });

  return app;
}
