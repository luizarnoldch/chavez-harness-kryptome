import { Hono } from "hono";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chatMessages,
  chats,
  turnFileDiffs,
  userPreferences,
  workspaces,
} from "../db/schema";
import { contextForMessages } from "../llm/context-chat";
import { defaultClaudeModelId } from "../llm/catalog";
import { currentPlanId } from "../llm/plan-artifact";
import { usageForMessages } from "../llm/usage-chat";
import { buildChatReplay } from "../llm/turn-replay-load";
import { REPLAY_TURN_RUNNING } from "../llm/turn-replay";
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
import {
  archivedClause,
  chatListOrder,
  listWorkspaceOverview,
} from "../chats/store";
import {
  buildChatExport,
  parseExportFormat,
  FORMAT_REQUIRED,
} from "../chats/export-load";
import { importChatDocument } from "../chats/import-chat";
import { IMPORT_INVALID, SESSION_NOT_FOUND, SHARE_NOT_FOUND } from "../chats/export-share";
import {
  createShare,
  getActiveShare,
  publicSharePayload,
  revokeShare,
} from "../chats/share";
import { loadOwnedChat as loadOwnedChatForExport } from "../chats/export-load";

const RECENT_MESSAGES_PER_CHAT = 3;

function integerQuery(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function truthyQuery(value?: string) {
  return value === "1" || value === "true";
}

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
          daemonConnections: hub.countDaemonsForWorkspace(
            session.user.id,
            w.id,
          ),
          daemonHostname: daemon?.hostname ?? null,
          daemonPath: daemon?.path ?? w.path,
          daemonLastSeen: daemon?.lastSeen ?? null,
          daemonRole: daemon?.role ?? null,
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
    const overview = await listWorkspaceOverview({
      workspaceId,
      userId: session.user.id,
      sessionsLimit: integerQuery(c.req.query("sessionsLimit"), 50),
      sessionsOffset: integerQuery(c.req.query("sessionsOffset"), 0),
      chatsLimit: integerQuery(c.req.query("chatsLimit"), 20),
      includeArchived: truthyQuery(c.req.query("includeArchived")),
      recentMessagesPerChat: RECENT_MESSAGES_PER_CHAT,
    });

    const daemon = hub.findDaemon(session.user.id, workspaceId);
    const daemonFields = {
      openConnections: hub.countForWorkspace(session.user.id, workspaceId),
      daemonBound: Boolean(daemon),
      daemonConnections: hub.countDaemonsForWorkspace(
        session.user.id,
        workspaceId,
      ),
      daemonHostname: daemon?.hostname ?? null,
      daemonPath: daemon?.path ?? owned.path,
      daemonLastSeen: daemon?.lastSeen ?? null,
      daemonRole: daemon?.role ?? null,
    };

    return c.json({
      workspace: owned,
      ...overview,
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

    const limit = Math.min(
      Math.max(integerQuery(c.req.query("limit"), 50), 1),
      100,
    );
    const offset = Math.max(integerQuery(c.req.query("offset"), 0), 0);
    const archived = archivedClause({
      includeArchived: truthyQuery(c.req.query("includeArchived")),
      archivedOnly: truthyQuery(c.req.query("archivedOnly")),
    });
    const filters = [
      eq(chats.sessionId, sessionId),
      eq(chats.userId, session.user.id),
    ];
    if (archived) filters.push(archived);
    const where = and(...filters);
    const [rows, counts] = await Promise.all([
      db
        .select()
        .from(chats)
        .where(where)
        .orderBy(...chatListOrder)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(chats)
        .where(where),
    ]);
    const total = Number(counts[0]?.count ?? 0);
    return c.json({
      sessionId,
      chats: rows,
      total,
      offset,
      hasMore: offset + limit < total,
    });
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
    const chat = await loadOwnedChatForExport(chatId, session.user.id);
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
    const prefRows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, session.user.id))
      .limit(1);
    const providerId = prefRows[0]?.activeProvider || "claude";
    const modelId =
      prefRows[0]?.activeModel || defaultClaudeModelId() || "claude-opus-4-6";
    const context = contextForMessages(messages, providerId, modelId);
    return c.json({
      chat: chatRows[0],
      messages,
      diffs,
      context,
      usage: usageForMessages(messages),
      currentPlanArtifactId: currentPlanId(
        messages.map((m) => ({
          id: m.id,
          metadata: (m.metadata as Record<string, unknown> | null) ?? null,
        })),
      ),
    });
  });

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

  return app;
}
