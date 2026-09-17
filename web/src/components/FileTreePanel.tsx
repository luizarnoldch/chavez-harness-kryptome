import { useEffect, useState } from "react";
import { formatQueryError } from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import { useWsBind, useWsFsTree, type FsTreeEntry } from "../lib/ws-hooks";

export function FileTreePanel({
  workspacePath,
}: {
  workspacePath: string | undefined;
}) {
  const ws = useWs();
  const bind = useWsBind();
  const tree = useWsFsTree();
  const [rel, setRel] = useState(".");
  const [stack, setStack] = useState<string[]>(["."]);
  const [entries, setEntries] = useState<FsTreeEntry[]>([]);
  const [hostname, setHostname] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  async function load(path: string) {
    setErr(null);
    if (!workspacePath) {
      setErr("Workspace sin path");
      return;
    }
    try {
      await bind.mutateAsync(workspacePath);
      const res = await tree.mutateAsync({ path });
      if (!res.ok) {
        setEntries([]);
        setErr(res.error || "fs.tree failed");
        return;
      }
      const data = (res.data || {}) as {
        hostname?: string | null;
        cwd?: string | null;
        entries?: FsTreeEntry[];
        truncated?: boolean;
        error?: string;
      };
      setHostname(data.hostname ?? null);
      setCwd(data.cwd ?? workspacePath);
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setTruncated(Boolean(data.truncated));
      if (data.error) setErr(data.error);
      setRel(path);
    } catch (e) {
      setEntries([]);
      setErr(formatQueryError(e));
    }
  }

  useEffect(() => {
    if (ws.status === "open" && workspacePath) {
      void load(".");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.status, workspacePath]);

  function enter(dir: FsTreeEntry) {
    if (!dir.isDir) return;
    setStack((s) => [...s, dir.path]);
    void load(dir.path);
  }

  function up() {
    setStack((s) => {
      const next = s.slice(0, -1);
      const dest = next[next.length - 1] || ".";
      void load(dest);
      return next.length ? next : ["."];
    });
  }

  return (
    <div className="panel file-tree">
      <h2>Archivos</h2>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {hostname || "—"} · {cwd || workspacePath || "sin daemon"}
      </p>
      {err && (
        <p className="error">
          {err.includes("daemon bound")
            ? "No hay filesystem: arranca el daemon en este workspace (`chavez headless workspace open` o `chavez tui`). El árbol no lista el disco del servidor."
            : err}
        </p>
      )}
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        cwd relativo: <code>{rel}</code>
        {rel !== "." && (
          <>
            {" "}
            <button type="button" onClick={up}>
              ..
            </button>
          </>
        )}
      </p>
      <ul className="file-tree-list">
        {entries.map((e) => (
          <li key={e.path}>
            {e.isDir ? (
              <button type="button" onClick={() => enter(e)}>
                {e.name}/
              </button>
            ) : (
              <span>{e.name}</span>
            )}
          </li>
        ))}
      </ul>
      {entries.length === 0 && !err && (
        <p className="muted">Vacío (o todo ignorado).</p>
      )}
      {truncated && <p className="muted">Listado truncado a 200 entradas.</p>}
    </div>
  );
}
