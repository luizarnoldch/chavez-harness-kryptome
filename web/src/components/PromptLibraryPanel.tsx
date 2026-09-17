import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useDeletePrompt,
  useMe,
  usePrompts,
  useSavePrompt,
  type SavedPrompt,
} from "../lib/hooks";
import { PROMPT_EMPTY } from "../lib/prompt-library";

function previewBody(body: string): string {
  const t = body.trim();
  if (t.length <= 120) return t;
  return `${t.slice(0, 117)}…`;
}

function PromptLibraryInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const list = usePrompts(signedIn);
  const save = useSavePrompt();
  const del = useDeletePrompt();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await save.mutateAsync({
        name: name.trim(),
        title: title.trim() || undefined,
        body,
      });
      setName("");
      setTitle("");
      setBody("");
      setMsg({ kind: "ok", text: "Prompt guardado" });
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  async function remove(p: SavedPrompt) {
    setMsg(null);
    try {
      await del.mutateAsync(p.name);
    } catch (err) {
      setMsg({ kind: "error", text: formatQueryError(err) });
    }
  }

  const prompts = list.data ?? [];

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / Prompts
      </p>
      <div className="panel">
        <h1>Biblioteca de prompts</h1>
        <p className="muted">
          Briefs de la cuenta. Guardar no dispara un turn. Inserta con{" "}
          <code>#</code> en el compositor.
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado —{" "}
            <a href="/sign-in?redirect=/prompts">Sign in</a>
          </p>
        )}
        {list.isLoading && signedIn && <p className="muted">Cargando…</p>}
        {list.isError && (
          <p className="error">{formatQueryError(list.error)}</p>
        )}
        {prompts.length === 0 && signedIn && !list.isLoading && (
          <p className="muted">{PROMPT_EMPTY}</p>
        )}
        {prompts.map((p) => (
          <div
            key={p.id}
            className="panel"
            style={{ marginBottom: "0.75rem" }}
          >
            <p style={{ margin: 0 }}>
              <code>{p.name}</code> <strong>{p.title}</strong>
            </p>
            <p style={{ margin: "0.5rem 0" }}>{previewBody(p.body)}</p>
            <p>
              <button
                type="button"
                className="secondary"
                disabled={del.isPending}
                onClick={() => void remove(p)}
              >
                Borrar
              </button>
            </p>
          </div>
        ))}

        <form onSubmit={onCreate} style={{ marginTop: "1rem" }}>
          <h2>Nuevo prompt</h2>
          <label htmlFor="prompt-lib-name">Nombre</label>
          <input
            id="prompt-lib-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="review-pr"
            autoComplete="off"
          />
          <label htmlFor="prompt-lib-title">Título (opcional)</label>
          <input
            id="prompt-lib-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Review PR"
            autoComplete="off"
          />
          <label htmlFor="prompt-lib-body">Body</label>
          <textarea
            id="prompt-lib-body"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Revisa este diff…"
          />
          <button
            type="submit"
            disabled={save.isPending || !signedIn || !name.trim() || !body.trim()}
          >
            {save.isPending ? "Guardando…" : "Guardar"}
          </button>
        </form>
        {msg ? (
          <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
        ) : null}
      </div>
    </div>
  );
}

export function PromptLibraryPanel() {
  return (
    <AppProviders>
      <PromptLibraryInner />
    </AppProviders>
  );
}
