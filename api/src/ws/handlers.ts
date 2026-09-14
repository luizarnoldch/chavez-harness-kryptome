import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chatMessages,
  chats,
  workspaces,
} from "../db/schema";
import { hub } from "./hub";
import {
  basename,
  fail,
  normalizePath,
  ok,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";

function requireWorkspace(connectionId: string): string {
  const conn = hub.get(connectionId);
  if (!conn?.workspaceId) {
    throw new Error("Workspace not bound. Send workspace.bind first.");
  }
  return conn.workspaceId;
}

export async function handleWsMessage(
  connectionId: string,
  userId: string,
  raw: string
): Promise<ServerMessage> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return fail("error", "unknown", "Invalid JSON");
  }

  const { type, id } = msg;
  if (!type || !id) {
    return fail("error", id || "unknown", "type and id are required");
  }

  try {
    switch (type) {
      case "ping":
        return ok("pong", id, { t: Date.now() });

      case "workspace.bind": {
        if (!msg.path) return fail(type, id, "path is required");
        const path = normalizePath(msg.path);
        const name = basename(path);
        const existing = await db
          .select()
          .from(workspaces)
          .where(and(eq(workspaces.userId, userId), eq(workspaces.path, path)))
          .limit(1);

        let workspace = existing[0];
        const now = new Date();
        if (!workspace) {
          const row = {
            id: crypto.randomUUID(),
            userId,
            path,
            name,
            createdAt: now,
            updatedAt: now,
          };
          await db.insert(workspaces).values(row);
          workspace = row;
        } else {
          await db
            .update(workspaces)
            .set({ updatedAt: now, name })
            .where(eq(workspaces.id, workspace.id));
          workspace = { ...workspace, updatedAt: now, name };
        }
        hub.setWorkspace(connectionId, workspace.id, path);
        return ok(type, id, { workspace });
      }

      case "workspace.unbind": {
        hub.setWorkspace(connectionId, null, null);
        return ok(type, id, { unbound: true });
      }

      case "session.create": {
        const workspaceId = requireWorkspace(connectionId);
        const now = new Date();
        const row = {
          id: crypto.randomUUID(),
          workspaceId,
          userId,
          title: msg.title?.trim() || "Session",
          createdAt: now,
          updatedAt: now,
        };
        await db.insert(agentSessions).values(row);
        return ok(type, id, { session: row });
      }

      case "session.list": {
        const workspaceId = requireWorkspace(connectionId);
        const rows = await db
          .select()
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.workspaceId, workspaceId),
              eq(agentSessions.userId, userId)
            )
          )
          .orderBy(desc(agentSessions.updatedAt));
        return ok(type, id, { sessions: rows });
      }

      case "chat.create": {
        if (!msg.sessionId) return fail(type, id, "sessionId is required");
        const sessions = await db
          .select()
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.id, msg.sessionId),
              eq(agentSessions.userId, userId)
            )
          )
          .limit(1);
        if (!sessions[0]) return fail(type, id, "Session not found");
        const now = new Date();
        const row = {
          id: crypto.randomUUID(),
          sessionId: msg.sessionId,
          userId,
          title: msg.title?.trim() || "Chat",
          createdAt: now,
          updatedAt: now,
        };
        await db.insert(chats).values(row);
        return ok(type, id, { chat: row });
      }

      case "chat.list": {
        if (!msg.sessionId) return fail(type, id, "sessionId is required");
        const rows = await db
          .select()
          .from(chats)
          .where(
            and(eq(chats.sessionId, msg.sessionId), eq(chats.userId, userId))
          )
          .orderBy(desc(chats.updatedAt));
        return ok(type, id, { chats: rows });
      }

      case "chat.append": {
        if (!msg.chatId || !msg.content?.trim()) {
          return fail(type, id, "chatId and content are required");
        }
        const role = msg.role || "user";
        if (!["user", "assistant", "system"].includes(role)) {
          return fail(type, id, "role must be user|assistant|system");
        }
        const chatRows = await db
          .select()
          .from(chats)
          .where(and(eq(chats.id, msg.chatId), eq(chats.userId, userId)))
          .limit(1);
        if (!chatRows[0]) return fail(type, id, "Chat not found");

        const now = new Date();
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role,
          content: msg.content.trim(),
          createdAt: now,
        };
        await db.insert(chatMessages).values(message);
        await db
          .update(chats)
          .set({ updatedAt: now })
          .where(eq(chats.id, msg.chatId));
        return ok(type, id, { message });
      }

      case "chat.get": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chatRows = await db
          .select()
          .from(chats)
          .where(and(eq(chats.id, msg.chatId), eq(chats.userId, userId)))
          .limit(1);
        if (!chatRows[0]) return fail(type, id, "Chat not found");
        const messages = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatId, msg.chatId))
          .orderBy(asc(chatMessages.createdAt));
        return ok(type, id, { chat: chatRows[0], messages });
      }

      case "chat.stream.start":
      case "chat.stream.delta":
      case "chat.stream.end":
      case "chat.stream.error":
        return fail(type, id, "Streaming not implemented yet");

      default:
        return fail(type, id, `Unknown type: ${type}`);
    }
  } catch (err) {
    return fail(type, id, err instanceof Error ? err.message : String(err));
  }
}
