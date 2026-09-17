import { AppProviders } from "./AppProviders";
import { env } from "../lib/config";
import {
  formatQueryError,
  useHealth,
  useMe,
  useProviders,
  useWorkspaces,
} from "../lib/hooks";
import { useWs } from "../lib/ws-context";

function HubPanelInner() {
  const health = useHealth();
  const me = useMe();
  const signedIn = Boolean(me.data);
  const providers = useProviders(null, signedIn);
  const workspaces = useWorkspaces(signedIn);
  const ws = useWs();

  const healthStatus = health.isLoading
    ? "loading"
    : health.isSuccess && health.data?.ok
      ? "ok"
      : "down";

  const linkedCount = providers.data
    ? Object.values(providers.data.providers || {}).filter((p) => p.linked)
        .length
    : null;
  const runnableCount = providers.data
    ? Object.values(providers.data.providers || {}).filter((p) => p.runnable)
        .length
    : null;

  return (
    <div>
      <header className="panel">
        <h1>Chavez Hub</h1>
        <p>
          Consola web con paridad API: HTTP + WebSocket (cookie) · CLI · TUI
        </p>
        <p>
          API: <code>{env.public.apiUrl}</code>{" "}
          <span
            className={`badge ${healthStatus === "ok" ? "ok" : healthStatus === "down" ? "err" : ""}`}
          >
            {healthStatus === "loading"
              ? "…"
              : healthStatus === "ok"
                ? "online"
                : "offline"}
          </span>
          {" · "}
          WS:{" "}
          <span
            className={`badge ${ws.status === "open" ? "ok" : ws.status === "error" ? "err" : ""}`}
          >
            {ws.status}
          </span>
        </p>
        {health.isError && (
          <p className="error">{formatQueryError(health.error)}</p>
        )}
        <p>
          Web: <code>{env.public.webUrl}</code>
          {" · "}
          <a href={`${env.public.apiUrl}/docs`} target="_blank" rel="noreferrer">
            Swagger /docs
          </a>
        </p>
        {me.isLoading ? (
          <p className="muted">Cargando sesión…</p>
        ) : me.data ? (
          <p className="ok">
            Sesión: {me.data.email || me.data.name || me.data.id}
          </p>
        ) : (
          <p className="muted">
            Sin sesión.{" "}
            <a href="/sign-in">Email + contraseña o magic link</a>
            {" · "}
            <a href="/device">aprobar device del CLI</a>.
          </p>
        )}
        {signedIn && (
          <p className="muted">
            Providers vinculados:{" "}
            {providers.isLoading
              ? "…"
              : providers.isError
                ? formatQueryError(providers.error)
                : `${linkedCount ?? 0} (${runnableCount ?? 0} runnable)`}
            {" · "}
            Workspaces:{" "}
            {workspaces.isLoading
              ? "…"
              : workspaces.isError
                ? formatQueryError(workspaces.error)
                : (workspaces.data?.length ?? 0)}
            {" · "}
            <a href="/providers">Vincular providers</a>
            {" · "}
            <a href="/rules">Reglas de usuario</a>
            {" · "}
            <a href="/sign-in">Definir contraseña</a>
          </p>
        )}
      </header>

      <div className="grid">
        <section className="panel">
          <h2>API</h2>
          <p>Auth, vault, workspaces y WebSocket con cookie o Bearer.</p>
          <pre>{`bun run dev:api`}</pre>
          <a className="btn secondary" href={env.public.apiUrl + "/health"}>
            /health
          </a>{" "}
          <a className="btn secondary" href={env.public.apiUrl + "/docs"}>
            /docs
          </a>
        </section>
        <section className="panel">
          <h2>CLI</h2>
          <p>Login device, headless workspace y launcher TUI.</p>
          <pre>{`chavez login
chavez headless workspace open
chavez tui`}</pre>
          <a className="btn secondary" href="/device">
            Autorizar device
          </a>
        </section>
        <section className="panel">
          <h2>Workspaces</h2>
          <p>Bind path, sessions, chats y mensajes desde el hub.</p>
          <pre>{`/workspaces → sessions → chats`}</pre>
          <a className="btn secondary" href="/workspaces">
            Abrir workspaces
          </a>
        </section>
      </div>
    </div>
  );
}

export function HubPanel() {
  return (
    <AppProviders>
      <HubPanelInner />
    </AppProviders>
  );
}
