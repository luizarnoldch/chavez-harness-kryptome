import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useWs } from "./ws-context";
import {
  emptyNotificationState,
  markChatRead,
  pruneExpired,
  reduceNotification,
  TOAST_TTL_MS,
  type NotificationState,
} from "./notifications";

type Ctx = {
  state: NotificationState;
  viewingChatId: string | null;
  setViewingChatId: (id: string | null) => void;
  markRead: (chatId: string) => void;
  apply: (type: string, data?: unknown) => void;
};

const NotificationContext = createContext<Ctx | null>(null);

export function NotificationProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const ws = useWs();
  const [state, setState] = useState<NotificationState>(emptyNotificationState);
  const [viewingChatId, setViewingChatId] = useState<string | null>(null);

  const apply = useCallback((type: string, data?: unknown) => {
    setState((prev) =>
      reduceNotification(
        prev,
        { type, data },
        { surface: "web", activeChatId: viewingChatId },
      ).state,
    );
  }, [viewingChatId]);

  useEffect(() => {
    if (!enabled) return;
    return ws.onPush((msg) => apply(msg.type, msg.data));
  }, [ws, apply, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      setState((prev) => pruneExpired(prev));
    }, TOAST_TTL_MS);
    return () => clearInterval(t);
  }, [enabled]);

  const markRead = useCallback((chatId: string) => {
    setState((prev) => markChatRead(prev, chatId));
  }, []);

  const value = useMemo<Ctx>(
    () => ({ state, viewingChatId, setViewingChatId, markRead, apply }),
    [state, viewingChatId, markRead, apply],
  );

  if (!enabled) return <>{children}</>;
  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return ctx;
}

export function useNotificationsOptional(): Ctx | null {
  return useContext(NotificationContext);
}
