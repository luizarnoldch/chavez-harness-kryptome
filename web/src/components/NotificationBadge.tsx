import { useNotificationsOptional } from "../lib/notification-context";
import { hasApproval, unreadCountForChat } from "../lib/notifications";

export function NotificationBadge({ chatId }: { chatId: string }) {
  const ctx = useNotificationsOptional();
  if (!ctx) return null;
  const ask = hasApproval(ctx.state, chatId);
  const n = unreadCountForChat(ctx.state, chatId);
  if (!ask && n === 0) return null;
  return (
    <span
      className={`badge ${ask ? "err" : "ok"}`}
      data-testid={`chat-notice-${chatId}`}
      data-kind={ask ? "approval" : "turn"}
    >
      {ask ? "ask" : n}
    </span>
  );
}
