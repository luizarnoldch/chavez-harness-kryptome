import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chatMessages,
  chats,
  turnFileDiffs,
  userPreferences,
  workspaces,
} from "../db/schema";
import {
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
} from "../llm/execution-mode";
import { hub } from "./hub";
import { createPendingMap } from "./pending";
import {
  basename,
  fail,
  normalizePath,
  ok,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";
import {
  applyToolResult,
  asToolMeta,
  failToolMeta,
  isRunningToolMeta,
  isToolStatus,
  truncateToolText,
} from "./tool-protocol";
import {
  DAEMON_STANDBY_NOTE,
  NO_DAEMON_ERROR,
  NOT_FOUND_CHAT,
  TURN_BUSY_ERROR,
} from "./errors";
import { redactJson, redactText } from "../lib/redact";
import { parseDiffUpsert, toPreview, visibleStatus } from "./diff-protocol";

const fsPending = createPendingMap(5000);
const treePending = createPendingMap(5000);

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

async function listVisibleDiffs(chatId: string, userId: string) {
  const rows = await db
    .select()
    .from(turnFileDiffs)
    .where(
      and(eq(turnFileDiffs.chatId, chatId), eq(turnFileDiffs.userId, userId)),
    )
    .orderBy(asc(turnFileDiffs.createdAt));
  return rows.filter((r) => visibleStatus(r.status)).map(toPreview);
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

async function failRunningTools(
  userId: string,
  chatId: string,
  streamId: string | undefined,
  reason: string,
) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId));
  for (const row of rows) {
    if (row.role !== "tool") continue;
    const prev = asToolMeta(row.metadata);
    if (!isRunningToolMeta(prev, streamId)) continue;
    const metadata = failToolMeta(prev, reason);
    const content = String(metadata.output || reason);
    await db
      .update(chatMessages)
      .set({ metadata, content })
      .where(eq(chatMessages.id, row.id));
    const message = { ...row, metadata, content };
    broadcast(userId, "chat.tool.result", { message, chatId, updated: true });
    broadcast(userId, "message.appended", { message, chatId, updated: true });
  }
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
        if (typeof msg.hostname === "string" && msg.hostname.trim()) {
          hub.setHostname(connectionId, msg.hostname.trim());
        } else {
          hub.setHostname(connectionId, null);
        }
        let role: "primary" | "standby" | "client" = "client";
        if (clientKind === "daemon") {
          const peers = hub
            .findDaemons(userId, workspace.id)
            .filter((c) => c.connectionId !== connectionId);
          if (peers[0]) {
            hub.setRole(connectionId, "standby");
            role = "standby";
          } else {
            hub.setRole(connectionId, "primary");
            role = "primary";
          }
        } else {
          hub.setRole(connectionId, "client");
        }
        const primary = hub.findDaemon(userId, workspace.id);
        broadcast(userId, "daemon.presence", {
          workspaceId: workspace.id,
          bound: true,
          hostname: primary?.hostname ?? null,
          path: primary?.path ?? path,
          connectionId: primary?.connectionId,
          role: "primary",
          viewerRole: role,
        });
        return ok(type, id, {
          workspace,
          clientKind,
          hostname: hub.get(connectionId)?.hostname ?? null,
          role,
          primaryConnectionId: primary?.connectionId ?? connectionId,
          standbyReason:
            role === "standby" ? DAEMON_STANDBY_NOTE : undefined,
        });
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
        if (!chat) return fail(type, id, NOT_FOUND_CHAT);

        const now = new Date();
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role,
          content: redactText(msg.content.trim()),
          metadata: (msg.metadata
            ? (redactJson(msg.metadata) as Record<string, unknown>)
            : null),
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
        const diffs = await listVisibleDiffs(msg.chatId, userId);
        return ok(type, id, { chat, messages, diffs });
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
        const delta = redactText(msg.delta ?? msg.content ?? "");
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          delta,
          seq: typeof msg.seq === "number" ? msg.seq : undefined,
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
        const content = msg.content?.trim()
          ? redactText(msg.content.trim())
          : "";
        if (content) {
          const now = new Date();
          message = {
            id: crypto.randomUUID(),
            chatId: msg.chatId,
            role: "assistant",
            content,
            metadata: {
              streamId: msg.streamId,
              ...((msg.metadata
                ? (redactJson(msg.metadata) as Record<string, unknown>)
                : {}) as Record<string, unknown>),
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
        await failRunningTools(userId, msg.chatId, msg.streamId, payload.error);
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
        const redactedMeta = msg.metadata
          ? (redactJson(msg.metadata) as Record<string, unknown>)
          : {};
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role: "tool",
          content: redactText(msg.content?.trim() || msg.toolName),
          metadata: {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            sdkName: redactedMeta.sdkName ?? msg.toolName,
            status: isToolStatus(msg.status) ? msg.status : "running",
            input: redactedMeta.input ?? null,
            streamId: msg.streamId ?? redactedMeta.streamId ?? null,
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
          const meta = asToolMeta(m.metadata);
          return m.role === "tool" && meta.toolCallId === msg.toolCallId;
        });
        const now = new Date();
        if (toolRow) {
          const prev = asToolMeta(toolRow.metadata);
          const redactedMeta = msg.metadata
            ? (redactJson(msg.metadata) as Record<string, unknown>)
            : {};
          const metadata = applyToolResult(prev, {
            status: msg.status,
            output: msg.content ? redactText(msg.content) : msg.content,
            input: redactedMeta.input,
            toolName: msg.toolName,
          });
          const content = redactText(String(metadata.output || toolRow.content));
          await db
            .update(chatMessages)
            .set({
              content,
              metadata,
            })
            .where(eq(chatMessages.id, toolRow.id));
          const message = {
            ...toolRow,
            content,
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
        const fallbackMeta = msg.metadata
          ? (redactJson(msg.metadata) as Record<string, unknown>)
          : {};
        const metadata = applyToolResult(
          {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName || "tool",
            input: fallbackMeta.input ?? null,
          },
          {
            status: msg.status || "done",
            output: msg.content ? redactText(msg.content) : msg.content,
            toolName: msg.toolName,
          },
        );
        const content = redactText(
          String(metadata.output || msg.toolName || "tool"),
        );
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role: "tool",
          content,
          metadata,
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

      case "chat.tool.update": {
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
          const meta = asToolMeta(m.metadata);
          return m.role === "tool" && meta.toolCallId === msg.toolCallId;
        });
        if (!toolRow) return fail(type, id, "Tool call not found");
        const prev = asToolMeta(toolRow.metadata);
        const incoming = (msg.metadata || {}) as Record<string, unknown>;
        const metadata = {
          ...prev,
          ...incoming,
          toolCallId: prev.toolCallId,
          toolName: prev.toolName ?? incoming.toolName,
          status: isToolStatus(msg.status) ? msg.status : prev.status,
          input: incoming.input !== undefined ? incoming.input : prev.input,
          output:
            msg.content != null && msg.content !== ""
              ? truncateToolText(msg.content)
              : prev.output,
        };
        await db
          .update(chatMessages)
          .set({ metadata })
          .where(eq(chatMessages.id, toolRow.id));
        const message = { ...toolRow, metadata };
        broadcast(userId, "chat.tool.update", { message, chatId: msg.chatId });
        broadcast(userId, "message.appended", {
          message,
          chatId: msg.chatId,
          updated: true,
        });
        return ok(type, id, { message });
      }

      case "fs.complete": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const query = String(msg.query ?? "");
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, "Chat not found");
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) {
          return fail(type, id, NO_DAEMON_ERROR);
        }
        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId))
          .limit(1);
        const workspace = wsRows[0];
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("fs.complete.dispatch", {
            requestId: id,
            query,
            limit: 10,
            requesterConnectionId: connectionId,
            path: workspace?.path || daemon.path,
            chatId: msg.chatId,
          }),
        );
        if (!sent) {
          return fail(type, id, "Daemon connection unavailable");
        }
        return await fsPending.wait(id, type);
      }

      case "fs.complete.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = (msg.metadata || {}) as {
          cwd?: string;
          candidates?: unknown;
        };
        const payload = {
          hostname: msg.hostname || null,
          cwd: meta.cwd || msg.path || null,
          candidates: Array.isArray(meta.candidates)
            ? meta.candidates.slice(0, 10)
            : [],
        };
        const forwarded = fsPending.complete(
          msg.requestId,
          ok("fs.complete", msg.requestId, payload),
        );
        return ok(type, id, { forwarded });
      }

      case "fs.tree": {
        const workspaceId = requireWorkspace(connectionId);
        const daemon = hub.findDaemon(userId, workspaceId);
        if (!daemon) {
          return fail(type, id, "No daemon bound for this workspace. Run: chavez headless workspace open");
        }
        const rel = typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : ".";
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("fs.tree.dispatch", {
            requestId: id,
            path: rel,
            requesterConnectionId: connectionId,
            workspacePath: daemon.path,
          }),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return await treePending.wait(id, type);
      }

      case "fs.tree.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = (msg.metadata || {}) as {
          cwd?: string;
          path?: string;
          entries?: unknown;
          truncated?: unknown;
          error?: unknown;
        };
        const payload = {
          hostname: msg.hostname || null,
          cwd: meta.cwd || msg.path || null,
          path: meta.path || ".",
          entries: Array.isArray(meta.entries) ? meta.entries.slice(0, 200) : [],
          truncated: Boolean(meta.truncated),
          error: typeof meta.error === "string" ? meta.error : undefined,
        };
        const forwarded = treePending.complete(
          msg.requestId,
          ok("fs.tree", msg.requestId, payload),
        );
        return ok(type, id, { forwarded });
      }

      case "agent.turn.request": {
        if (!msg.chatId || !msg.prompt?.trim()) {
          return fail(type, id, "chatId and prompt are required");
        }
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, NOT_FOUND_CHAT);
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) {
          return fail(type, id, NO_DAEMON_ERROR);
        }
        if (daemon.turnBusy) {
          return fail(type, id, TURN_BUSY_ERROR);
        }
        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId))
          .limit(1);
        const workspace = wsRows[0];
        const prefRows = await db
          .select()
          .from(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .limit(1);
        const executionMode = isExecutionMode(prefRows[0]?.activeExecutionMode)
          ? prefRows[0]!.activeExecutionMode
          : DEFAULT_EXECUTION_MODE;

        hub.setTurnBusy(daemon.connectionId, true, msg.chatId);
        broadcast(userId, "agent.turn.started", {
          chatId: msg.chatId,
          daemonConnectionId: daemon.connectionId,
          hostname: daemon.hostname,
          path: daemon.path,
        });
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("agent.turn.dispatch", {
            chatId: msg.chatId,
            prompt: msg.prompt.trim(),
            requestId: id,
            workspaceId: ctx.workspaceId,
            path: workspace?.path || daemon.path,
            hostname: daemon.hostname,
            daemonConnectionId: daemon.connectionId,
            sessionId: ctx.session.id,
            requesterConnectionId: connectionId,
            executionMode,
            mentions: Array.isArray(msg.metadata?.mentions)
              ? (msg.metadata!.mentions as unknown[]).filter(
                  (x) => typeof x === "string",
                )
              : undefined,
          }),
        );
        if (!sent) {
          hub.setTurnBusy(daemon.connectionId, false);
          return fail(type, id, "Daemon connection unavailable");
        }
        return ok(type, id, {
          accepted: true,
          daemonConnectionId: daemon.connectionId,
        });
      }

      case "agent.turn.cancel": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, NOT_FOUND_CHAT);
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        const wasRunning = Boolean(
          daemon.turnBusy && daemon.turnChatId === msg.chatId,
        );
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("agent.turn.cancel", {
            chatId: msg.chatId,
            requestId: id,
          }),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return ok(type, id, { cancelled: true, wasRunning });
      }

      case "agent.turn.started": {
        hub.setTurnBusy(connectionId, true, msg.chatId ?? null);
        broadcast(userId, "agent.turn.started", {
          chatId: msg.chatId,
          connectionId,
        });
        return ok(type, id, { busy: true });
      }
      case "agent.turn.ended": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, NOT_FOUND_CHAT);
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (daemon) hub.setTurnBusy(daemon.connectionId, false);
        const payload = { chatId: msg.chatId, streamId: msg.streamId };
        broadcast(userId, "agent.turn.ended", payload);
        return ok(type, id, payload);
      }
      case "agent.tool.approve":
      case "agent.tool.deny": {
        if (!msg.chatId || !msg.toolCallId) {
          return fail(type, id, "chatId and toolCallId are required");
        }
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, "Chat not found");
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        const existing = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatId, msg.chatId))
          .orderBy(desc(chatMessages.createdAt));
        const toolRow = existing.find((m) => {
          const meta = (m.metadata || {}) as Record<string, unknown>;
          return m.role === "tool" && meta.toolCallId === msg.toolCallId;
        });
        if (!toolRow) return fail(type, id, "Tool call not found");
        const st = String(
          ((toolRow.metadata || {}) as Record<string, unknown>).status || "",
        );
        if (st !== "awaiting_approval") {
          return fail(type, id, "No tool awaiting approval");
        }
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent(type, {
            chatId: msg.chatId,
            toolCallId: msg.toolCallId,
            requesterConnectionId: connectionId,
          }),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return ok(type, id, { forwarded: true });
      }

      case "chat.diff.upsert": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const parsed = parseDiffUpsert(
          (msg.diff as Record<string, unknown>) ||
            (msg.metadata?.diff as Record<string, unknown>) ||
            {},
        );
        if ("error" in parsed) return fail(type, id, parsed.error);
        const now = new Date();
        const existing = await db
          .select()
          .from(turnFileDiffs)
          .where(
            and(
              eq(turnFileDiffs.chatId, msg.chatId),
              eq(turnFileDiffs.streamId, msg.streamId),
              eq(turnFileDiffs.path, parsed.path),
            ),
          )
          .limit(1);
        let row;
        if (existing[0]) {
          await db
            .update(turnFileDiffs)
            .set({
              kind: parsed.kind,
              status: parsed.status,
              toolCallId: parsed.toolCallId,
              additions: parsed.additions,
              deletions: parsed.deletions,
              preview: parsed.preview,
              body: parsed.body,
              truncated: parsed.truncated,
              binary: parsed.binary,
              omitted: parsed.omitted,
              byteSize: parsed.byteSize,
              updatedAt: now,
            })
            .where(eq(turnFileDiffs.id, existing[0].id));
          row = { ...existing[0], ...parsed, streamId: msg.streamId, chatId: msg.chatId, updatedAt: now };
        } else {
          row = {
            id: crypto.randomUUID(),
            chatId: msg.chatId,
            userId,
            streamId: msg.streamId,
            toolCallId: parsed.toolCallId,
            path: parsed.path,
            kind: parsed.kind,
            status: parsed.status,
            additions: parsed.additions,
            deletions: parsed.deletions,
            preview: parsed.preview,
            body: parsed.body,
            truncated: parsed.truncated,
            binary: parsed.binary,
            omitted: parsed.omitted,
            byteSize: parsed.byteSize,
            createdAt: now,
            updatedAt: now,
          };
          await db.insert(turnFileDiffs).values(row);
        }
        const preview = toPreview(row);
        if (visibleStatus(preview.status)) {
          broadcast(userId, "chat.diff.upsert", {
            chatId: msg.chatId,
            streamId: msg.streamId,
            diff: preview,
          });
        } else {
          // rejected: tell observers to drop this path from the live set
          broadcast(userId, "chat.diff.upsert", {
            chatId: msg.chatId,
            streamId: msg.streamId,
            diff: preview,
            dropped: true,
          });
        }
        return ok(type, id, { diff: preview });
      }

      case "chat.diff.get": {
        const diffId = msg.diffId;
        if (!msg.chatId || !diffId) {
          return fail(type, id, "chatId and diffId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const rows = await db
          .select()
          .from(turnFileDiffs)
          .where(
            and(
              eq(turnFileDiffs.id, diffId),
              eq(turnFileDiffs.chatId, msg.chatId),
              eq(turnFileDiffs.userId, userId),
            ),
          )
          .limit(1);
        if (!rows[0]) return fail(type, id, "Diff not found");
        const preview = toPreview(rows[0]);
        return ok(type, id, {
          diff: {
            ...preview,
            body: rows[0].omitted ? null : rows[0].body ?? rows[0].preview,
            omitted: rows[0].omitted,
          },
        });
      }

      default:
        return fail(type, id, `Unknown type: ${type}`);
    }
  } catch (err) {
    return fail(type, id, err instanceof Error ? err.message : String(err));
  }
}
