import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "./hooks";
import { queryKeys } from "./query-keys";
import {
  ChavezWsClient,
  type WsPushMessage,
  type WsResponse,
  type WsStatus,
} from "./ws-client";

type WsContextValue = {
  status: WsStatus;
  client: ChavezWsClient | null;
  request: (partial: {
    type: string;
    path?: string;
    title?: string;
    sessionId?: string;
    chatId?: string;
    role?: string;
    content?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
    query?: string;
    toolCallId?: string;
    status?: string;
    diffId?: string;
    diff?: Record<string, unknown>;
  }) => Promise<WsResponse>;
  bind: (path: string) => Promise<WsResponse>;
  unbind: () => Promise<WsResponse>;
  onPush: (handler: (msg: WsPushMessage) => void) => () => void;
};

const WsContext = createContext<WsContextValue | null>(null);

export function WsProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const qc = useQueryClient();
  const [status, setStatus] = useState<WsStatus>("idle");
  const [client, setClient] = useState<ChavezWsClient | null>(null);

  useEffect(() => {
    if (!signedIn) {
      client?.close();
      setClient(null);
      setStatus("idle");
      return;
    }

    const c = new ChavezWsClient();
    c.setStatusListener(setStatus);
    setClient(c);
    void c.connect().catch(() => {
      /* status already error */
    });

    const off = c.onPush((msg) => {
      const data = msg.data as { chatId?: string; sessionId?: string } | undefined;
      if (
        msg.type === "message.appended" ||
        msg.type.startsWith("chat.stream.") ||
        msg.type.startsWith("chat.tool.") ||
        msg.type === "chat.diff.upsert" ||
        msg.type === "chat.created" ||
        msg.type === "session.created"
      ) {
        void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
        if (data?.chatId) {
          void qc.invalidateQueries({ queryKey: queryKeys.chat(data.chatId) });
        } else {
          void qc.invalidateQueries({ queryKey: ["chat"] });
        }
        void qc.invalidateQueries({ queryKey: ["sessionChats"] });
      }
      if (msg.type === "session.created") {
        void qc.invalidateQueries({ queryKey: ["session"] });
      }
      if (msg.type === "prefs.updated") {
        void qc.invalidateQueries({ queryKey: ["providers"] });
      }
      if (msg.type === "daemon.presence") {
        void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
        void qc.invalidateQueries({ queryKey: queryKeys.connections });
        void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
      }
    });

    return () => {
      off();
      c.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only on auth change
  }, [signedIn, me.data?.id]);

  const value = useMemo<WsContextValue>(() => {
    async function request(
      partial: {
        type: string;
        path?: string;
        title?: string;
        sessionId?: string;
        chatId?: string;
        role?: string;
        content?: string;
        prompt?: string;
        metadata?: Record<string, unknown>;
        query?: string;
        toolCallId?: string;
        status?: string;
      },
    ): Promise<WsResponse> {
      if (!client) throw new Error("WebSocket no conectado — inicia sesión");
      const res = await client.request(partial);
      if (!res.ok) {
        throw new Error(res.error || `WS ${partial.type} failed`);
      }
      const t = partial.type;
      if (t.startsWith("workspace.")) {
        void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
        void qc.invalidateQueries({ queryKey: queryKeys.connections });
      }
      if (t.startsWith("session.")) {
        void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
        void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
        void qc.invalidateQueries({ queryKey: ["session"] });
      }
      if (t.startsWith("chat.") || t.startsWith("agent.")) {
        void qc.invalidateQueries({ queryKey: ["sessionChats"] });
        void qc.invalidateQueries({ queryKey: ["chat"] });
      }
      return res;
    }

    return {
      status,
      client,
      request,
      bind: (path: string) => request({ type: "workspace.bind", path }),
      unbind: () => request({ type: "workspace.unbind" }),
      onPush: (handler) => {
        if (!client) return () => {};
        return client.onPush(handler);
      },
    };
  }, [client, status, qc]);

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) {
    throw new Error("useWs must be used within WsProvider");
  }
  return ctx;
}
