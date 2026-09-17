import { MAX_VISIBLE_TOASTS, TOAST_TTL_MS } from "./constants";
import {
  classifyNotificationEvent,
  type ClassifyContext,
  type ClassifyInput,
  type NotificationDraft,
} from "./classify";

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
