import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useMe,
  useWorkspaceSessions,
  type ChatMessage,
} from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { toolHeadline } from "../lib/tool-display";
import {
  useWsBind,
  useWsChatCreate,
  useWsSessionCreate,
} from "../lib/ws-hooks";

function previewLabel(m: ChatMessage): string {
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const sdkName = String(meta.sdkName || meta.toolName || m.content || "tool");
    const status = String(meta.status || "done");
    return toolHeadline(sdkName, status, meta.input);
  }
  const t = (m.content || "").replace(/\s+/g, " ").trim();
  if (!t) return m.role === "assistant" ? "assistant (vacío)" : m.role;
  return t.length <= 120 ? t : `${t.slice(0, 120)}…`;
}

function WorkspaceDetailInner({ workspaceId }: { workspaceId: string }) {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const detail = useWorkspaceSessions(workspaceId, signedIn);
  const ws = useWs();
  const bind = useWsBind();
  const createSession = useWsSessionCreate();
  const createChat = useWsChatCreate();
  const [title, setTitle] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [chatSessionId, setChatSessionId] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function ensureBound() {
    const path = detail.data?.workspace?.path;
    if (!path) throw new Error("Workspace sin path");
    await bind.mutateAsync(path);
  }

  async function onCreateSession(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await ensureBound();
      const res = await createSession.mutateAsync(title.trim() || undefined);
      const session = (res.data as { session?: { id: string } })?.session;
      setMsg({ kind: "ok", text: "Session creada." });
      setTitle("");
      if (session?.id) setChatSessionId(session.id);
      await detail.refetch();
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onCreateChat(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const sessionId = chatSessionId || sessions[0]?.id;
      if (!sessionId) throw new Error("Elige una session");
      await ensureBound();
      const res = await createChat.mutateAsync({
        sessionId,
        title: chatTitle.trim() || undefined,
      });
      const chat = (res.data as { chat?: { id: string } })?.chat;
      setMsg({ kind: "ok", text: "Chat creado." });
      setChatTitle("");
      await detail.refetch();
      if (chat?.id) window.location.href = `/chats/${chat.id}`;
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  const sessions = detail.data?.sessions || [];

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / <a href="/workspaces">Workspaces</a> /{" "}
        <code>{workspaceId.slice(0, 8)}…</code>
      </p>
      <div className="panel">
        <h1>Workspace</h1>
        <p>
          WS:{" "}
          <span className={`badge ${ws.status === "open" ? "ok" : ""}`}>
            {ws.status}
          </span>
        </p>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Validación: sessions → chats → preview (últimos 3). Daemon:{" "}
          <code>chavez headless workspace open</code> en el path del workspace.
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado —{" "}
            <a href={`/sign-in?redirect=/workspaces/${workspaceId}`}>
              Sign in
            </a>
          </p>
        )}
        {detail.isLoading && signedIn && (
          <p className="muted">Cargando…</p>
        )}
        {detail.isError && (
          <p className="error">{formatQueryError(detail.error)}</p>
        )}
        {detail.data && (
          <>
            <p>
              <code>{detail.data.workspace.path}</code>{" "}
              <span className="badge">
                {detail.data.openConnections} conn
              </span>
            </p>
            <p>
              Runner:{" "}
              {detail.data.daemonBound ? (
                <code>
                  {detail.data.daemonHostname || "—"} ·{" "}
                  {detail.data.daemonPath || detail.data.workspace.path}
                </code>
              ) : (
                <span className="error">
                  No daemon bound for this workspace. Run: chavez headless
                  workspace open
                </span>
              )}
            </p>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Sin daemon no se hidrata @ ni se ejecutan tools.
            </p>

            <h2>Sessions · chats · mensajes</h2>
            {sessions.length === 0 && (
              <p className="muted">Sin sessions.</p>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className="panel"
                style={{ marginBottom: "0.75rem" }}
              >
                <p style={{ margin: 0 }}>
                  <a href={`/sessions/${s.id}`}>
                    <strong>{s.title || s.id}</strong>
                  </a>{" "}
                  <span className="badge">{s.chats?.length ?? 0} chats</span>
                </p>
                {(s.chats || []).length === 0 && (
                  <p className="muted" style={{ marginTop: "0.5rem" }}>
                    Sin chats.
                  </p>
                )}
                <ul style={{ marginTop: "0.75rem", paddingLeft: "1.1rem" }}>
                  {(s.chats || []).map((ch) => (
                    <li key={ch.id} style={{ marginBottom: "0.75rem" }}>
                      <a href={`/chats/${ch.id}`}>{ch.title || ch.id}</a>{" "}
                      <span className="badge">
                        {ch.messageCount ?? 0} msgs
                      </span>
                      {(ch.recentMessages || []).length === 0 ? (
                        <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                          Sin mensajes.
                        </p>
                      ) : (
                        <ul
                          style={{
                            listStyle: "none",
                            padding: 0,
                            margin: "0.35rem 0 0",
                          }}
                        >
                          {(ch.recentMessages || []).map((m) => (
                            <li
                              key={m.id}
                              className="muted"
                              style={{
                                fontSize: "0.85rem",
                                marginBottom: "0.2rem",
                              }}
                            >
                              <span className="badge">{m.role}</span>{" "}
                              {previewLabel(m)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <form onSubmit={onCreateSession} style={{ marginTop: "1rem" }}>
              <label htmlFor="title">Nueva session</label>
              <input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Session"
              />
              <button
                type="submit"
                disabled={createSession.isPending || ws.status !== "open"}
              >
                {createSession.isPending ? "Creando…" : "session.create"}
              </button>
            </form>

            {sessions.length > 0 && (
              <form onSubmit={onCreateChat} style={{ marginTop: "1rem" }}>
                <label htmlFor="chatSession">Nuevo chat en session</label>
                <select
                  id="chatSession"
                  value={chatSessionId || sessions[0]?.id || ""}
                  onChange={(e) => setChatSessionId(e.target.value)}
                >
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.id}
                    </option>
                  ))}
                </select>
                <label htmlFor="chatTitle">Título</label>
                <input
                  id="chatTitle"
                  value={chatTitle}
                  onChange={(e) => setChatTitle(e.target.value)}
                  placeholder="Chat"
                />
                <button
                  type="submit"
                  className="secondary"
                  disabled={createChat.isPending || ws.status !== "open"}
                  onClick={() => {
                    if (!chatSessionId && sessions[0]) {
                      setChatSessionId(sessions[0].id);
                    }
                  }}
                >
                  {createChat.isPending ? "Creando…" : "chat.create"}
                </button>
              </form>
            )}

            {msg && (
              <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function WorkspaceDetailPanel({
  workspaceId,
}: {
  workspaceId: string;
}) {
  return (
    <AppProviders>
      <WorkspaceDetailInner workspaceId={workspaceId} />
    </AppProviders>
  );
}
