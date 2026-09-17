import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useConnections,
  useMe,
  useWorkspaces,
} from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsUnbind } from "../lib/ws-hooks";

function WorkspacesPanelInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const workspaces = useWorkspaces(signedIn);
  const connections = useConnections(signedIn);
  const ws = useWs();
  const bind = useWsBind();
  const unbind = useWsUnbind();
  const [path, setPath] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const authError =
    !me.isLoading && !signedIn
      ? "No autorizado — inicia sesión primero"
      : null;

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
        {signedIn && (
          <form onSubmit={onBind} style={{ marginBottom: "1rem" }}>
            <label htmlFor="path">Bind path (absoluto)</label>
            <input
              id="path"
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/proyecto"
            />
            <button type="submit" disabled={bind.isPending || ws.status !== "open"}>
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
        )}
        {workspaces.isLoading && signedIn && (
          <p className="muted">Cargando workspaces…</p>
        )}
        {workspaces.isError && (
          <p className="error">{formatQueryError(workspaces.error)}</p>
        )}
        {signedIn &&
          !workspaces.isLoading &&
          !workspaces.isError &&
          (workspaces.data?.length ?? 0) === 0 && (
            <p className="muted">Sin workspaces aún. Haz bind de un path.</p>
          )}
        <ul>
          {(workspaces.data || []).map((w) => (
            <li key={w.id}>
              <a href={`/workspaces/${w.id}`}>
                <code>{w.path || w.name || w.id}</code>
              </a>{" "}
              <span className="muted">
                {w.daemonHostname || "—"} · {w.daemonPath || w.path}
              </span>{" "}
              {w.daemonBound ? (
                <span className="badge ok">daemon</span>
              ) : (
                <span className="badge err">sin runner</span>
              )}
              {typeof w.openConnections === "number" && (
                <span className="badge" style={{ marginLeft: "0.5rem" }}>
                  {w.openConnections} conn
                </span>
              )}
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
                {c.clientKind || "client"} · {c.role || "—"}
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
