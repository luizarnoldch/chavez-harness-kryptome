import { useShareView } from "../lib/hooks";
import { SHARE_READONLY_BANNER } from "../lib/export-share";

export function ShareTimeline({ token }: { token: string }) {
  const view = useShareView(token);
  return (
    <div>
      <div className="panel">
        <p className="muted">{SHARE_READONLY_BANNER}</p>
        {view.isLoading && <p className="muted">Cargando…</p>}
        {view.isError && <p className="error">Share not found</p>}
        {view.data && (
          <>
            <h1>{view.data.title}</h1>
            <p className="muted">{view.data.banner}</p>
            {(view.data.messages || []).map((m, i) => {
              const meta = (m.metadata || {}) as Record<string, unknown>;
              const toolName =
                typeof meta.toolName === "string" ? meta.toolName : null;
              const status =
                typeof meta.status === "string" ? meta.status : null;
              const badge =
                m.role === "tool" && toolName
                  ? `tool · ${toolName} · ${status || "done"}`
                  : m.role;
              return (
                <div key={i} className="panel" style={{ marginBottom: "0.5rem" }}>
                  <span className="badge">{badge}</span>
                  <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>
                    {m.content}
                  </pre>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
