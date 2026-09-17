import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  chatMessages,
  chats,
  turnFileDiffs,
  userPreferences,
  userRules,
  userSkills,
  workspaces,
} from "../db/schema";
import {
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
} from "../llm/execution-mode";
import { hub } from "./hub";
import {
  completeSteerResult,
  createPendingMap,
  waitSteerResult,
} from "./pending";
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
  isRunningToolMeta,
  isToolStatus,
  truncateToolText,
} from "./tool-protocol";
import {
  NO_DAEMON_ERROR,
  NOT_FOUND_CHAT,
  STEER_EMPTY,
  STEER_MAX_CHARS,
  STEER_NO_TURN,
  STEER_TOO_LONG,
  TURN_BUSY_ERROR,
  TURN_CANCELLED,
} from "./errors";
import { presenceFromDaemon } from "./heartbeat";
import { assignDaemonRole } from "./bind-role";
import { markOnboardingComplete } from "../onboarding/build";
import { ONBOARDING_EVENT } from "../onboarding/status";
import { redactJson, redactText } from "../lib/redact";
import { parseDiffUpsert, toPreview, visibleStatus } from "./diff-protocol";
import { decideResolveGate } from "../llm/approval-resolve";
import { retryPayloadFromMessages } from "../llm/retry-payload";
import { selectLastTurn, type ChatRow } from "../llm/turn-select";
import { gateUndo } from "../llm/undo-decide";
import { UNDO_NOOP, UNDO_TIMEOUT_MS } from "../llm/undo-constants";
import { contextForMessages } from "../llm/context-chat";
import { defaultClaudeModelId } from "../llm/catalog";
import {
  mergeAssistantMetadata,
  shouldPersistCancelledAssistant,
} from "./thinking-meta";
import {
  PLAN_ARTIFACT_KIND,
  PLAN_CREATED_EVENT,
  PLAN_UPDATED_EVENT,
  PLAN_APPLIED_EVENT,
  PLAN_CURRENT_EVENT,
  PLAN_STATUS_CURRENT,
  NO_CURRENT_PLAN,
  PLAN_NOT_FOUND,
  PLAN_EMPTY_ERROR,
  PLAN_NOT_IN_CHAT,
  asPlanMeta,
  bumpRevision,
  consumePending,
  currentPlanId,
  extractPlanMarkdown,
  isPlanArtifact,
  markPendingApply,
  newPlanMeta,
  pendingApplyPlan,
  promoteCurrent,
  resolveApplyMode,
  validatePlanMarkdown,
} from "../llm/plan-artifact";
import { aggregateChatUsage } from "../llm/usage-codec";
import {
  prepareStreamEndMeta,
  shouldPersistAssistant,
} from "../llm/usage-persist";
import { usageForMessages } from "../llm/usage-chat";
import {
  formatMcpFailedSystem,
  preserveToolMetadata,
} from "./mcp-protocol";

const fsPending = createPendingMap(5000);
const treePending = createPendingMap(5000);
const fsRpcPending = treePending;
const undoPending = createPendingMap(UNDO_TIMEOUT_MS);
const gitPending = createPendingMap(90_000);
const rulesPending = createPendingMap(5_000);
const mcpPending = createPendingMap(5_000);
const skillsPending = createPendingMap(5_000);
const compactPending = createPendingMap(90_000);
const resolvingApproval = new Set<string>();
const undoInflight = new Set<string>();
const VERIFY_TIMEOUT_ERROR = "Verification timed out after 120s";

function approvalKey(chatId: string, toolCallId: string): string {
  return `${chatId}:${toolCallId}`;
}

function asMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function topLevelToolMetadata(msg: ClientMessage): Record<string, unknown> {
  return {
    ...(msg.parentToolCallId
      ? { parentToolCallId: msg.parentToolCallId }
      : {}),
    ...(msg.subagentId ? { subagentId: msg.subagentId } : {}),
  };
}

async function activeModelForUser(userId: string): Promise<{
  providerId: string;
  modelId: string;
}> {
  const rows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const providerId = rows[0]?.activeProvider || "claude";
  const modelId =
    rows[0]?.activeModel || defaultClaudeModelId() || "claude-opus-4-6";
  return { providerId, modelId };
}

async function loadToolRow(chatId: string, toolCallId: string) {
  const existing = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.createdAt));
  return existing.find((m) => {
    const meta = asMeta(m.metadata);
    return m.role === "tool" && meta.toolCallId === toolCallId;
  });
}

function requireWorkspace(connectionId: string): string {
  const conn = hub.get(connectionId);
  if (!conn?.workspaceId) {
    throw new Error("Workspace not bound. Send workspace.bind first.");
  }
  return conn.workspaceId;
}

async function forwardGit(
  connectionId: string,
  userId: string,
  id: string,
  type: string,
  action: NonNullable<ClientMessage["action"]>,
  msg: ClientMessage,
): Promise<ServerMessage> {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
  const conn = hub.get(connectionId);
  const mutate =
    action === "commit" ||
    action === "push" ||
    action === "pr" ||
    action === "branch";
  if (mutate && daemon.turnBusy) {
    return fail(type, id, TURN_BUSY_ERROR);
  }
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent("workspace.git.dispatch", {
      requestId: id,
      action,
      path: daemon.path || conn?.path,
      workspaceId,
      payload: {
        message: msg.message || msg.title,
        paths: msg.paths,
        title: msg.title,
        body: msg.body || msg.content,
        base: msg.base,
        name: msg.name,
        remote: msg.remote,
        force: msg.force,
        allowProtected: msg.metadata?.allowProtected === true,
      },
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return gitPending.wait(id, type);
}

async function loadChatForUser(chatId: string, userId: string) {
  const chatRows = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  return chatRows[0] ?? null;
}

async function patchMessagesByStream(
  chatId: string,
  streamId: string,
  patch: Record<string, unknown>,
) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId));
  for (const row of rows) {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const sid =
      (typeof meta.streamId === "string" && meta.streamId) ||
      (meta.checkpoint &&
      typeof meta.checkpoint === "object" &&
      meta.checkpoint &&
      "streamId" in meta.checkpoint
        ? String((meta.checkpoint as { streamId?: string }).streamId || "")
        : "");
    if (sid !== streamId) continue;
    if (row.role !== "user" && row.role !== "assistant") continue;
    const metadata = { ...meta, ...patch };
    if (patch.checkpoint && meta.checkpoint && typeof meta.checkpoint === "object") {
      metadata.checkpoint = {
        ...(meta.checkpoint as Record<string, unknown>),
        ...(patch.checkpoint as Record<string, unknown>),
      };
    }
    await db
      .update(chatMessages)
      .set({ metadata })
      .where(eq(chatMessages.id, row.id));
  }
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
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

async function userRulesStamp(
  userId: string,
  workspace: typeof workspaces.$inferSelect | undefined,
) {
  const userRulesEnabled = workspace?.userRulesEnabled !== false;
  const userRuleRows =
    workspace?.userRulesEnabled === false
      ? []
      : await db
          .select()
          .from(userRules)
          .where(eq(userRules.userId, userId));
  return {
    userRulesEnabled,
    userRules: userRuleRows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      enabled: r.enabled,
      disallowTools: r.disallowTools ?? [],
      allowTools: r.allowTools ?? [],
    })),
  };
}

async function enabledUserSkills(userId: string) {
  const rows = await db
    .select()
    .from(userSkills)
    .where(eq(userSkills.userId, userId));
  return rows
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      enabled: skill.enabled,
    }));
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
  status: "error" | "cancelled",
  reason: string,
) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId));
  for (const row of rows) {
    if (row.role !== "tool") continue;
    const prev = asToolMeta(row.metadata);
    if (!isRunningToolMeta(prev)) continue;
    const metadata = { ...prev, status, output: reason };
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

async function loadMessages(chatId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt));
}

async function writePlanMeta(
  row: { id: string; content: string; metadata: unknown },
  meta: Record<string, unknown>,
  content?: string,
) {
  const nextContent = content !== undefined ? content : row.content;
  await db
    .update(chatMessages)
    .set({ content: nextContent, metadata: meta })
    .where(eq(chatMessages.id, row.id));
  return { ...row, content: nextContent, metadata: meta };
}

async function persistPromote(chatId: string, newId: string) {
  const rows = await loadMessages(chatId);
  const promoted = promoteCurrent(
    rows.map((r) => ({
      id: r.id,
      chatId: r.chatId,
      role: r.role,
      content: r.content,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
    newId,
  );
  for (const row of promoted) {
    const prev = rows.find((r) => r.id === row.id);
    if (!prev) continue;
    const prevMeta = JSON.stringify(prev.metadata ?? null);
    const nextMeta = JSON.stringify(row.metadata ?? null);
    if (prevMeta !== nextMeta) {
      await db
        .update(chatMessages)
        .set({ metadata: row.metadata as Record<string, unknown> })
        .where(eq(chatMessages.id, row.id));
    }
  }
}

function publicPlan(row: {
  id: string;
  chatId: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
}) {
  return {
    ...row,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

function planRowsFromMessages(
  messages: Array<{ id: string; content?: string | null; metadata: unknown }>,
) {
  return messages.map((m) => ({
    id: m.id,
    content: m.content,
    metadata: (m.metadata as Record<string, unknown> | null) ?? null,
  }));
}

async function proxyFsToDaemon(
  connectionId: string,
  userId: string,
  type: string,
  id: string,
  pushType: string,
  extra: Record<string, unknown>,
): Promise<ServerMessage> {
  const workspaceId = requireWorkspace(connectionId);
  const daemon = hub.findDaemon(userId, workspaceId);
  if (!daemon) {
    return fail(
      type,
      id,
      "No daemon bound for this workspace. Run: chavez headless workspace open",
    );
  }
  const sent = hub.sendTo(
    daemon.connectionId,
    hub.pushEvent(pushType, {
      requestId: id,
      requesterConnectionId: connectionId,
      workspacePath: daemon.path,
      ...extra,
    }),
  );
  if (!sent) return fail(type, id, "Daemon connection unavailable");
  return await fsRpcPending.wait(id, type);
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
    hub.touch(connectionId);
    switch (type) {
      case "ping":
        return ok("pong", id, { t: Date.now() });

      case "daemon.heartbeat": {
        const conn = hub.get(connectionId);
        if (!conn) return fail(type, id, "Unknown connection");
        hub.touch(connectionId);
        if (typeof msg.daemonId === "string" && msg.daemonId.trim()) {
          hub.setDaemonId(connectionId, msg.daemonId.trim());
        }
        return ok(type, id, {
          t: Date.now(),
          lastSeen: hub.get(connectionId)?.lastSeen ?? null,
          role: conn.role,
        });
      }

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

        const hostname =
          typeof msg.hostname === "string" && msg.hostname.trim()
            ? msg.hostname.trim()
            : null;
        hub.setHostname(connectionId, hostname);

        const daemonId =
          typeof msg.daemonId === "string" && msg.daemonId.trim()
            ? msg.daemonId.trim()
            : null;
        hub.setDaemonId(connectionId, daemonId);

        let role: "primary" | "standby" | "client" = "client";
        let standbyReason: string | undefined;
        let reclaimed = false;

        if (clientKind === "daemon") {
          const assigned = assignDaemonRole({
            connectionId,
            userId,
            workspaceId: workspace.id,
            daemonId,
          });
          role = assigned.role;
          standbyReason = assigned.standbyReason;
          reclaimed = assigned.reclaimed;
        } else {
          hub.setRole(connectionId, "client");
        }

        const primary = hub.findDaemon(userId, workspace.id);
        broadcast(
          userId,
          "daemon.presence",
          presenceFromDaemon(
            workspace.id,
            primary,
            reclaimed ? "reclaim" : "bind",
          ),
        );

        return ok(type, id, {
          workspace,
          clientKind,
          hostname: hub.get(connectionId)?.hostname ?? null,
          daemonId: hub.get(connectionId)?.daemonId ?? null,
          role,
          primaryConnectionId: primary?.connectionId ?? connectionId,
          standbyReason,
          reclaimed,
        });
      }

      case "workspace.unbind": {
        const conn = hub.get(connectionId);
        const wasDaemon = conn?.clientKind === "daemon";
        const workspaceId = conn?.workspaceId;
        hub.setWorkspace(connectionId, null, null);
        hub.setClientKind(connectionId, "client");
        hub.setRole(connectionId, "client");
        hub.setDaemonId(connectionId, null);
        if (wasDaemon && workspaceId) {
          const next = hub.findDaemon(userId, workspaceId);
          broadcast(
            userId,
            "daemon.presence",
            presenceFromDaemon(workspaceId, next, "unbind"),
          );
        }
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
        const messages = await loadMessages(msg.chatId);
        const diffs = await listVisibleDiffs(msg.chatId, userId);
        const active = await activeModelForUser(userId);
        const context = contextForMessages(
          messages,
          active.providerId,
          active.modelId,
        );
        return ok(type, id, {
          chat,
          messages,
          diffs,
          context,
          usage: usageForMessages(messages),
          currentPlanArtifactId: currentPlanId(planRowsFromMessages(messages)),
        });
      }

      case "chat.context.report": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const context = msg.metadata || {};
        broadcast(userId, "chat.context.usage", {
          chatId: msg.chatId,
          context,
        });
        return ok(type, id, { ok: true });
      }

      case "chat.compact": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, "Chat not found");
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId))
          .limit(1);
        const workspace = wsRows[0];
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("chat.compact.dispatch", {
            chatId: msg.chatId,
            requestId: id,
            requesterConnectionId: connectionId,
            path: workspace?.path || daemon.path,
            trigger: "manual",
          }),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return await compactPending.wait(id, type);
      }

      case "chat.compact.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = asMeta(msg.metadata);
        const chatId = String(msg.chatId || meta.chatId || "");
        if (meta.ok === false) {
          compactPending.complete(
            msg.requestId,
            fail(
              "chat.compact",
              msg.requestId,
              String(meta.error || "compact failed"),
            ),
          );
          return ok(type, id, { forwarded: true });
        }
        const context = meta.context;
        if (meta.skipped) {
          compactPending.complete(
            msg.requestId,
            ok("chat.compact", msg.requestId, {
              skipped: true,
              reason: meta.reason,
              context,
            }),
          );
          return ok(type, id, { forwarded: true });
        }
        let message: unknown;
        if (chatId) {
          const rows = await db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.chatId, chatId))
            .orderBy(desc(chatMessages.createdAt));
          message = rows.find((m) => asMeta(m.metadata).kind === "compact_marker");
        }
        broadcast(userId, "chat.compact.done", { chatId, message, context });
        if (context) {
          broadcast(userId, "chat.context.usage", { chatId, context });
        }
        compactPending.complete(
          msg.requestId,
          ok("chat.compact", msg.requestId, { skipped: false, context }),
        );
        return ok(type, id, { forwarded: true });
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

      case "chat.thinking.delta": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          delta: msg.delta ?? msg.content ?? "",
        };
        broadcast(userId, "chat.thinking.delta", payload);
        return ok(type, id, payload);
      }

      case "chat.thinking.end": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          omitted: Boolean(msg.metadata?.omitted),
          durationMs: msg.metadata?.durationMs,
        };
        broadcast(userId, "chat.thinking.end", payload);
        return ok(type, id, payload);
      }

      case "chat.stream.end": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const status = msg.status === "cancelled" ? "cancelled" : "finished";
        let message = null;
        const content = msg.content?.trim()
          ? redactText(msg.content.trim())
          : "";
        const cleaned = prepareStreamEndMeta(
          msg.metadata ? redactJson(msg.metadata) : {},
        );
        if (status === "cancelled") {
          await failRunningTools(
            userId,
            msg.chatId,
            "cancelled",
            TURN_CANCELLED,
          );
          await db
            .update(turnFileDiffs)
            .set({ status: "rejected", updatedAt: new Date() })
            .where(
              and(
                eq(turnFileDiffs.chatId, msg.chatId),
                eq(turnFileDiffs.userId, userId),
                eq(turnFileDiffs.streamId, msg.streamId),
                eq(turnFileDiffs.status, "proposed"),
              ),
            );
        }
        if (
          shouldPersistAssistant(content, cleaned) ||
          shouldPersistCancelledAssistant({
            content,
            metadata: cleaned,
            status,
          })
        ) {
          const now = new Date();
          message = {
            id: crypto.randomUUID(),
            chatId: msg.chatId,
            role: "assistant",
            content: content || "",
            metadata: mergeAssistantMetadata({
              streamId: msg.streamId,
              status,
              metadata: cleaned,
            }),
            createdAt: now,
          };
          await db.insert(chatMessages).values(message);
          await db
            .update(chats)
            .set({ updatedAt: now })
            .where(eq(chats.id, msg.chatId));

          if (content) {
            const rows = await loadMessages(msg.chatId);
            const lastUser = [...rows].reverse().find((m) => m.role === "user");
            const lastUserMode = asMeta(lastUser?.metadata).executionMode;
            const shouldPlan =
              isPlanArtifact(message.metadata) ||
              asMeta(message.metadata).executionMode === "plan" ||
              lastUserMode === "plan";
            const extracted = shouldPlan ? extractPlanMarkdown(content) : "";
            if (shouldPlan && extracted) {
              const nextContent = extracted !== content ? extracted : content;
              const meta = {
                ...newPlanMeta(msg.streamId),
                ...asMeta(message.metadata),
                kind: PLAN_ARTIFACT_KIND,
                status: PLAN_STATUS_CURRENT,
                revision: 1,
                pendingApply: false,
                executionMode: "plan" as const,
                streamId: msg.streamId,
              };
              await db
                .update(chatMessages)
                .set({ content: nextContent, metadata: meta })
                .where(eq(chatMessages.id, message.id));
              await persistPromote(msg.chatId, message.id);
              const fresh = await db
                .select()
                .from(chatMessages)
                .where(eq(chatMessages.id, message.id))
                .limit(1);
              message = fresh[0] ?? {
                ...message,
                content: nextContent,
                metadata: meta,
              };
              broadcast(userId, "message.appended", {
                message,
                chatId: msg.chatId,
              });
              broadcast(userId, PLAN_CREATED_EVENT, {
                chatId: msg.chatId,
                message,
                currentPlanArtifactId: message.id,
              });
            } else {
              broadcast(userId, "message.appended", {
                message,
                chatId: msg.chatId,
              });
            }
          } else {
            broadcast(userId, "message.appended", {
              message,
              chatId: msg.chatId,
            });
          }
        }
        let usageView = undefined;
        try {
          const rows = await db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.chatId, msg.chatId))
            .orderBy(asc(chatMessages.createdAt));
          usageView = aggregateChatUsage(rows);
        } catch {
          usageView = undefined;
        }
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          status,
          message,
          usage: usageView,
          verification: cleaned.verification ?? null,
        };
        broadcast(userId, "chat.stream.end", payload);
        return ok(type, id, payload);
      }

      case "chat.stream.error": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const cancelled =
          msg.content === TURN_CANCELLED ||
          msg.status === "cancelled" ||
          msg.metadata?.status === "cancelled";
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          error: msg.content || "stream error",
          ...(msg.content === VERIFY_TIMEOUT_ERROR
            ? { reason: "verify_timeout" }
            : {}),
        };
        broadcast(userId, "chat.stream.error", payload);
        if (cancelled) {
          const normalized = await handleWsMessage(
            connectionId,
            userId,
            JSON.stringify({
              ...msg,
              type: "chat.stream.end",
              id: `${id}:cancelled`,
              status: "cancelled",
            }),
          );
          if (!normalized.ok) return fail(type, id, normalized.error || TURN_CANCELLED);
          return ok(type, id, {
            ...payload,
            status: "cancelled",
            message: (normalized.data as { message?: unknown } | undefined)
              ?.message,
          });
        }
        await failRunningTools(
          userId,
          msg.chatId,
          "error",
          payload.error,
        );
        return ok(type, id, payload);
      }

      case "chat.mcp.status": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const rawServers = asMeta(msg.metadata).servers;
        const servers = Array.isArray(rawServers)
          ? (redactJson(rawServers) as Array<Record<string, unknown>>)
          : [];
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          servers,
        };
        broadcast(userId, "chat.mcp.status", payload);

        const content = formatMcpFailedSystem(servers);
        if (content) {
          const now = new Date();
          const message = {
            id: crypto.randomUUID(),
            chatId: msg.chatId,
            role: "system",
            content,
            metadata: { kind: "mcp_status", servers },
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
        return ok(type, id, payload);
      }

      case "chat.skill.activated": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const metadata = asMeta(msg.metadata);
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          name: metadata.name,
          layer: metadata.layer,
          source: metadata.source,
        };
        broadcast(userId, "chat.skill.activated", payload);
        return ok(type, id, payload);
      }

      case "chat.subagent.start":
      case "chat.subagent.update":
      case "chat.subagent.end": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const metadata = asMeta(msg.metadata);
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          ...metadata,
          toolCallId: msg.toolCallId ?? metadata.toolCallId,
          subagentId: msg.subagentId ?? metadata.subagentId,
          parentToolCallId:
            msg.parentToolCallId ?? metadata.parentToolCallId,
        };
        broadcast(userId, type, payload);
        return ok(type, id, payload);
      }

      case "chat.capability.degraded": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const now = new Date();
        const message = {
          id: crypto.randomUUID(),
          chatId: msg.chatId,
          role: "system",
          content: redactText(
            msg.content?.trim() || "Provider capability degraded",
          ),
          metadata: {
            kind: "capability_degraded",
            ...(redactJson(asMeta(msg.metadata)) as Record<string, unknown>),
          },
          createdAt: now,
        };
        await db.insert(chatMessages).values(message);
        await db
          .update(chats)
          .set({ updatedAt: now })
          .where(eq(chats.id, msg.chatId));
        broadcast(userId, "chat.capability.degraded", {
          chatId: msg.chatId,
          message,
        });
        broadcast(userId, "message.appended", {
          chatId: msg.chatId,
          message,
        });
        return ok(type, id, { message });
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
          metadata: preserveToolMetadata(redactedMeta, {
            ...topLevelToolMetadata(msg),
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            sdkName: redactedMeta.sdkName ?? msg.toolName,
            status: isToolStatus(msg.status) ? msg.status : "running",
            input: redactedMeta.input ?? null,
            streamId: msg.streamId ?? redactedMeta.streamId ?? null,
          }),
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
          const metadata = preserveToolMetadata(
            applyToolResult(prev, {
              status: msg.status,
              output: msg.content ? redactText(msg.content) : msg.content,
              input: redactedMeta.input,
              toolName: msg.toolName,
            }),
            preserveToolMetadata(redactedMeta, topLevelToolMetadata(msg)),
          );
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
        const metadata = preserveToolMetadata(
          applyToolResult(
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
          ),
          preserveToolMetadata(fallbackMeta, topLevelToolMetadata(msg)),
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
        const prev = asMeta(toolRow.metadata);
        const incoming = (msg.metadata || {}) as Record<string, unknown>;
        const metadata = {
          ...preserveToolMetadata(
            preserveToolMetadata(prev, incoming),
            topLevelToolMetadata(msg),
          ),
          toolCallId: prev.toolCallId,
          toolName: prev.toolName ?? incoming.toolName,
          status: isToolStatus(msg.status) ? msg.status : prev.status,
          input: incoming.input !== undefined ? incoming.input : prev.input,
          output:
            msg.content != null && msg.content !== ""
              ? truncateToolText(String(msg.content))
              : prev.output,
          approvalDeadline:
            incoming.approvalDeadline !== undefined
              ? incoming.approvalDeadline
              : prev.approvalDeadline,
          prompt:
            incoming.prompt !== undefined ? incoming.prompt : prev.prompt,
          resolution:
            incoming.resolution !== undefined
              ? incoming.resolution
              : prev.resolution,
        };
        await db
          .update(chatMessages)
          .set({ metadata })
          .where(eq(chatMessages.id, toolRow.id));
        const message = { ...toolRow, metadata };
        broadcast(userId, "chat.tool.update", { message, chatId: msg.chatId });
        if (
          metadata.status === "error" &&
          metadata.resolution === "timeout"
        ) {
          broadcast(userId, "chat.tool.resolved", {
            chatId: msg.chatId,
            toolCallId: msg.toolCallId,
            outcome: "timeout",
            resolvedBy: "timeout",
          });
        }
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
        const rel =
          typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : ".";
        return await proxyFsToDaemon(
          connectionId,
          userId,
          type,
          id,
          "fs.tree.dispatch",
          { path: rel },
        );
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
        const forwarded = fsRpcPending.complete(
          msg.requestId,
          ok("fs.tree", msg.requestId, payload),
        );
        return ok(type, id, { forwarded });
      }

      case "fs.search": {
        const q = String(msg.query ?? "");
        return await proxyFsToDaemon(
          connectionId,
          userId,
          type,
          id,
          "fs.search.dispatch",
          { query: q, limit: 50 },
        );
      }

      case "fs.search.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = (msg.metadata || {}) as {
          cwd?: string;
          query?: string;
          matches?: unknown;
          truncated?: unknown;
          error?: unknown;
        };
        const matches = Array.isArray(meta.matches) ? meta.matches.slice(0, 50) : [];
        const payload = {
          hostname: msg.hostname || null,
          cwd: meta.cwd || msg.path || null,
          query: typeof meta.query === "string" ? meta.query : "",
          matches,
          truncated: Boolean(meta.truncated),
          error: typeof meta.error === "string" ? meta.error : undefined,
        };
        const forwarded = fsRpcPending.complete(
          msg.requestId,
          ok("fs.search", msg.requestId, payload),
        );
        return ok(type, id, { forwarded });
      }

      case "fs.preview": {
        const rel =
          typeof msg.path === "string" && msg.path.trim() ? msg.path.trim() : "";
        if (!rel || rel === ".") {
          return fail(type, id, "path is required");
        }
        return await proxyFsToDaemon(
          connectionId,
          userId,
          type,
          id,
          "fs.preview.dispatch",
          { path: rel },
        );
      }

      case "fs.preview.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = (msg.metadata || {}) as Record<string, unknown>;
        const kind = String(meta.kind || "binary");
        const payload: Record<string, unknown> = {
          hostname: msg.hostname || null,
          cwd: meta.cwd || msg.path || null,
          path: meta.path || "",
          kind,
          status: String(meta.status || "ok"),
          byteSize: typeof meta.byteSize === "number" ? meta.byteSize : 0,
          mime: meta.mime,
          truncated: Boolean(meta.truncated),
          mediaType: meta.mediaType,
          listing: Array.isArray(meta.listing) ? meta.listing.slice(0, 10) : undefined,
          notice: typeof meta.notice === "string" ? meta.notice : undefined,
          error: typeof meta.error === "string" ? meta.error : undefined,
        };
        if (kind === "text" && typeof meta.text === "string") {
          payload.text = meta.text;
        }
        if (kind === "image" && typeof meta.imageBase64 === "string") {
          payload.imageBase64 = meta.imageBase64;
        }
        const forwarded = fsRpcPending.complete(
          msg.requestId,
          ok("fs.preview", msg.requestId, payload),
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
        const rulesStamp = await userRulesStamp(userId, workspace);
        const userSkillsPayload = await enabledUserSkills(userId);

        hub.setTurnBusy(daemon.connectionId, true, msg.chatId);
        broadcast(userId, "agent.turn.started", {
          chatId: msg.chatId,
          daemonConnectionId: daemon.connectionId,
          hostname: daemon.hostname,
          path: daemon.path,
        });
        const mentions = Array.isArray(msg.mentions)
          ? msg.mentions.filter((x) => typeof x === "string")
          : Array.isArray(msg.metadata?.mentions)
            ? (msg.metadata!.mentions as unknown[]).filter(
                (x) => typeof x === "string",
              )
            : undefined;
        const attachments = Array.isArray(msg.attachments)
          ? msg.attachments
          : Array.isArray(msg.metadata?.attachments)
            ? (msg.metadata!.attachments as unknown[])
            : undefined;
        const turnRows = await loadMessages(msg.chatId);
        const pending = pendingApplyPlan(planRowsFromMessages(turnRows));
        const planBrief = pending ? String(pending.content || "") : "";
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("agent.turn.dispatch", {
            chatId: msg.chatId,
            prompt: msg.prompt.trim(),
            requestId: id,
            workspaceId: ctx.workspaceId,
            path: workspace?.path || daemon.path,
            hostname: daemon.hostname,
            daemonId: daemon.daemonId,
            daemonConnectionId: daemon.connectionId,
            sessionId: ctx.session.id,
            requesterConnectionId: connectionId,
            executionMode,
            mentions,
            attachments,
            retryOfStreamId: msg.retryOfStreamId,
            userRulesEnabled: rulesStamp.userRulesEnabled,
            userRules: rulesStamp.userRules,
            userSkills: userSkillsPayload,
            planBrief: planBrief || undefined,
            planArtifactId: pending?.id,
          }),
        );
        if (!sent) {
          hub.setTurnBusy(daemon.connectionId, false);
          return fail(type, id, "Daemon connection unavailable");
        }
        void markOnboardingComplete(userId)
          .then((snap) => {
            broadcast(userId, ONBOARDING_EVENT, snap);
          })
          .catch(() => {
            /* onboarding must not fail the turn */
          });
        return ok(type, id, {
          accepted: true,
          daemonConnectionId: daemon.connectionId,
        });
      }

      case "agent.turn.steer": {
        const content = (msg.content || "").trim();
        if (!msg.chatId) return fail(type, id, "chatId is required");
        if (!content) return fail(type, id, STEER_EMPTY);
        if (content.length > STEER_MAX_CHARS) {
          return fail(type, id, STEER_TOO_LONG);
        }
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, NOT_FOUND_CHAT);
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        if (daemon.turnBusy === false) {
          return fail(type, id, STEER_NO_TURN);
        }
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("agent.turn.steer.dispatch", {
            chatId: msg.chatId,
            content,
            requestId: id,
          }),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return await waitSteerResult(id);
      }

      case "agent.turn.steer.result": {
        const requestId = msg.requestId || id;
        const outcome =
          (msg.metadata?.outcome as string) || (msg.status as string) || "";
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          outcome,
          content: msg.content,
          reason: (msg.metadata?.reason as string) || undefined,
        };
        broadcast(userId, "chat.steer", payload);
        const reply = ok("agent.turn.steer", requestId, payload);
        completeSteerResult(requestId, reply);
        return reply;
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
        const payload = {
          chatId: msg.chatId,
          streamId: msg.streamId,
          status: msg.status,
          error: typeof msg.status === "string" ? msg.status : undefined,
        };
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

        const toolRow = await loadToolRow(msg.chatId, msg.toolCallId);
        if (!toolRow) return fail(type, id, "Tool call not found");
        const meta = asMeta(toolRow.metadata);
        const key = approvalKey(msg.chatId, msg.toolCallId);
        const gate = decideResolveGate({
          status: String(meta.status || ""),
          resolution: typeof meta.resolution === "string" ? meta.resolution : null,
          inflight: resolvingApproval.has(key),
        });
        if (!gate.ok) return fail(type, id, gate.error);

        resolvingApproval.add(key);
        try {
          const outcome = type === "agent.tool.approve" ? "approve" : "deny";
          const resolvedAt = new Date().toISOString();
          const nextMeta = {
            ...meta,
            resolution: outcome,
            resolvedBy: connectionId,
            resolvedAt,
          };
          await db
            .update(chatMessages)
            .set({ metadata: nextMeta })
            .where(eq(chatMessages.id, toolRow.id));
          const message = { ...toolRow, metadata: nextMeta };

          const sent = hub.sendTo(
            daemon.connectionId,
            hub.pushEvent(type, {
              chatId: msg.chatId,
              toolCallId: msg.toolCallId,
              requesterConnectionId: connectionId,
              outcome,
            }),
          );
          if (!sent) {
            await db
              .update(chatMessages)
              .set({ metadata: meta })
              .where(eq(chatMessages.id, toolRow.id));
            return fail(type, id, "Daemon connection unavailable");
          }

          broadcast(userId, "chat.tool.update", {
            message,
            chatId: msg.chatId,
          });
          broadcast(userId, "chat.tool.resolved", {
            chatId: msg.chatId,
            toolCallId: msg.toolCallId,
            outcome,
            resolvedBy: connectionId,
          });
          broadcast(userId, "message.appended", {
            message,
            chatId: msg.chatId,
            updated: true,
          });
          return ok(type, id, { forwarded: true, outcome });
        } finally {
          resolvingApproval.delete(key);
        }
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

      case "chat.checkpoint.created":
      case "chat.checkpoint.finalized": {
        if (!msg.chatId || !msg.streamId) {
          return fail(type, id, "chatId and streamId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const checkpoint =
          msg.checkpoint ||
          (msg.metadata?.checkpoint as Record<string, unknown> | undefined);
        await patchMessagesByStream(msg.chatId, msg.streamId, {
          streamId: msg.streamId,
          checkpoint,
        });
        broadcast(userId, type, {
          chatId: msg.chatId,
          streamId: msg.streamId,
          checkpoint,
        });
        return ok(type, id, { patched: true });
      }

      case "agent.turn.undo": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, "Chat not found");
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        const rows = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatId, msg.chatId))
          .orderBy(asc(chatMessages.createdAt));
        const last = selectLastTurn(rows as ChatRow[]);
        const gate = gateUndo({
          last,
          turnBusy: Boolean(daemon.turnBusy),
          inflight: undoInflight.has(msg.chatId),
        });
        if (!gate.ok) return fail(type, id, gate.error);
        if (gate.mode === "noop") {
          const payload = {
            noop: true,
            message: UNDO_NOOP,
            chatId: msg.chatId,
            streamId: last!.streamId,
            restored: [] as string[],
            deleted: [] as string[],
            commitAction: "none" as const,
            reverted: [] as string[],
            warning: null as string | null,
          };
          broadcast(userId, "chat.checkpoint.undone", {
            chatId: msg.chatId,
            streamId: last!.streamId,
            restored: [],
            commitAction: "none",
            warning: null,
            noop: true,
          });
          return ok(type, id, payload);
        }
        undoInflight.add(msg.chatId);
        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, ctx.workspaceId))
          .limit(1);
        const workspace = wsRows[0];
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("agent.turn.undo.dispatch", {
            requestId: id,
            chatId: msg.chatId,
            streamId: last!.streamId,
            checkpoint: last!.checkpoint,
            path: workspace?.path || daemon.path,
          }),
        );
        if (!sent) {
          undoInflight.delete(msg.chatId);
          return fail(type, id, "Daemon connection unavailable");
        }
        try {
          return await undoPending.wait(id, type);
        } finally {
          undoInflight.delete(msg.chatId);
        }
      }

      case "agent.turn.undo.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = asMeta(msg.metadata);
        const chatId = String(meta.chatId || msg.chatId || "");
        const streamId = String(meta.streamId || msg.streamId || "");
        if (msg.status === "error" || meta.ok === false) {
          undoInflight.delete(chatId);
          undoPending.complete(
            msg.requestId,
            fail(
              "agent.turn.undo",
              msg.requestId,
              String(meta.error || "undo failed"),
            ),
          );
          return ok(type, id, { forwarded: true });
        }
        const payload = {
          chatId,
          streamId,
          noop: Boolean(meta.noop),
          message: String(meta.message || ""),
          restored: stringList(meta.restored),
          deleted: stringList(meta.deleted),
          commitAction:
            meta.commitAction === "revert" || meta.commitAction === "warn"
              ? meta.commitAction
              : "none",
          reverted: stringList(meta.reverted),
          warning:
            typeof meta.warning === "string" && meta.warning
              ? meta.warning
              : null,
        };
        if (!payload.noop) {
          await patchMessagesByStream(chatId, streamId, {
            undone: true,
            undoneAt: new Date().toISOString(),
            undo: {
              restored: payload.restored,
              deleted: payload.deleted,
              commitAction: payload.commitAction,
              reverted: payload.reverted,
              warning: payload.warning,
            },
          });
        }
        broadcast(userId, "chat.checkpoint.undone", {
          chatId,
          streamId,
          restored: payload.restored,
          commitAction: payload.commitAction,
          warning: payload.warning,
          noop: payload.noop,
        });
        undoInflight.delete(chatId);
        undoPending.complete(
          msg.requestId,
          ok("agent.turn.undo", msg.requestId, payload),
        );
        return ok(type, id, { forwarded: true });
      }

      case "agent.turn.retry": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const ctx = await workspaceIdForChat(msg.chatId, userId);
        if (!ctx) return fail(type, id, "Chat not found");
        const daemon = hub.findDaemon(userId, ctx.workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        if (daemon.turnBusy) return fail(type, id, TURN_BUSY_ERROR);
        const rows = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatId, msg.chatId))
          .orderBy(asc(chatMessages.createdAt));
        const retry = retryPayloadFromMessages(rows as ChatRow[]);
        if (!retry.ok) return fail(type, id, retry.error);
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
        const rulesStamp = await userRulesStamp(userId, workspace);
        const userSkillsPayload = await enabledUserSkills(userId);
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
            prompt: retry.payload.prompt,
            requestId: id,
            workspaceId: ctx.workspaceId,
            path: workspace?.path || daemon.path,
            hostname: daemon.hostname,
            daemonConnectionId: daemon.connectionId,
            sessionId: ctx.session.id,
            requesterConnectionId: connectionId,
            executionMode,
            mentions: retry.payload.mentions,
            attachments: retry.payload.attachments,
            retryOfStreamId: retry.payload.retryOfStreamId,
            userRulesEnabled: rulesStamp.userRulesEnabled,
            userRules: rulesStamp.userRules,
            userSkills: userSkillsPayload,
          }),
        );
        if (!sent) {
          hub.setTurnBusy(daemon.connectionId, false);
          return fail(type, id, "Daemon connection unavailable");
        }
        return ok(type, id, {
          accepted: true,
          daemonConnectionId: daemon.connectionId,
          retry: true,
          prompt: retry.payload.prompt,
        });
      }

      case "workspace.git.status":
        return await forwardGit(connectionId, userId, id, type, "status", msg);
      case "workspace.git.diff":
        return await forwardGit(connectionId, userId, id, type, "diff", msg);
      case "workspace.git.commit": {
        if (!msg.message?.trim() && !msg.content?.trim()) {
          return fail(type, id, "message is required");
        }
        return await forwardGit(connectionId, userId, id, type, "commit", msg);
      }
      case "workspace.git.push":
        return await forwardGit(connectionId, userId, id, type, "push", msg);
      case "workspace.git.pr": {
        if (!msg.title?.trim()) return fail(type, id, "title is required");
        return await forwardGit(connectionId, userId, id, type, "pr", msg);
      }
      case "workspace.git.branch": {
        if (!msg.name?.trim()) return fail(type, id, "name is required");
        return await forwardGit(connectionId, userId, id, type, "branch", msg);
      }
      case "workspace.git.result": {
        if (!msg.requestId) return fail(type, id, "requestId is required");
        const meta = (msg.metadata || {}) as Record<string, unknown>;
        const workspaceId = hub.get(connectionId)?.workspaceId;
        const okFlag = meta.ok !== false && msg.status !== "error";
        const error =
          typeof meta.error === "string"
            ? meta.error
            : !okFlag
              ? "git failed"
              : null;
        if (error) {
          gitPending.complete(
            msg.requestId,
            fail("workspace.git.result", msg.requestId, error),
          );
          return ok(type, id, { forwarded: true });
        }
        gitPending.complete(
          msg.requestId,
          ok("workspace.git.result", msg.requestId, meta),
        );
        if (meta.snapshot && workspaceId) {
          broadcast(userId, "workspace.git.snapshot", {
            workspaceId,
            snapshot: meta.snapshot,
          });
        }
        const pr = meta.pr as { url?: string } | undefined;
        if (pr && typeof pr.url === "string" && pr.url) {
          broadcast(userId, "github.pr.created", pr);
        }
        return ok(type, id, { forwarded: true });
      }

      case "workspace.rules.snapshot":
      case "workspace.rules.local.set": {
        const workspaceId = requireWorkspace(connectionId);
        const daemon = hub.findDaemon(userId, workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        const action =
          type === "workspace.rules.local.set" ? "local.set" : "snapshot";
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent("workspace.rules.dispatch", {
            requestId: id,
            action,
            path: daemon.path,
            payload: msg.payload ?? { content: msg.content },
            workspaceId,
          }),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return await rulesPending.wait(id, type);
      }

      case "workspace.rules.result": {
        const data = (msg as ClientMessage & { data?: unknown }).data
          ?? msg.metadata
          ?? {};
        const requestId = String(
          (data as { requestId?: string }).requestId || msg.requestId || msg.id,
        );
        const okFlag = (msg as { ok?: boolean }).ok !== false && msg.status !== "error";
        const reply = okFlag
          ? ok("workspace.rules.result", requestId, data)
          : fail(
              "workspace.rules.result",
              requestId,
              String((data as { error?: string }).error || msg.content || "rules rpc failed"),
            );
        if (!rulesPending.complete(requestId, reply)) {
          return fail(type, id, "No pending rules request");
        }
        const snap = (data as { snapshot?: unknown }).snapshot;
        if (okFlag && snap) {
          const conn = hub.get(connectionId);
          broadcast(userId, "workspace.rules.changed", {
            workspaceId: conn?.workspaceId,
            snapshot: snap,
          });
        }
        return ok(type, id, { completed: true });
      }

      case "workspace.mcp.snapshot":
      case "workspace.skills.snapshot": {
        const workspaceId = requireWorkspace(connectionId);
        const daemon = hub.findDaemon(userId, workspaceId);
        if (!daemon) return fail(type, id, NO_DAEMON_ERROR);
        const isMcp = type === "workspace.mcp.snapshot";
        const sent = hub.sendTo(
          daemon.connectionId,
          hub.pushEvent(
            isMcp
              ? "workspace.mcp.dispatch"
              : "workspace.skills.dispatch",
            {
              requestId: id,
              action: "snapshot",
              path: daemon.path,
              workspaceId,
              userSkills: isMcp
                ? undefined
                : await enabledUserSkills(userId),
            },
          ),
        );
        if (!sent) return fail(type, id, "Daemon connection unavailable");
        return await (isMcp ? mcpPending : skillsPending).wait(id, type);
      }

      case "workspace.mcp.result":
      case "workspace.skills.result": {
        const data =
          (msg as ClientMessage & { data?: unknown }).data ??
          msg.metadata ??
          {};
        const requestId = String(
          (data as { requestId?: string }).requestId ||
            msg.requestId ||
            msg.id,
        );
        const rpcError =
          typeof (data as { error?: unknown }).error === "string"
            ? String((data as { error: string }).error)
            : null;
        const okFlag =
          (msg as ClientMessage & { ok?: boolean }).ok !== false &&
          msg.status !== "error" &&
          !rpcError;
        const isMcp = type === "workspace.mcp.result";
        const pending = isMcp ? mcpPending : skillsPending;
        const reply = okFlag
          ? ok(type, requestId, data)
          : fail(
              type,
              requestId,
              String(
                rpcError ||
                  msg.content ||
                  `${isMcp ? "mcp" : "skills"} rpc failed`,
              ),
            );
        if (!pending.complete(requestId, reply)) {
          return fail(type, id, `No pending ${isMcp ? "mcp" : "skills"} request`);
        }
        if (okFlag) {
          const conn = hub.get(connectionId);
          const snapshot =
            (data as { snapshot?: unknown }).snapshot ?? data;
          broadcast(
            userId,
            isMcp
              ? "workspace.mcp.changed"
              : "workspace.skills.changed",
            {
              workspaceId: conn?.workspaceId,
              snapshot,
            },
          );
        }
        return ok(type, id, { completed: true });
      }

      case "chat.plan.list": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const messages = await loadMessages(msg.chatId);
        const plans = messages.filter((m) => isPlanArtifact(m.metadata));
        return ok(type, id, {
          chatId: msg.chatId,
          currentPlanArtifactId: currentPlanId(
            plans.map((p) => ({
              id: p.id,
              metadata: p.metadata as Record<string, unknown>,
            })),
          ),
          plans: plans.map(publicPlan),
        });
      }

      case "chat.plan.update": {
        if (!msg.chatId || !msg.artifactId) {
          return fail(type, id, "chatId and artifactId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        let markdown: string;
        try {
          markdown = validatePlanMarkdown(msg.markdown ?? msg.content ?? "");
        } catch (e) {
          return fail(type, id, e instanceof Error ? e.message : PLAN_EMPTY_ERROR);
        }
        const rows = await loadMessages(msg.chatId);
        const row = rows.find((m) => m.id === msg.artifactId);
        if (!row || !isPlanArtifact(row.metadata)) {
          return fail(type, id, PLAN_NOT_FOUND);
        }
        if (row.chatId !== msg.chatId) return fail(type, id, PLAN_NOT_IN_CHAT);
        const meta = bumpRevision(asPlanMeta(row.metadata)!);
        const message = await writePlanMeta(row, meta, markdown);
        await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, msg.chatId));
        const payload = { chatId: msg.chatId, message: publicPlan(message) };
        broadcast(userId, PLAN_UPDATED_EVENT, payload);
        broadcast(userId, "message.appended", { ...payload, updated: true });
        return ok(type, id, payload);
      }

      case "chat.plan.setCurrent": {
        if (!msg.chatId || !msg.artifactId) {
          return fail(type, id, "chatId and artifactId are required");
        }
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const rows = await loadMessages(msg.chatId);
        const row = rows.find((m) => m.id === msg.artifactId);
        if (!row || !isPlanArtifact(row.metadata)) {
          return fail(type, id, PLAN_NOT_FOUND);
        }
        await persistPromote(msg.chatId, msg.artifactId);
        const fresh = await loadMessages(msg.chatId);
        const message = fresh.find((m) => m.id === msg.artifactId)!;
        const payload = {
          chatId: msg.chatId,
          message: publicPlan(message),
          currentPlanArtifactId: msg.artifactId,
        };
        broadcast(userId, PLAN_CURRENT_EVENT, payload);
        broadcast(userId, "message.appended", { ...payload, updated: true });
        return ok(type, id, payload);
      }

      case "chat.plan.apply": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const rows = await loadMessages(msg.chatId);
        const targetId = msg.artifactId || currentPlanId(
          rows.map((r) => ({ id: r.id, metadata: r.metadata as Record<string, unknown> })),
        );
        if (!targetId) return fail(type, id, NO_CURRENT_PLAN);
        const row = rows.find((m) => m.id === targetId);
        if (!row || !isPlanArtifact(row.metadata)) {
          return fail(type, id, PLAN_NOT_FOUND);
        }
        await persistPromote(msg.chatId, targetId);
        const prefsRows = await db
          .select()
          .from(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .limit(1);
        const applyMode = resolveApplyMode(prefsRows[0]?.lastRunnableExecutionMode);
        const now = new Date();
        if (prefsRows[0]) {
          await db
            .update(userPreferences)
            .set({ activeExecutionMode: applyMode, updatedAt: now })
            .where(eq(userPreferences.userId, userId));
        } else {
          await db.insert(userPreferences).values({
            userId,
            activeExecutionMode: applyMode,
            lastRunnableExecutionMode: applyMode,
            updatedAt: now,
          });
        }
        const meta = markPendingApply(asPlanMeta(row.metadata)!, now.toISOString());
        meta.status = PLAN_STATUS_CURRENT;
        const message = await writePlanMeta(row, meta);
        const payload = {
          chatId: msg.chatId,
          message: publicPlan(message),
          currentPlanArtifactId: targetId,
          executionMode: applyMode,
          gitCommit: false,
        };
        broadcast(userId, PLAN_APPLIED_EVENT, payload);
        broadcast(userId, "message.appended", { ...payload, updated: true });
        broadcast(userId, "prefs.updated", {
          activeExecutionMode: applyMode,
          lastRunnableExecutionMode: applyMode,
        });
        return ok(type, id, payload);
      }

      case "chat.plan.consume": {
        if (!msg.chatId) return fail(type, id, "chatId is required");
        const chat = await loadChatForUser(msg.chatId, userId);
        if (!chat) return fail(type, id, "Chat not found");
        const rows = await loadMessages(msg.chatId);
        const pending = pendingApplyPlan(
          rows.map((r) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata as Record<string, unknown>,
          })),
        );
        if (!pending) return ok(type, id, { consumed: false });
        const dbRow = rows.find((r) => r.id === pending.id)!;
        const message = await writePlanMeta(
          dbRow,
          consumePending(asPlanMeta(dbRow.metadata)!),
        );
        const payload = { chatId: msg.chatId, message: publicPlan(message), consumed: true };
        broadcast(userId, "message.appended", { ...payload, updated: true });
        return ok(type, id, payload);
      }

      default:
        return fail(type, id, `Unknown type: ${type}`);
    }
  } catch (err) {
    return fail(type, id, err instanceof Error ? err.message : String(err));
  }
}
