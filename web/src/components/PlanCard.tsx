import { useState } from "react";
import {
  asPlanMeta,
  PLAN_STATUS_CURRENT,
} from "../lib/plan-artifact";

export function PlanCard({
  m,
  onSave,
  onApply,
  onSetCurrent,
  busy,
}: {
  m: {
    id: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  };
  onSave: (markdown: string) => Promise<void>;
  onApply: () => Promise<void>;
  onSetCurrent: () => Promise<void>;
  busy?: boolean;
}) {
  const meta = asPlanMeta(m.metadata)!;
  const current = meta.status === PLAN_STATUS_CURRENT;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className={`panel plan-card ${current ? "plan-current" : "plan-history"}`}>
      <div className="plan-card-head">
        <span className={`badge ${current ? "ok" : ""}`}>
          plan · {meta.status}
          {meta.pendingApply ? " · apply-next" : ""}
          {` · r${meta.revision}`}
        </span>
        {meta.appliedAt && (
          <span className="muted"> aplicado {meta.appliedAt}</span>
        )}
      </div>
      {editing ? (
        <textarea
          className="plan-editor"
          rows={16}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <pre className="plan-body">{m.content}</pre>
      )}
      {err && <p className="error">{err}</p>}
      <div className="plan-actions">
        {editing ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setErr(null);
                try {
                  await onSave(draft);
                  setEditing(false);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Guardar
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDraft(m.content);
                setEditing(false);
                setErr(null);
              }}
            >
              Cancelar
            </button>
          </>
        ) : (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Editar
          </button>
        )}
        {current ? (
          <button type="button" disabled={busy} onClick={() => void onApply().catch((e) => setErr(e instanceof Error ? e.message : String(e)))}>
            Aplicar
          </button>
        ) : (
          <button type="button" className="secondary" disabled={busy} onClick={() => void onSetCurrent()}>
            Marcar actual
          </button>
        )}
      </div>
    </div>
  );
}
