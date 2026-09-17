import { useEffect, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useChatImport,
  useMe,
  useSession,
  useSessionChats,
  useChatSearch,
} from "../lib/hooks";
import { IMPORT_JSON_ONLY } from "../lib/export-share";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsChatCreate } from "../lib/ws-hooks";
import { ChatOrgBar } from "./ChatOrgBar";
import { NotificationBadge } from "./NotificationBadge";
import {
  displayChatTitle,
  NO_SEARCH_MATCHES,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
  SHOW_ARCHIVED_LABEL,
  visibleChats,
} from "../lib/chat-org";
import {
  QUEUE_POSITION_PREFIX,
  type QueueSnapshot,
} from "../lib/queue";

function SessionDetailInner({ sessionId }: { sessionId: string }) {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const session = useSession(sessionId, signedIn);
  const [includeArchived, setIncludeArchived] = useState(false);
  const chats = useSessionChats(sessionId, signedIn, { includeArchived });
  const ws = useWs();
  const bind = useWsBind();
  const createChat = useWsChatCreate();
  const chatImport = useChatImport(sessionId);
  const [title, setTitle] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const search = useChatSearch(searchQuery, {
    sessionId,
    includeArchived,
    enabled: signedIn,
  });
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const path = session.data?.workspace?.path;
      if (path) await bind.mutateAsync(path);
      const res = await createChat.mutateAsync({
        sessionId,
        title: title.trim() || undefined,
      });
      const chat = (res.data as { chat?: { id: string } })?.chat;
      setMsg({ kind: "ok", text: "Chat creado." });
      setTitle("");
      if (chat?.id) window.location.href = `/chats/${chat.id}`;
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  const workspaceId = session.data?.workspace?.id;
  const rows = visibleChats(chats.data || [], { includeArchived });

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchQuery(searchText),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    return ws.onPush((msg) => {
      if (msg.type === "agent.queue.updated") {
        const snap = msg.data as QueueSnapshot;
        if (!workspaceId || !snap.workspaceId || snap.workspaceId === workspaceId) {
          setQueueSnap(snap);
        }
      }
    });
  }, [ws, workspaceId]);

  useEffect(() => {
    if (ws.status !== "open" || !workspaceId) return;
    void ws
      .request({
        type: "agent.queue.list",
        metadata: { workspaceId },
      })
      .then((res) => {
        setQueueSnap(res.data as QueueSnapshot);
      })
      .catch(() => {
        /* best-effort */
      });
  }, [ws, ws.status, workspaceId]);

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / <a href="/workspaces">Workspaces</a>
        {workspaceId && (
          <>
            {" "}
            / <a href={`/workspaces/${workspaceId}`}>workspace</a>
          </>
        )}{" "}
        / <code>{sessionId.slice(0, 8)}…</code>
      </p>
      <div className="panel">
        <h1>Session</h1>
        <p>
          WS:{" "}
          <span className={`badge ${ws.status === "open" ? "ok" : ""}`}>
            {ws.status}
          </span>
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado —{" "}
            <a href={`/sign-in?redirect=/sessions/${sessionId}`}>Sign in</a>
          </p>
        )}
        {session.isLoading && signedIn && (
          <p className="muted">Cargando…</p>
        )}
        {session.isError && (
          <p className="error">{formatQueryError(session.error)}</p>
        )}
        {session.data && (
          <>
            <p>
              <strong>{session.data.session.title}</strong>
            </p>
            <p className="muted">
              Workspace: <code>{session.data.workspace.path}</code>
            </p>
          </>
        )}
        <h2>Chats</h2>
        <label>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />{" "}
          {SHOW_ARCHIVED_LABEL}
        </label>
        <label htmlFor="session-chat-search">Buscar en esta session</label>
        <input
          id="session-chat-search"
          type="search"
          value={searchText}
          placeholder={SEARCH_PLACEHOLDER}
          onChange={(e) => setSearchText(e.target.value)}
        />
        {searchQuery.trim().length >= 2 && (
          <div className="chat-search-inline">
            {search.isLoading && <p className="muted">Buscando…</p>}
            {search.isError && (
              <p className="error">{formatQueryError(search.error)}</p>
            )}
            {!search.isLoading && search.data?.chats.length === 0 && (
              <p className="muted">{NO_SEARCH_MATCHES}</p>
            )}
            {(search.data?.chats || []).map((chat) => (
              <p key={chat.id}>
                <a href={`/chats/${chat.id}`}>{displayChatTitle(chat)}</a>{" "}
                {(() => {
                  const item = queueSnap?.items.find(
                    (it) => it.chatId === chat.id,
                  );
                  return item ? (
                    <span className="badge queued">
                      {QUEUE_POSITION_PREFIX}
                      {item.position}
                    </span>
                  ) : null;
                })()}
                <NotificationBadge chatId={chat.id} />
              </p>
            ))}
          </div>
        )}
        {chats.isLoading && signedIn && <p className="muted">Cargando chats…</p>}
        {chats.isError && (
          <p className="error">{formatQueryError(chats.error)}</p>
        )}
        <ul className="chat-list">
          {rows.map((c) => (
            <li key={c.id} className={`chat-row${c.archivedAt ? " archived" : ""}`}>
              <ChatOrgBar chat={c} variant="row" />
              {(() => {
                const item = queueSnap?.items.find((it) => it.chatId === c.id);
                return item ? (
                  <span className="badge queued">
                    {QUEUE_POSITION_PREFIX}
                    {item.position}
                  </span>
                ) : null;
              })()}
              <NotificationBadge chatId={c.id} />
            </li>
          ))}
        </ul>
        {rows.length === 0 && !chats.isLoading && signedIn && (
          <p className="muted">Sin chats.</p>
        )}
        {signedIn && (
          <form onSubmit={onCreate} style={{ marginTop: "1rem" }}>
            <label htmlFor="chatTitle">Nuevo chat</label>
            <input
              id="chatTitle"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Chat"
            />
            <button
              type="submit"
              disabled={createChat.isPending || ws.status !== "open"}
            >
              {createChat.isPending ? "Creando…" : "chat.create"}
            </button>
            {msg && (
              <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
            )}
          </form>
        )}
        {signedIn && (
          <div style={{ marginTop: "1rem" }}>
            <label htmlFor="import-json">Importar export JSON</label>
            <input
              id="import-json"
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.name.endsWith(".md")) {
                  setMsg({ kind: "error", text: IMPORT_JSON_ONLY });
                  return;
                }
                const text = await file.text();
                let raw: unknown;
                try {
                  raw = JSON.parse(text);
                } catch {
                  setMsg({ kind: "error", text: IMPORT_JSON_ONLY });
                  return;
                }
                try {
                  const res = await chatImport.mutateAsync(raw);
                  if (res.chat?.id) window.location.href = `/chats/${res.chat.id}`;
                } catch (err) {
                  setMsg({
                    kind: "error",
                    text: formatQueryError(err),
                  });
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionDetailPanel({ sessionId }: { sessionId: string }) {
  return (
    <AppProviders>
      <SessionDetailInner sessionId={sessionId} />
    </AppProviders>
  );
}
