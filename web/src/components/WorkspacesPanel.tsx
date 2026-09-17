import { useEffect, useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useConnections,
  useMe,
  useWorkspaces,
} from "../lib/hooks";
import {
  CLIENT_BIND_HINT,
  EMPTY_WORKSPACE_COPY,
  NO_RUNNER_LABEL,
  workspaceEmptyKind,
} from "../lib/onboarding";
import { formatLastSeen } from "../lib/last-seen";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsUnbind } from "../lib/ws-hooks";
import { DaemonPresence } from "./DaemonPresence";
import { useNotifications } from "../lib/notification-context";
import type { HydrateConnection } from "../lib/notification-hydrate";

function WorkspacesPanelInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const workspaces = useWorkspaces(signedIn);
  const connections = useConnections(signedIn);
  const notices = useNotifications();
  const ws = useWs();
  const bind = useWsBind();
  const unbind = useWsUnbind();
  const [path, setPath] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (!connections.data) return;
    const rows = Array.isArray(connections.data)
      ? (connections.data as HydrateConnection[])
      : (connections.data as { connections?: HydrateConnection[] }).connections ||
        [];
    for (const w of workspaces.data || []) {
      notices.apply("daemon.presence", {
        bound: rows.some(
          (c) =>
            c.clientKind === "daemon" &&
            (!c.workspaceId || c.workspaceId === w.id),
        ),
        workspaceId: w.id,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate daemon per workspace on reload
  }, [connections.data, workspaces.data]);

  const authError =
    !me.isLoading && !signedIn
      ? "No autorizado — inicia sesión primero"
      : null;

  const anyDaemon = (workspaces.data || []).some((w) => w.daemonBound);
  const emptyKind = workspaceEmptyKind({
    daemonBound: anyDaemon,
    workspaceCount: workspaces.data?.length ?? 0,
  });

  async function onBind(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await bind.mutateAsync(path.trim());
      setMsg({ kind: "ok", text: "Workspace bound." });
      setPath("");
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / Workspaces
      </p>
      <div className="panel">
        <h1>Workspaces</h1>
        <p>
          WebSocket:{" "}
          <span
            className={`badge ${ws.status === "open" ? "ok" : ws.status === "error" ? "err" : ""}`}
          >
            {ws.status}
          </span>
        </p>
        {me.isLoading && <p className="muted">Comprobando sesión…</p>}
        {authError && (
          <p className="error">
            {authError} — <a href="/sign-in?redirect=/workspaces">Sign in</a>
          </p>
        )}
        {signedIn && emptyKind === "copy" && (
          <>
            <p>{EMPTY_WORKSPACE_COPY}</p>
            <pre>{`chavez tui
chavez headless workspace open`}</pre>
            <p className="muted">{CLIENT_BIND_HINT}</p>
          </>
        )}
        {signedIn && emptyKind === "sin_runner" && (
          <p>{EMPTY_WORKSPACE_COPY}</p>
        )}
        {signedIn && (
          <details style={{ marginBottom: "1rem" }}>
            <summary>Bind de cliente (avanzado)</summary>
            <form onSubmit={onBind} style={{ marginTop: "0.75rem" }}>
              <label htmlFor="path">Bind path (absoluto)</label>
              <input
                id="path"
                required
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/user/proyecto"
              />
              <button
                type="submit"
                disabled={bind.isPending || ws.status !== "open"}
              >
                {bind.isPending ? "Binding…" : "workspace.bind"}
              </button>
              <button
                type="button"
                className="secondary"
                style={{ marginLeft: "0.5rem" }}
                disabled={unbind.isPending || ws.status !== "open"}
                onClick={() =>
                  unbind.mutate(undefined, {
                    onError: (err) =>
                      setMsg({ kind: "error", text: formatQueryError(err) }),
                    onSuccess: () =>
                      setMsg({ kind: "ok", text: "Unbound." }),
                  })
                }
              >
                unbind
              </button>
              {msg && (
                <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
              )}
              {ws.status !== "open" && signedIn && (
                <p className="muted">
                  Esperando conexión WS (cookie de sesión)…
                </p>
              )}
            </form>
          </details>
        )}
        {workspaces.isLoading && signedIn && (
          <p className="muted">Cargando workspaces…</p>
        )}
        {workspaces.isError && (
          <p className="error">{formatQueryError(workspaces.error)}</p>
        )}
        <ul>
          {(workspaces.data || []).map((w) => (
            <li key={w.id}>
              <a href={`/workspaces/${w.id}`}>
                <code>{w.path || w.name || w.id}</code>
              </a>{" "}
              {!w.daemonBound && (
                <span className="badge err" style={{ marginLeft: "0.5rem" }}>
                  {NO_RUNNER_LABEL}
                </span>
              )}
              {typeof w.openConnections === "number" && (
                <span className="badge" style={{ marginLeft: "0.5rem" }}>
                  {w.openConnections} conn
                </span>
              )}
              <DaemonPresence
                bound={w.daemonBound}
                hostname={w.daemonHostname}
                path={w.daemonPath || w.path}
                lastSeen={w.daemonLastSeen}
              />
            </li>
          ))}
        </ul>
      </div>
      <div className="panel">
        <h2>Connections abiertas</h2>
        {connections.isLoading && signedIn && (
          <p className="muted">Cargando…</p>
        )}
        {connections.isError && (
          <p className="error">{formatQueryError(connections.error)}</p>
        )}
        {signedIn &&
          !connections.isLoading &&
          (connections.data?.length ?? 0) === 0 && (
            <p className="muted">Ninguna conexión WS abierta.</p>
          )}
        <ul>
          {(connections.data || []).map((c, i) => (
            <li key={c.connectionId || c.id || String(i)}>
              <code>
                {c.hostname || "—"} · {c.path || "unbound"} ·{" "}
                {c.clientKind || "client"} · {c.role || "—"} · last-seen{" "}
                {formatLastSeen(c.lastSeen)}
              </code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function WorkspacesPanel() {
  return (
    <AppProviders>
      <WorkspacesPanelInner />
    </AppProviders>
  );
}
