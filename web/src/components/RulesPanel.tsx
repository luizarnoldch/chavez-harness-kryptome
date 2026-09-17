import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useCreateUserRule,
  useDeleteUserRule,
  useMe,
  usePatchUserRule,
  useUserRules,
  type UserRule,
} from "../lib/hooks";

function parseTools(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function RulesPanelInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const list = useUserRules(signedIn);
  const create = useCreateUserRule();
  const patch = usePatchUserRule();
  const del = useDeleteUserRule();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [disallow, setDisallow] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editDisallow, setEditDisallow] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  function startEdit(r: UserRule) {
    setEditingId(r.id);
    setEditTitle(r.title);
    setEditBody(r.body);
    setEditDisallow((r.disallowTools || []).join(", "));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await create.mutateAsync({
        title: title.trim(),
        body,
        enabled: true,
        disallowTools: parseTools(disallow),
      });
      setTitle("");
      setBody("");
      setDisallow("");
      setMsg({ kind: "ok", text: "Regla creada." });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setMsg(null);
    try {
      await patch.mutateAsync({
        id: editingId,
        title: editTitle.trim(),
        body: editBody,
        disallowTools: parseTools(editDisallow),
      });
      setEditingId(null);
      setMsg({ kind: "ok", text: "Regla actualizada." });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / Reglas de usuario
      </p>
      <div className="panel">
        <h1>Reglas de usuario</h1>
        <p className="muted">
          Capa cuenta: viajan entre workspaces. No hace falta daemon. Máximo 50.
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado — <a href="/sign-in?redirect=/rules">Sign in</a>
          </p>
        )}
        {list.isLoading && signedIn && <p className="muted">Cargando…</p>}
        {list.isError && (
          <p className="error">{formatQueryError(list.error)}</p>
        )}
        {(list.data?.rules ?? []).map((r) => (
          <div key={r.id} className="panel" style={{ marginBottom: "0.75rem" }}>
            <p style={{ margin: 0 }}>
              <strong>{r.title}</strong>{" "}
              <span className="badge">{r.enabled ? "on" : "off"}</span>
              {r.disallowTools?.length ? (
                <span className="badge">disallow {r.disallowTools.join(",")}</span>
              ) : null}
            </p>
            {editingId === r.id ? (
              <form onSubmit={onSaveEdit} style={{ marginTop: "0.5rem" }}>
                <label htmlFor={`t-${r.id}`}>Título</label>
                <input
                  id={`t-${r.id}`}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
                <label htmlFor={`b-${r.id}`}>Cuerpo</label>
                <textarea
                  id={`b-${r.id}`}
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={8}
                />
                <label htmlFor={`d-${r.id}`}>disallowTools (comma)</label>
                <input
                  id={`d-${r.id}`}
                  value={editDisallow}
                  onChange={(e) => setEditDisallow(e.target.value)}
                  placeholder="bash"
                />
                <button type="submit" disabled={patch.isPending}>
                  Guardar
                </button>{" "}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditingId(null)}
                >
                  Cancelar
                </button>
              </form>
            ) : (
              <p style={{ marginTop: "0.5rem" }}>
                <button type="button" className="secondary" onClick={() => startEdit(r)}>
                  Editar
                </button>{" "}
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void patch.mutateAsync({ id: r.id, enabled: !r.enabled })
                  }
                >
                  {r.enabled ? "Desactivar" : "Activar"}
                </button>{" "}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void del.mutateAsync(r.id)}
                >
                  Borrar
                </button>
              </p>
            )}
          </div>
        ))}

        <form onSubmit={onCreate} style={{ marginTop: "1rem" }}>
          <h2>Nueva regla</h2>
          <label htmlFor="new-title">Título</label>
          <input
            id="new-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="español"
          />
          <label htmlFor="new-body">Cuerpo</label>
          <textarea
            id="new-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="responde en español"
          />
          <label htmlFor="new-disallow">disallowTools (comma: bash)</label>
          <input
            id="new-disallow"
            value={disallow}
            onChange={(e) => setDisallow(e.target.value)}
            placeholder="bash"
          />
          <button type="submit" disabled={create.isPending || !signedIn}>
            {create.isPending ? "Creando…" : "Crear"}
          </button>
        </form>
        {msg ? (
          <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
        ) : null}
      </div>
    </div>
  );
}

export function RulesPanel() {
  return (
    <AppProviders>
      <RulesPanelInner />
    </AppProviders>
  );
}
