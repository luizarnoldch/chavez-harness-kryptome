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

async function loadChatForUser(chatId: string, userId: string) {
  const chatRows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return chatRows[0] ?? null;
}

async function workspaceIdForChat(chatId: string, userId: string) {
  const chat = await loadChatForUser(chatId, userId);
  if (!chat) return null;
  const sessions = await db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, chat.sessionId), eq(agentSessions.userId, userId)),
    )
    .limit(1);
  const session = sessions[0];
  if (!session) return null;
  return { chat, session, workspaceId: session.workspaceId };
}

function broadcast(
  userId: string,
  type: string,
  data: unknown,
  except?: string,
) {
  hub.broadcastToUser(userId, hub.pushEvent(type, data), { except });
}

export async function handleWsMessage(
  connectionId: string,
  userId: string,
  raw: string,
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
        const clientKind =
          msg.clientKind === "daemon" ? "daemon" : ("client" as const);
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
        hub.setClientKind(connectionId, clientKind);
        return ok(type, id, { workspace, clientKind });
      }

      case "workspace.unbind": {
        hub.setWorkspace(connectionId, null, null);
        hub.setClientKind(connectionId, "client");
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
        broadcast(userId, "session.created", { session: row }, connectionId);
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
              eq(agentSessions.userId, userId),
            ),
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
              eq(agentSessions.userId, userId),
            ),
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
        broadcast(userId, "chat.created", { chat: row }, connectionId);
        return ok(type, id, { chat: row });
      }

      case "chat.list": {
        if (!msg.sessionId) return fail(type, id, "sessionId is required");
        const rows = await db
          .select()
          .from(chats)
          .where(
            and(eq(chats.sessionId, msg.sessionId), eq(chats.userId, userId)),
          )
          .orderBy(desc(chats.updatedAt));
        return ok(type, id, { chats: rows });
      }

      case "chat.append": {
        if (!msg.chatId || !msg.content?.trim()) {
          return fail(type, id, "chatId and content are required");
        }
        const role = msg.role || "user";
        if (!["user", "assistant", "system", "tool"].includes(role)) {
          return fail(type, id, "role must be user|assistant|system|tool");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");

        const now = new Date();
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role,
          content: msg.content.trim(),
          metadata: msg.metadata ?? null,
          createdAt: now,
        };
        await db.insert(chatMessages).values(message);
        await db
          .update(chats)
          .set({ updatedAt: now })
          .where(eq(chats.id, msg.chatId));
        broadcast(
          userId,
          "message.appended",
          { message, chatId: msg.chatId },
          connectionId,
        );
        return ok(type, id, { message });
      }

      case "chat.get": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const messages = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatId, msg.chatId))
          .orderBy(asc(chatMessages.createdAt));
        return ok(type, id, { chat, messages });
      }

      case "chat.stream.start": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
        };
        broadcast(userId, "chat.stream.start", payload);
        return ok(type, id, payload);
      }

      case "chat.stream.delta": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const delta = msg.delta ?? msg.content ?? "";
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          delta,
        };
        broadcast(userId, "chat.stream.delta", payload);
        return ok(type, id, payload);
      }

      case "chat.stream.end": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        let message = null;
        const content = msg.content?.trim();
        if (content) {
          const now = new Date();
          message = {
            id: crypto.randomUUID(),
            chatId: msg.chatId,
            role: "assistant",
            content,
            metadata: {
              streamId: msg.streamId,
              ...(msg.metadata || {}),
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
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          message,
        };
        broadcast(userId, "chat.stream.end", payload);
        return ok(type, id, payload);
      }

      case "chat.stream.error": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          error: msg.content || "stream error",
        };
        broadcast(userId, "chat.stream.error", payload);
        return ok(type, id, payload);
      }

      case "chat.tool.start": {
        if (!msg.chatId || !msg.toolCallId || !msg.toolName) {
          return fail(
            type,
            id,
            "chatId, toolCallId and toolName are required",
          );
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const now = new Date();
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role: "tool",
          content: msg.content?.trim() || msg.toolName,
          metadata: {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            status: "running",
            input: msg.metadata?.input ?? msg.metadata ?? null,
          },
          createdAt: now,
        };
        await db.insert(chatMessages).values(message);
        await db
          .update(chats)
          .set({ updatedAt: now })
          .where(eq(chats.id, msg.chatId));
        broadcast(userId, "chat.tool.start", {
          message,
          chatId: msg.chatId,
        });
        broadcast(userId, "message.appended", {
          message,
          chatId: msg.chatId,
        });
        return ok(type, id, { message });
      }

      case "chat.tool.result": {
        if (!msg.chatId || !msg.toolCallId) {
          return fail(type, id, "chatId and toolCallId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const existing = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatId, msg.chatId))
          .orderBy(desc(chatMessages.createdAt));
        const toolRow = existing.find((m) => {
          const meta = m.metadata as Record<string, unknown> | null;
          return (
            m.role === "tool" && meta && meta.toolCallId === msg.toolCallId
          );
        });
        const now = new Date();
        const output = msg.content?.trim() || "";
        if (toolRow) {
          const prev = (toolRow.metadata as Record<string, unknown>) || {};
          const metadata = {
            ...prev,
            status: msg.status || "done",
            output,
          };
          await db
            .update(chatMessages)
            .set({
              content: output || toolRow.content,
              metadata,
            })
            .where(eq(chatMessages.id, toolRow.id));
          const message = {
            ...toolRow,
            content: output || toolRow.content,
            metadata,
          };
          broadcast(userId, "chat.tool.result", {
            message,
            chatId: msg.chatId,
          });
          broadcast(userId, "message.appended", {
            message,
            chatId: msg.chatId,
            updated: true,
          });
          return ok(type, id, { message });
        }
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role: "tool",
          content: output || msg.toolName || "tool",
          metadata: {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName || "tool",
            status: msg.status || "done",
            output,
            input: msg.metadata?.input ?? null,
          },
          createdAt: now,
        };
        await db.insert(chatMessages).values(message);
        await db
          .update(chats)
          .set({ updatedAt: now })
          .where(eq(chats.id, msg.chatId));
        broadcast(userId, "chat.tool.result", {
          message,
          chatId: msg.chatId,
        });
        broadcast(userId, "message.appended", {
          message,
          chatId: msg.chatId,
        });
        return ok(type, id, { message });
      }

      case "agent.turn.request": {
        if (!msg.chatId || !msg.prompt?.trim()) {
          return fail(type, id, "chatId and prompt are required");
        }
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, "Chat not found");
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) {
          return fail(
            type,
            id,
            "No daemon bound for this workspace. Run: chavez headless workspace open",
          );
        }
        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId))
          .limit(1);
        const workspace = wsRows[0];
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("agent.turn.dispatch", {
            chatId: msg.chatId,
            prompt: msg.prompt.trim(),
            requestId: id,
            workspaceId: ctx.workspaceId,
            path: workspace?.path || daemon.path,
            sessionId: ctx.session.id,
            requesterConnectionId: connectionId,
          }),
        );
        if (!sent) {
          return fail(type, id, "Daemon connection unavailable");
        }
        return ok(type, id, {
          accepted: true,
          daemonConnectionId: daemon.connectionId,
        });
      }

      default:
        return fail(type, id, `Unknown type: ${type}`);
    }
  } catch (err) {
    return fail(type, id, err instanceof Error ? err.message : String(err));
  }
}
