import { useState, type FormEvent } from "react";
import { AppProviders } from "./AppProviders";
import {
  formatQueryError,
  useCreateMemory,
  useDeleteMemory,
  useMe,
  useMemories,
  type MemoryRecord,
} from "../lib/hooks";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function MemoryPanelInner() {
  const me = useMe();
  const signedIn = Boolean(me.data);
  const list = useMemories(null, signedIn);
  const create = useCreateMemory();
  const del = useDeleteMemory();
  const [fact, setFact] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await create.mutateAsync({
        fact: fact.trim(),
        scope: "user",
      });
      setFact("");
      setMsg({ kind: "ok", text: "Recuerdo guardado." });
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

  const memories: MemoryRecord[] = list.data?.memories ?? [];

  return (
    <div>
      <p className="muted">
        <a href="/">Hub</a> / Memoria
      </p>
      <div className="panel">
        <h1>Memoria de usuario</h1>
        <p className="muted">
          Esto no es AGENTS.md. Los facts cruzan chats y workspaces. Bórralos
          aquí o en la TUI.
        </p>
        {!me.isLoading && !signedIn && (
          <p className="error">
            No autorizado — <a href="/sign-in?redirect=/memory">Sign in</a>
          </p>
        )}
        {list.isLoading && signedIn && <p className="muted">Cargando…</p>}
        {list.isError && (
          <p className="error">{formatQueryError(list.error)}</p>
        )}
        {memories.length === 0 && signedIn && !list.isLoading && (
          <p className="muted">Sin recuerdos de usuario.</p>
        )}
        {memories.map((m) => (
          <div
            key={m.id}
            className="panel"
            style={{ marginBottom: "0.75rem" }}
          >
            <p style={{ margin: 0 }}>
              <strong>{m.title}</strong>{" "}
              <span className="badge">{m.scope}</span>
            </p>
            <p style={{ margin: "0.5rem 0" }}>{m.fact}</p>
            <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
              {formatDate(m.createdAt)}
            </p>
            <p>
              <button
                type="button"
                className="secondary"
                disabled={del.isPending}
                onClick={() => void remove(m.id)}
              >
                Borrar
              </button>
            </p>
          </div>
        ))}

        <form onSubmit={onCreate} style={{ marginTop: "1rem" }}>
          <h2>Nuevo recuerdo</h2>
          <label htmlFor="memory-fact">Fact</label>
          <textarea
            id="memory-fact"
            rows={4}
            value={fact}
            onChange={(e) => setFact(e.target.value)}
            placeholder="responde en español"
          />
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Scope: <span className="badge">user</span> (capa cuenta)
          </p>
          <button
            type="submit"
            disabled={create.isPending || !signedIn || !fact.trim()}
          >
            {create.isPending ? "Guardando…" : "Guardar"}
          </button>
        </form>
        {msg ? (
          <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>
        ) : null}
      </div>
    </div>
  );
}

export function MemoryPanel() {
  return (
    <AppProviders>
      <MemoryPanelInner />
    </AppProviders>
  );
}
