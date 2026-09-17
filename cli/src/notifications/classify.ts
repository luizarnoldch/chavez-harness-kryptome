import {
  APPROVAL_LABEL,
  NEVER_NOTIFY_TYPES,
  NO_RUNNER_LABEL,
  READ_SDK,
  TURN_DONE_LABEL,
  TURN_ERROR_LABEL,
  TURN_START_LABEL,
  type NotificationKind,
} from "./constants";
import {
  QUEUE_DONE_LABEL,
  QUEUE_ENQUEUED_LABEL,
  QUEUE_PROMOTED_LABEL,
} from "../queue/constants";
import { classifyQueueEvent } from "../queue/notify";

/** Draft upserted into the store. `createdAt` / `read` se asignan en reduce. */
export type NotificationDraft = {
  id: string;
  kind: NotificationKind;
  chatId?: string;
  workspaceId?: string;
  streamId?: string;
  toolCallId?: string;
  title: string;
  body: string;
  sticky: boolean;
};

export type ClassifyContext = {
  surface: "web" | "tui";
  activeChatId: string | null;
  now?: number;
};

export type ClassifyInput = {
  type: string;
  data?: unknown;
};

export type ClassifyResult =
  | { op: "ignore" }
  | { op: "upsert"; notification: NotificationDraft }
  | { op: "dismiss"; id: string }
  | { op: "dismissKind"; kind: NotificationKind; chatId?: string; workspaceId?: string };

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function metaOf(data: Record<string, unknown>): Record<string, unknown> {
  const message = rec(data.message);
  return rec(message?.metadata) || rec(data.metadata) || {};
}

export function dedupKey(kind: NotificationKind, parts: {
  chatId?: string;
  streamId?: string;
  toolCallId?: string;
  workspaceId?: string;
  queueId?: string;
}): string {
  if (kind === "daemon") return `daemon:${parts.workspaceId || "*"}`;
  if (kind === "approval") {
    return `approval:${parts.chatId || ""}:${parts.toolCallId || ""}`;
  }
  if (
    kind === "queue_promoted" ||
    kind === "queue_done" ||
    kind === "queue_enqueued"
  ) {
    return `${kind}:${parts.chatId || ""}:${parts.queueId || parts.streamId || ""}`;
  }
  return `${kind}:${parts.chatId || ""}:${parts.streamId || ""}`;
}

export function isNeverNotifyType(type: string): boolean {
  return (NEVER_NOTIFY_TYPES as readonly string[]).includes(type);
}

function sdkName(meta: Record<string, unknown>, data: Record<string, unknown>): string {
  return String(meta.sdkName || meta.toolName || data.toolName || "");
}

function isReadTool(meta: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return READ_SDK.has(sdkName(meta, data));
}

function kindFromQueueTitle(title: string): NotificationKind {
  if (title === QUEUE_PROMOTED_LABEL) return "queue_promoted";
  if (title === QUEUE_DONE_LABEL) return "queue_done";
  if (title === QUEUE_ENQUEUED_LABEL) return "queue_enqueued";
  return "queue_enqueued";
}

export function classifyNotificationEvent(
  input: ClassifyInput,
  ctx: ClassifyContext,
): ClassifyResult {
  const type = input.type;
  if (isNeverNotifyType(type)) return { op: "ignore" };

  const data = rec(input.data) || {};
  const meta = metaOf(data);
  const chatId = typeof data.chatId === "string" ? data.chatId : undefined;
  const streamId = typeof data.streamId === "string" ? data.streamId : undefined;
  const workspaceId =
    typeof data.workspaceId === "string" ? data.workspaceId : undefined;
  const toolCallId =
    typeof data.toolCallId === "string"
      ? data.toolCallId
      : typeof meta.toolCallId === "string"
        ? meta.toolCallId
        : undefined;
  const status = String(meta.status || data.status || "");

  if (type === "chat.stream.start") {
    const id = dedupKey("turn_start", { chatId, streamId });
    return {
      op: "upsert",
      notification: {
        id,
        kind: "turn_start",
        chatId,
        streamId,
        title: TURN_START_LABEL,
        body: chatId ? chatId.slice(0, 8) : "",
        sticky: false,
      },
    };
  }

  if (type === "chat.stream.end") {
    return {
      op: "upsert",
      notification: {
        id: dedupKey("turn_done", { chatId, streamId }),
        kind: "turn_done",
        chatId,
        streamId,
        title: TURN_DONE_LABEL,
        body: chatId ? chatId.slice(0, 8) : "",
        sticky: false,
      },
    };
  }

  if (type === "chat.stream.error") {
    const err = String(data.error || data.content || TURN_ERROR_LABEL);
    return {
      op: "upsert",
      notification: {
        id: dedupKey("turn_error", { chatId, streamId }),
        kind: "turn_error",
        chatId,
        streamId,
        title: TURN_ERROR_LABEL,
        body: err,
        sticky: false,
      },
    };
  }

  if (type === "chat.tool.update" || type === "chat.tool.start") {
    if (status !== "awaiting_approval") return { op: "ignore" };
    if (isReadTool(meta, data)) return { op: "ignore" };
    if (!toolCallId) return { op: "ignore" };
    return {
      op: "upsert",
      notification: {
        id: dedupKey("approval", { chatId, toolCallId }),
        kind: "approval",
        chatId,
        toolCallId,
        title: APPROVAL_LABEL,
        body: String(meta.summary || meta.toolName || data.toolName || "tool"),
        sticky: true,
      },
    };
  }

  if (type === "chat.tool.resolved") {
    if (!toolCallId) return { op: "ignore" };
    return { op: "dismiss", id: dedupKey("approval", { chatId, toolCallId }) };
  }

  if (type === "chat.tool.result") {
    if (!toolCallId) return { op: "ignore" };
    if (status === "awaiting_approval") return { op: "ignore" };
    return { op: "dismiss", id: dedupKey("approval", { chatId, toolCallId }) };
  }

  if (type === "daemon.presence") {
    const bound = data.bound === true;
    if (bound) {
      return { op: "dismissKind", kind: "daemon", workspaceId };
    }
    return {
      op: "upsert",
      notification: {
        id: dedupKey("daemon", { workspaceId }),
        kind: "daemon",
        workspaceId,
        title: NO_RUNNER_LABEL,
        body: NO_RUNNER_LABEL,
        sticky: true,
      },
    };
  }

  if (type === "agent.queue.updated") {
    const q = classifyQueueEvent(type, input.data, ctx.activeChatId);
    if (!q) return { op: "ignore" };
    const kind = kindFromQueueTitle(q.title);
    const qChatId = q.chatId;
    const queueId =
      typeof data.changedQueueId === "string" ? data.changedQueueId : undefined;
    return {
      op: "upsert",
      notification: {
        id: dedupKey(kind, { chatId: qChatId, queueId }),
        kind,
        chatId: qChatId,
        title: q.title,
        body: qChatId ? qChatId.slice(0, 8) : "",
        sticky: false,
      },
    };
  }

  return { op: "ignore" };
}

export function shouldShowTuiBadge(
  n: Pick<NotificationDraft, "kind" | "chatId">,
  activeChatId: string | null,
): boolean {
  if (n.kind === "daemon") return false; // header, no fila
  if (!n.chatId) return false;
  if (n.kind === "approval") return true; // incluso en el chat activo: la fila se destaca
  return n.chatId !== activeChatId;
}

export function shouldShowWebToast(
  n: Pick<NotificationDraft, "kind" | "chatId" | "sticky">,
  viewingChatId: string | null,
): boolean {
  if (n.kind === "daemon") return false; // DaemonPresence / banner, no toast
  if (n.kind === "turn_start") return false;
  if (n.kind === "queue_enqueued") return false;
  if (n.kind === "approval") return viewingChatId !== n.chatId;
  if (viewingChatId && n.chatId === viewingChatId) return false;
  return true;
}

export function shouldShowWebChatBanner(
  n: Pick<NotificationDraft, "kind" | "chatId">,
  viewingChatId: string | null,
): boolean {
  if (!viewingChatId || n.chatId !== viewingChatId) return false;
  return n.kind === "turn_done" || n.kind === "turn_error" || n.kind === "approval";
}
