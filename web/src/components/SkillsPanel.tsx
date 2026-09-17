import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useCreateSkill,
  useDeleteSkill,
  useMe,
  useSkills,
  useUpdateSkill,
  type UserSkill,
} from "../lib/hooks";

function SkillsPanelInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const list = useSkills(signedIn);
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const del = useDeleteSkill();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editBody, setEditBody] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  function startEdit(skill: UserSkill) {
    setEditingId(skill.id);
    setEditName(skill.name);
    setEditDescription(skill.description);
    setEditBody(skill.body);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        body,
        enabled: true,
      });
      setName("");
      setDescription("");
      setBody("");
      setMsg({ kind: "ok", text: "Skill creada." });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setMsg(null);
    try {
      await update.mutateAsync({
        id: editingId,
        name: editName.trim(),
        description: editDescription.trim(),
        body: editBody,
      });
      setEditingId(null);
      setMsg({ kind: "ok", text: "Skill actualizada." });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function toggle(skill: UserSkill) {
    setMsg(null);
    try {
      await update.mutateAsync({ id: skill.id, enabled: !skill.enabled });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function remove(id: string) {
    setMsg(null);
    try {
      await del.mutateAsync(id);
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / Skills
      </p>
      <div className="panel">
        <h1>Skills de usuario</h1>
        <p className="muted">
          Aplican en todos tus workspaces. Un SKILL.md del repo con el mismo name
          las anula.
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado — <a href="/sign-in?redirect=/skills">Sign in</a>
          </p>
        )}
        {list.isLoading && signedIn && <p className="muted">Cargando…</p>}
        {list.isError && (
          <p className="error">{formatQueryError(list.error)}</p>
        )}
        {(list.data?.skills ?? []).map((skill) => (
          <div
            key={skill.id}
            className="panel"
            style={{ marginBottom: "0.75rem" }}
          >
            <p style={{ margin: 0 }}>
              <strong>{skill.name}</strong>{" "}
              <span className="badge">{skill.enabled ? "on" : "off"}</span>
            </p>
            <p className="muted">{skill.description}</p>
            {editingId === skill.id ? (
              <form onSubmit={onSaveEdit}>
                <label htmlFor={`name-${skill.id}`}>Name</label>
                <input
                  id={`name-${skill.id}`}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <label htmlFor={`description-${skill.id}`}>Descripción</label>
                <input
                  id={`description-${skill.id}`}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
                <label htmlFor={`body-${skill.id}`}>SKILL.md body</label>
                <textarea
                  id={`body-${skill.id}`}
                  rows={10}
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                />
                <button type="submit" disabled={update.isPending}>
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
              <p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => startEdit(skill)}
                >
                  Editar
                </button>{" "}
                <button
                  type="button"
                  className="secondary"
                  disabled={update.isPending}
                  onClick={() => void toggle(skill)}
                >
                  {skill.enabled ? "Desactivar" : "Activar"}
                </button>{" "}
                <button
                  type="button"
                  className="secondary"
                  disabled={del.isPending}
                  onClick={() => void remove(skill.id)}
                >
                  Borrar
                </button>
              </p>
            )}
          </div>
        ))}

        <form onSubmit={onCreate} style={{ marginTop: "1rem" }}>
          <h2>Nueva skill</h2>
          <label htmlFor="new-skill-name">Name</label>
          <input
            id="new-skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="review-code"
          />
          <label htmlFor="new-skill-description">Descripción</label>
          <input
            id="new-skill-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label htmlFor="new-skill-body">SKILL.md body</label>
          <textarea
            id="new-skill-body"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
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

export function SkillsPanel() {
  return (
    <AppProviders>
      <SkillsPanelInner />
    </AppProviders>
  );
}
