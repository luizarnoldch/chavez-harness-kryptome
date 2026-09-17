/** keep-in-sync with cli/src/notifications/{constants,classify,store}.ts */

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export const NO_RUNNER_LABEL = "sin runner";
export const TURN_START_LABEL = "Turn iniciado";
export const TURN_DONE_LABEL = "Turn terminado";
export const TURN_ERROR_LABEL = "Turn error";
export const APPROVAL_LABEL = "Ask pendiente";
export const TOAST_TTL_MS = 8000;
export const MAX_VISIBLE_TOASTS = 5;

export const NOTIFICATION_SOURCE_TYPES = [
  "chat.stream.start",
  "chat.stream.end",
  "chat.stream.error",
  "chat.tool.update",
  "chat.tool.start",
  "chat.tool.resolved",
  "chat.tool.result",
  "daemon.presence",
] as const;

export const NEVER_NOTIFY_TYPES = [
  "chat.stream.delta",
  "chat.thinking.delta",
  "message.appended",
  "agent.turn.ended",
  "agent.turn.dispatch",
] as const;

export const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);

export type NotificationKind =
  | "turn_start"
  | "turn_done"
  | "turn_error"
  | "approval"
  | "daemon";

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
}): string {
  if (kind === "daemon") return `daemon:${parts.workspaceId || "*"}`;
  if (kind === "approval") {
    return `approval:${parts.chatId || ""}:${parts.toolCallId || ""}`;
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

export function classifyNotificationEvent(
  input: ClassifyInput,
  _ctx: ClassifyContext,
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

export type InAppNotification = NotificationDraft & {
  createdAt: number;
  read: boolean;
};

export type NotificationState = {
  items: InAppNotification[];
};

export const emptyNotificationState = (): NotificationState => ({ items: [] });

function upsertItem(
  items: InAppNotification[],
  next: InAppNotification,
): InAppNotification[] {
  const without = items.filter((i) => i.id !== next.id);
  if (next.kind === "turn_done" || next.kind === "turn_error") {
    const rest = without.filter(
      (i) =>
        !(
          i.kind === "turn_start" &&
          i.chatId === next.chatId &&
          i.streamId === next.streamId
        ),
    );
    return [...rest, next];
  }
  return [...without, next];
}

export function reduceNotification(
  state: NotificationState,
  input: ClassifyInput,
  ctx: ClassifyContext,
): { state: NotificationState; added: InAppNotification | null } {
  const now = ctx.now ?? Date.now();
  const result = classifyNotificationEvent(input, ctx);
  if (result.op === "ignore") return { state, added: null };

  if (result.op === "dismiss") {
    return {
      state: { items: state.items.filter((i) => i.id !== result.id) },
      added: null,
    };
  }

  if (result.op === "dismissKind") {
    return {
      state: {
        items: state.items.filter((i) => {
          if (i.kind !== result.kind) return true;
          if (result.workspaceId && i.workspaceId && i.workspaceId !== result.workspaceId) {
            return true;
          }
          return false;
        }),
      },
      added: null,
    };
  }

  const added: InAppNotification = {
    ...result.notification,
    createdAt: now,
    read: false,
  };
  return { state: { items: upsertItem(state.items, added) }, added };
}

export function markChatRead(
  state: NotificationState,
  chatId: string,
): NotificationState {
  return {
    items: state.items
      .map((i) => {
        if (i.chatId !== chatId) return i;
        if (i.kind === "approval" || i.kind === "daemon") return i;
        return { ...i, read: true };
      })
      .filter((i) => i.kind === "approval" || i.kind === "daemon" || !i.read),
  };
}

export function pruneExpired(
  state: NotificationState,
  now = Date.now(),
): NotificationState {
  return {
    items: state.items.filter(
      (i) => i.sticky || i.read || now - i.createdAt <= TOAST_TTL_MS,
    ),
  };
}

export function visibleToasts(
  state: NotificationState,
  pred: (n: InAppNotification) => boolean,
): InAppNotification[] {
  return state.items.filter((i) => !i.read && pred(i)).slice(-MAX_VISIBLE_TOASTS);
}

export function unreadCountForChat(
  state: NotificationState,
  chatId: string,
): number {
  return state.items.filter(
    (i) => i.chatId === chatId && !i.read && i.kind !== "daemon",
  ).length;
}

export function hasApproval(
  state: NotificationState,
  chatId?: string,
): boolean {
  return state.items.some(
    (i) => i.kind === "approval" && (!chatId || i.chatId === chatId),
  );
}

export function hasDaemonDown(state: NotificationState): boolean {
  return state.items.some((i) => i.kind === "daemon");
}

export function seedApproval(input: {
  chatId: string;
  toolCallId: string;
  summary?: string;
  now?: number;
}): ClassifyInput {
  return {
    type: "chat.tool.update",
    data: {
      chatId: input.chatId,
      toolCallId: input.toolCallId,
      status: "awaiting_approval",
      metadata: {
        status: "awaiting_approval",
        toolCallId: input.toolCallId,
        toolName: "write",
        summary: input.summary || "tool",
      },
    },
  };
}

export function seedDaemonDown(workspaceId?: string): ClassifyInput {
  return {
    type: "daemon.presence",
    data: { bound: false, workspaceId },
  };
}

export function seedDaemonUp(workspaceId?: string): ClassifyInput {
  return {
    type: "daemon.presence",
    data: { bound: true, workspaceId },
  };
}
