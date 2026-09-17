import { useEffect, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useChatSearch,
  useConnections,
  useCreateMemory,
  useDeleteMemory,
  useMe,
  useMemories,
  useWorkspaceSessions,
  useWorkspaceUserRulesEnabled,
  type Chat,
  type ChatMessage,
} from "../lib/hooks";
import { useNotifications } from "../lib/notification-context";
import type { HydrateConnection } from "../lib/notification-hydrate";
import { useWs } from "../lib/ws-context";
import {
  useWsBind,
  useWsChatCreate,
  useWsRulesLocalSet,
  useWsRulesSnapshot,
  useWsSessionCreate,
} from "../lib/ws-hooks";
import { FileTreePanel } from "./FileTreePanel";
import { DaemonPresence } from "./DaemonPresence";
import { NO_DAEMON_ERROR, type WorkspaceRulesSnapshot } from "../lib/rules-display";
import {
  EMPTY_WORKSPACE_COPY,
  NO_RUNNER_LABEL,
} from "../lib/onboarding";
import { NOT_A_GIT_UI, type GitSnapshot } from "../lib/git-display";
import { queryKeys } from "../lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import { asPlanMeta, isPlanArtifact } from "../lib/plan-artifact";
import {
  toolKindLabel,
  verificationFromMeta,
} from "../lib/verify-display";
import { apiJson } from "../lib/api";
import { ChatOrgBar } from "./ChatOrgBar";
import { WorktreeBar } from "./WorktreeBar";
import { NotificationBadge } from "./NotificationBadge";
import {
  displayChatTitle,
  NO_SEARCH_MATCHES,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
  SHOW_ARCHIVED_LABEL,
  SHOW_MORE_CHATS,
  visibleChats,
} from "../lib/chat-org";
import {
  QUEUE_POSITION_PREFIX,
  type QueueSnapshot,
} from "../lib/queue";
import { PtyTerminal } from "./PtyTerminal";
import {
  isPublishedGitPrReview,
  isReviewKind,
  reviewLabel,
} from "../lib/review";

function previewLabel(m: ChatMessage): string {
  if (isReviewKind(m.metadata)) {
    return reviewLabel(m.metadata);
  }
  if (isPlanArtifact(m.metadata)) {
    const status = asPlanMeta(m.metadata)?.status || "current";
    return `plan · ${status}`;
  }
  if (m.role === "tool") {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const status = String(meta.status || "");
    if (isPublishedGitPrReview(meta)) {
      return "review · published";
    }
    if (meta.kind === "verify") {
      return status ? `test · ${status}` : "test";
    }
    if (meta.kind === "lint") {
      return status ? `lint · ${status}` : "lint";
    }
    if (meta.kind === "fetch") {
      return status ? `tool · fetch · ${status}` : "tool · fetch";
    }
    const name = String(meta.toolName || m.content || "tool");
    const net =
      status === "awaiting_approval" &&
      (meta.needsNetwork === true ||
        (meta.prompt as { needsNetwork?: boolean } | undefined)?.needsNetwork ===
          true)
        ? " · pide red"
        : "";
    return status ? `tool · ${name} · ${status}${net}` : `tool · ${name}`;
  }
  const t = (m.content || "").replace(/\s+/g, " ").trim();
  if (!t) {
    if (m.role === "assistant") {
      const v = verificationFromMeta(m.metadata as Record<string, unknown>);
      if (v) {
        const label = toolKindLabel(v.kind, "test");
        return `${label} · ${v.status}`;
      }
      return "assistant (vacío)";
    }
    return m.role;
  }
  return t.length <= 120 ? t : `${t.slice(0, 120)}…`;
}

function WorkspaceDetailInner({ workspaceId }: { workspaceId: string }) {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const notices = useNotifications();
  const connections = useConnections(signedIn);
  useEffect(() => {
    if (!connections.data) return;
    const rows = Array.isArray(connections.data)
      ? connections.data
      : (connections.data as { connections?: HydrateConnection[] }).connections ||
        [];
    notices.apply("daemon.presence", {
      bound: rows.some(
        (c) =>
          c.clientKind === "daemon" &&
          (!c.workspaceId || c.workspaceId === workspaceId),
      ),
      workspaceId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate daemon on reload
  }, [connections.data, workspaceId]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const detail = useWorkspaceSessions(workspaceId, signedIn, {
    includeArchived,
    chatsLimit: 20,
  });
  const ws = useWs();
  const bind = useWsBind();
  const createSession = useWsSessionCreate();
  const createChat = useWsChatCreate();
  const cachedGit = useQuery({
    queryKey: queryKeys.gitSnapshot(workspaceId),
    queryFn: async () => null as GitSnapshot | null,
    enabled: false,
    initialData: null,
  });
  const [title, setTitle] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [chatSessionId, setChatSessionId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const search = useChatSearch(searchQuery, {
    workspaceId,
    includeArchived,
    enabled: signedIn,
  });
  const [extraChats, setExtraChats] = useState<Record<string, Chat[]>>({});
  const [sessionHasMore, setSessionHasMore] = useState<
    Record<string, boolean>
  >({});
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const toggleUserRules = useWorkspaceUserRulesEnabled(workspaceId);
  const memories = useMemories(workspaceId, signedIn);
  const createMemory = useCreateMemory();
  const deleteMemory = useDeleteMemory();
  const [memoryFact, setMemoryFact] = useState("");
  const rulesSnap = useWsRulesSnapshot();
  const rulesLocalSet = useWsRulesLocalSet();
  const [rules, setRules] = useState<WorkspaceRulesSnapshot | null>(null);
  const [localDraft, setLocalDraft] = useState("");
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);
  const [ptyOpen, setPtyOpen] = useState(false);

  useEffect(() => {
    return ws.onPush((msg) => {
      if (msg.type === "agent.queue.updated") {
        const snap = msg.data as QueueSnapshot;
        if (!snap.workspaceId || snap.workspaceId === workspaceId) {
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

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchQuery(searchText),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    setExtraChats({});
    setSessionHasMore({});
  }, [includeArchived, workspaceId, detail.dataUpdatedAt]);

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

  async function loadMoreChats(sessionId: string, offset: number) {
    setLoadingMore(sessionId);
    setMsg(null);
    try {
      const data = await apiJson<{
        chats: Chat[];
        hasMore?: boolean;
      }>(
        `/sessions/${sessionId}/chats?offset=${offset}&limit=20` +
          `&includeArchived=${includeArchived ? "1" : "0"}`,
      );
      setExtraChats((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] || []), ...(data.chats || [])],
      }));
      setSessionHasMore((current) => ({
        ...current,
        [sessionId]: Boolean(data.hasMore),
      }));
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    } finally {
      setLoadingMore(null);
    }
  }

  const sessions = detail.data?.sessions || [];
  const terminalChatId = sessions
    .flatMap((session) => session.chats || [])
    .map((chat) => chat.id)[0];

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
              {detail.data.workspace.daemonBound || detail.data.daemonBound ? (
                <span className="badge ok">daemon</span>
              ) : (
                <span className="badge err">{NO_RUNNER_LABEL}</span>
              )}{" "}
              <span className="badge">
                {detail.data.openConnections} conn
              </span>
            </p>
            <DaemonPresence
              bound={detail.data.daemonBound}
              hostname={detail.data.daemonHostname}
              path={detail.data.daemonPath || detail.data.workspace.path}
              lastSeen={detail.data.daemonLastSeen}
            />
            <WorktreeBar workspaceId={workspaceId} />
            <button
              type="button"
              className="secondary"
              disabled={ws.status !== "open"}
              onClick={() => {
                setMsg(null);
                void ensureBound()
                  .then(() => setPtyOpen(true))
                  .catch((err) =>
                    setMsg({ kind: "error", text: formatQueryError(err) }),
                  );
              }}
            >
              Terminal
            </button>
            <PtyTerminal
              chatId={terminalChatId}
              open={ptyOpen}
              onClosed={() => setPtyOpen(false)}
            />
            {!(detail.data.workspace.daemonBound || detail.data.daemonBound) && (
              <p>{EMPTY_WORKSPACE_COPY}</p>
            )}
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Sin daemon no se hidrata @ ni se ejecutan tools.
            </p>
            {(() => {
              const snap = cachedGit.data;
              if (snap && snap.isRepo === false) {
                return <p className="muted">git · {NOT_A_GIT_UI}</p>;
              }
              if (snap?.isRepo) {
                return (
                  <p>
                    <span className="badge git">git</span>{" "}
                    {snap.branch || "(detached)"} · dirty={snap.dirty.length}
                  </p>
                );
              }
              return (
                <p className="muted">
                  git · status en el chat (panel vs HEAD)
                </p>
              );
            })()}

            <h2>Sessions · chats · mensajes</h2>
            <label>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />{" "}
              {SHOW_ARCHIVED_LABEL}
            </label>
            <label htmlFor="workspace-chat-search">
              Buscar en este workspace
            </label>
            <input
              id="workspace-chat-search"
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
                    <a href={`/chats/${chat.id}`}>
                      {displayChatTitle(chat)}
                    </a>{" "}
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
                  </p>
                ))}
              </div>
            )}
            {sessions.length === 0 && (
              <p className="muted">Sin sessions.</p>
            )}
            {sessions.map((s) => {
              const merged = [...(s.chats || []), ...(extraChats[s.id] || [])];
              const deduped = Array.from(
                new Map(merged.map((chat) => [chat.id, chat])).values(),
              );
              const rows = visibleChats(deduped, { includeArchived });
              const hasMore =
                sessionHasMore[s.id] ?? Boolean(s.hasMoreChats);
              return (
                <div
                  key={s.id}
                  className="panel"
                  style={{ marginBottom: "0.75rem" }}
                >
                  <p style={{ margin: 0 }}>
                    <a href={`/sessions/${s.id}`}>
                      <strong>{s.title || s.id}</strong>
                    </a>{" "}
                    <span className="badge">
                      {s.chatCount ?? rows.length} chats
                    </span>
                  </p>
                  {rows.length === 0 && (
                    <p className="muted" style={{ marginTop: "0.5rem" }}>
                      Sin chats.
                    </p>
                  )}
                  <ul className="chat-list">
                    {rows.map((ch) => (
                      <li
                        key={ch.id}
                        className={`chat-row${ch.archivedAt ? " archived" : ""}`}
                      >
                        <ChatOrgBar chat={ch} variant="row" />
                        <span className="badge">
                          {ch.messageCount ?? 0} msgs
                        </span>
                        {(() => {
                          const item = queueSnap?.items.find(
                            (it) => it.chatId === ch.id,
                          );
                          return item ? (
                            <span className="badge queued">
                              {QUEUE_POSITION_PREFIX}
                              {item.position}
                            </span>
                          ) : null;
                        })()}
                        <NotificationBadge chatId={ch.id} />
                        {(ch.recentMessages || []).length > 0 && (
                          <ul className="chat-message-preview">
                            {(ch.recentMessages || []).map((m) => (
                              <li key={m.id} className="muted">
                                <span className="badge">{m.role}</span>{" "}
                                {previewLabel(m)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                  {hasMore && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={loadingMore === s.id}
                      onClick={() => void loadMoreChats(s.id, deduped.length)}
                    >
                      {loadingMore === s.id ? "Cargando…" : SHOW_MORE_CHATS}
                    </button>
                  )}
                </div>
              );
            })}

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

            <h2>Memoria de este workspace</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Esto no es AGENTS.md. Los facts cruzan chats. Bórralos aquí o en{" "}
              <a href="/memory">/memory</a>.
            </p>
            {memories.isLoading && <p className="muted">Cargando…</p>}
            {memories.isError && (
              <p className="error">{formatQueryError(memories.error)}</p>
            )}
            {(() => {
              const rows = memories.data?.memories ?? [];
              const userRows = rows.filter((m) => m.scope === "user");
              const wsRows = rows.filter((m) => m.scope === "workspace");
              return (
                <>
                  <h3>
                    Usuario (todos los repos){" "}
                    <a href="/memory" style={{ fontSize: "0.85rem" }}>
                      gestionar
                    </a>
                  </h3>
                  {userRows.length === 0 ? (
                    <p className="muted">Sin recuerdos de usuario.</p>
                  ) : (
                    <ul>
                      {userRows.map((m) => (
                        <li key={m.id}>
                          <span className="badge">user</span>{" "}
                          <strong>{m.title}</strong> — {m.fact}
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>Este workspace</h3>
                  {wsRows.length === 0 ? (
                    <p className="muted">Sin recuerdos de workspace.</p>
                  ) : (
                    <ul>
                      {wsRows.map((m) => (
                        <li key={m.id}>
                          <span className="badge">workspace</span>{" "}
                          <strong>{m.title}</strong> — {m.fact}{" "}
                          <button
                            type="button"
                            className="secondary"
                            disabled={deleteMemory.isPending}
                            onClick={() => {
                              void deleteMemory
                                .mutateAsync(m.id)
                                .catch((err) =>
                                  setMsg({
                                    kind: "error",
                                    text: formatQueryError(err),
                                  }),
                                );
                            }}
                          >
                            Borrar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              );
            })()}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setMsg(null);
                void (async () => {
                  try {
                    await createMemory.mutateAsync({
                      fact: memoryFact.trim(),
                      scope: "workspace",
                      workspaceId,
                    });
                    setMemoryFact("");
                    setMsg({ kind: "ok", text: "Recuerdo de workspace guardado." });
                  } catch (err) {
                    setMsg({ kind: "error", text: formatQueryError(err) });
                  }
                })();
              }}
              style={{ marginTop: "0.75rem" }}
            >
              <label htmlFor="ws-memory-fact">Añadir recuerdo de workspace</label>
              <textarea
                id="ws-memory-fact"
                rows={3}
                value={memoryFact}
                onChange={(e) => setMemoryFact(e.target.value)}
                placeholder="el paquete de tests es bun"
              />
              <button
                type="submit"
                disabled={
                  createMemory.isPending || !signedIn || !memoryFact.trim()
                }
              >
                {createMemory.isPending ? "Guardando…" : "Guardar"}
              </button>
            </form>

            <h2>Reglas</h2>
            <label>
              <input
                type="checkbox"
                checked={detail.data.workspace.userRulesEnabled !== false}
                onChange={(e) => {
                  void toggleUserRules
                    .mutateAsync(e.target.checked)
                    .then(() => detail.refetch())
                    .catch((err) =>
                      setMsg({ kind: "error", text: formatQueryError(err) }),
                    );
                }}
              />{" "}
              Aplicar reglas de usuario en este workspace
            </label>
            {detail.data.daemonBound ? (
              <div style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setRulesError(null);
                    void (async () => {
                      try {
                        await ensureBound();
                        const res = await rulesSnap.mutateAsync();
                        const snap = (
                          res.data as { snapshot?: WorkspaceRulesSnapshot }
                        )?.snapshot;
                        if (snap) {
                          setRules(snap);
                          setLocalDraft(snap.localContent || "");
                        }
                      } catch (err) {
                        setRulesError(
                          formatQueryError(err).includes("No daemon bound")
                            ? NO_DAEMON_ERROR
                            : formatQueryError(err),
                        );
                      }
                    })();
                  }}
                >
                  {rulesSnap.isPending ? "Cargando…" : "Cargar proyecto/local"}
                </button>
                {rulesError ? <p className="error">{rulesError}</p> : null}
                {rules ? (
                  <>
                    <p className="muted" style={{ fontSize: "0.85rem" }}>
                      {rules.localPath}
                    </p>
                    <ul>
                      {(rules.project || []).map((r) => (
                        <li key={r.id ?? r.path ?? r.title}>
                          <span className="badge">project</span> {r.title}
                          {r.path ? <code> {r.path}</code> : null}
                        </li>
                      ))}
                      {(rules.local || []).map((r) => (
                        <li key={r.id ?? r.path ?? r.title}>
                          <span className="badge">local</span> {r.title}
                          {r.path ? <code> {r.path}</code> : null}
                        </li>
                      ))}
                    </ul>
                    <label htmlFor="local-rules">
                      Reglas locales (esta máquina)
                    </label>
                    <textarea
                      id="local-rules"
                      value={localDraft}
                      onChange={(e) => setLocalDraft(e.target.value)}
                      rows={8}
                      placeholder={`---
disallowTools: [bash]
---
No uses bash en este workspace.
`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setRulesError(null);
                        void (async () => {
                          try {
                            await ensureBound();
                            const res = await rulesLocalSet.mutateAsync(
                              localDraft,
                            );
                            const snap = (
                              res.data as {
                                snapshot?: WorkspaceRulesSnapshot;
                              }
                            )?.snapshot;
                            if (snap) {
                              setRules(snap);
                              setLocalDraft(snap.localContent || localDraft);
                            }
                            setMsg({
                              kind: "ok",
                              text: "Reglas locales guardadas.",
                            });
                          } catch (err) {
                            setRulesError(
                              formatQueryError(err).includes("No daemon bound")
                                ? NO_DAEMON_ERROR
                                : formatQueryError(err),
                            );
                          }
                        })();
                      }}
                    >
                      {rulesLocalSet.isPending ? "Guardando…" : "Guardar local"}
                    </button>
                  </>
                ) : null}
              </div>
            ) : (
              <p className="error">{NO_DAEMON_ERROR}</p>
            )}

            <FileTreePanel
              workspacePath={detail.data?.workspace?.path}
              workspaceId={workspaceId}
              onAttach={({ path, isDir }) => {
                const chatId = sessions
                  .flatMap((s) => s.chats || [])
                  .map((c) => c.id)[0];
                if (!chatId) {
                  setMsg({
                    kind: "error",
                    text: "Crea un chat para adjuntar @ desde el árbol.",
                  });
                  return;
                }
                const dir = isDir ? "&dir=1" : "";
                window.location.href = `/chats/${chatId}?attach=${encodeURIComponent(path)}${dir}`;
              }}
            />

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
