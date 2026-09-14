import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useMe,
  useSession,
  useSessionChats,
} from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsChatCreate } from "../lib/ws-hooks";

function SessionDetailInner({ sessionId }: { sessionId: string }) {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const session = useSession(sessionId, signedIn);
  const chats = useSessionChats(sessionId, signedIn);
  const ws = useWs();
  const bind = useWsBind();
  const createChat = useWsChatCreate();
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

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
        {chats.isLoading && signedIn && <p className="muted">Cargando chats…</p>}
        {chats.isError && (
          <p className="error">{formatQueryError(chats.error)}</p>
        )}
        <ul>
          {(chats.data || []).map((c) => (
            <li key={c.id}>
              <a href={`/chats/${c.id}`}>{c.title || c.id}</a>
            </li>
          ))}
        </ul>
        {(chats.data || []).length === 0 && !chats.isLoading && signedIn && (
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
