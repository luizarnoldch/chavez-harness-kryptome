import { useNotifications } from "../lib/notification-context";
import {
  shouldShowWebToast,
  visibleToasts,
} from "../lib/notifications";

export function NotificationHost() {
  const { state, viewingChatId } = useNotifications();
  const toasts = visibleToasts(state, (n) =>
    shouldShowWebToast(n, viewingChatId),
  );
  if (toasts.length === 0) return null;
  return (
    <div className="notice-host" data-testid="notice-host" role="status">
      {toasts.map((n) => (
        <a
          key={n.id}
          className={`notice-toast notice-${n.kind}${n.sticky ? " notice-sticky" : ""}`}
          data-testid={`notice-${n.kind}`}
          href={n.chatId ? `/chats/${n.chatId}` : "/workspaces"}
        >
          <strong>{n.title}</strong>
          {n.body ? <span> · {n.body}</span> : null}
        </a>
      ))}
    </div>
  );
}
