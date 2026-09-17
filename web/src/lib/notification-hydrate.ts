/** keep-in-sync with cli/src/notifications/hydrate.ts */
import {
  READ_SDK,
  reduceNotification,
  seedApproval,
  seedDaemonDown,
  seedDaemonUp,
  type NotificationState,
} from "./notifications";

export type HydrateMessage = {
  role?: string;
  chatId?: string;
  metadata?: Record<string, unknown> | null;
};

export type HydrateConnection = {
  clientKind?: string;
  role?: string;
  workspaceId?: string | null;
};

export function hydrateFromMessages(
  state: NotificationState,
  messages: HydrateMessage[],
  chatId: string,
  now = Date.now(),
): NotificationState {
  let s = state;
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const meta = m.metadata || {};
    if (String(meta.status) !== "awaiting_approval") continue;
    const sdk = String(meta.sdkName || meta.toolName || "");
    if (READ_SDK.has(sdk)) continue;
    const toolCallId = String(meta.toolCallId || "");
    if (!toolCallId) continue;
    const deadline = meta.approvalDeadline;
    if (typeof deadline === "string") {
      const t = Date.parse(deadline);
      if (!Number.isNaN(t) && t <= now) continue;
    }
    s = reduceNotification(
      s,
      seedApproval({
        chatId: m.chatId || chatId,
        toolCallId,
        summary: String(meta.summary || meta.toolName || "tool"),
        now,
      }),
      { surface: "web", activeChatId: null, now },
    ).state;
  }
  return s;
}

export function hydrateDaemonFromConnections(
  state: NotificationState,
  connections: HydrateConnection[],
  workspaceId?: string,
  now = Date.now(),
): NotificationState {
  const daemons = connections.filter((c) => c.clientKind === "daemon");
  const forWs = workspaceId
    ? daemons.filter((c) => !c.workspaceId || c.workspaceId === workspaceId)
    : daemons;
  const bound = forWs.some((c) => c.role !== "standby") || (forWs.length > 0);
  const event = bound ? seedDaemonUp(workspaceId) : seedDaemonDown(workspaceId);
  return reduceNotification(
    state,
    event,
    { surface: "web", activeChatId: null, now },
  ).state;
}

export function hydrateDaemonFromPresence(
  state: NotificationState,
  presence: { bound?: boolean; workspaceId?: string },
  now = Date.now(),
): NotificationState {
  return reduceNotification(
    state,
    presence.bound
      ? seedDaemonUp(presence.workspaceId)
      : seedDaemonDown(presence.workspaceId),
    { surface: "web", activeChatId: null, now },
  ).state;
}
