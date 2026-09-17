import { useCallback, useEffect, useState } from "react";
import { formatQueryError } from "../lib/hooks";
import { useWs } from "../lib/ws-context";
import {
  useWsBind,
  useWsFsPreview,
  useWsFsSearch,
  useWsFsTree,
  type FsCandidate,
  type FsTreeEntry,
} from "../lib/ws-hooks";
import {
  FilePreviewPanel,
  type FilePreviewData,
} from "./FilePreviewPanel";

const NO_FS_COPY =
  "No hay filesystem: arranca el daemon en este workspace (`chavez headless workspace open` o `chavez tui`). El árbol no lista el disco del servidor.";

const SEARCH_DEBOUNCE_MS = 120;

export type FileTreeAttachHandler = (entry: {
  path: string;
  isDir: boolean;
}) => void;

type NodeState = FsTreeEntry & {
  expanded?: boolean;
  loading?: boolean;
  children?: NodeState[] | null;
  truncated?: boolean;
};

function isNoDaemon(err: string): boolean {
  return /daemon bound/i.test(err) || /no hay filesystem/i.test(err);
}

export function FileTreePanel({
  workspacePath,
  onAttach,
}: {
  workspacePath: string | undefined;
  onAttach?: FileTreeAttachHandler;
}) {
  const ws = useWs();
  const bind = useWsBind();
  const tree = useWsFsTree();
  const search = useWsFsSearch();
  const previewMut = useWsFsPreview();
  const [hostname, setHostname] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [roots, setRoots] = useState<NodeState[]>([]);
  const [rootTruncated, setRootTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FsCandidate[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  void onAttach;

  const loadDir = useCallback(
    async (
      rel: string,
    ): Promise<{ entries: FsTreeEntry[]; truncated: boolean } | null> => {
      if (!workspacePath) {
        setErr("Workspace sin path");
        return null;
      }
      try {
        await bind.mutateAsync(workspacePath);
        const res = await tree.mutateAsync({ path: rel });
        if (!res.ok) {
          setErr(res.error || "fs.tree failed");
          return null;
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
        if (data.error) setErr(data.error);
        else setErr(null);
        return {
          entries: Array.isArray(data.entries) ? data.entries : [],
          truncated: Boolean(data.truncated),
        };
      } catch (e) {
        setErr(formatQueryError(e));
        return null;
      }
    },
    [workspacePath, bind, tree],
  );

  useEffect(() => {
    if (ws.status !== "open" || !workspacePath) return;
    void loadDir(".").then((r) => {
      if (!r) {
        setRoots([]);
        return;
      }
      setRoots(r.entries.map((e) => ({ ...e, children: e.isDir ? null : [] })));
      setRootTruncated(r.truncated);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.status, workspacePath]);

  const displayErr = err
    ? isNoDaemon(err)
      ? NO_FS_COPY
      : err
    : null;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches([]);
      setSearchTruncated(false);
      setSearchErr(null);
      return;
    }
    if (displayErr) return;
    const t = setTimeout(() => {
      void (async () => {
        try {
          if (workspacePath) await bind.mutateAsync(workspacePath);
          const res = await search.mutateAsync({ query: q });
          if (!res.ok) {
            setSearchErr(res.error || "fs.search failed");
            setMatches([]);
            return;
          }
          const data = (res.data || {}) as {
            hostname?: string | null;
            cwd?: string | null;
            matches?: FsCandidate[];
            truncated?: boolean;
            error?: string;
          };
          if (data.hostname) setHostname(data.hostname);
          if (data.cwd) setCwd(data.cwd);
          setMatches(
            Array.isArray(data.matches) ? data.matches.slice(0, 50) : [],
          );
          setSearchTruncated(Boolean(data.truncated));
          setSearchErr(
            typeof data.error === "string" ? data.error : null,
          );
        } catch (e) {
          setSearchErr(formatQueryError(e));
          setMatches([]);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, displayErr, workspacePath]);

  async function openPreview(path: string) {
    setSelected(path);
    setPreviewLoading(true);
    try {
      if (workspacePath) await bind.mutateAsync(workspacePath);
      const res = await previewMut.mutateAsync({ path });
      if (!res.ok) {
        setPreview({ path, status: "forbidden", error: res.error });
        return;
      }
      const data = (res.data || {}) as FilePreviewData;
      setPreview({ ...data, path: data.path || path });
    } catch (e) {
      setPreview({ path, status: "forbidden", error: formatQueryError(e) });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function toggle(path: string) {
    const patch = async (nodes: NodeState[]): Promise<NodeState[]> => {
      const out: NodeState[] = [];
      for (const n of nodes) {
        if (n.path !== path) {
          out.push(
            n.children?.length
              ? { ...n, children: await patch(n.children) }
              : n,
          );
          continue;
        }
        if (!n.isDir) {
          out.push(n);
          continue;
        }
        if (n.expanded) {
          out.push({ ...n, expanded: false });
          continue;
        }
        if (n.children) {
          out.push({ ...n, expanded: true });
          continue;
        }
        const r = await loadDir(n.path);
        out.push({
          ...n,
          expanded: true,
          loading: false,
          truncated: r?.truncated,
          children: (r?.entries || []).map((e) => ({
            ...e,
            children: e.isDir ? null : [],
          })),
        });
      }
      return out;
    };
    setRoots(await patch(roots));
  }

  function renderNodes(nodes: NodeState[], depth: number) {
    return (
      <ul
        className="file-tree-list"
        style={{ paddingLeft: depth ? "0.9rem" : 0 }}
      >
        {nodes.map((n) => (
          <li key={n.path}>
            {n.isDir ? (
              <button
                type="button"
                className={`file-tree-item ${selected === n.path ? "active" : ""}`}
                onClick={() => {
                  setSelected(n.path);
                  void toggle(n.path);
                }}
              >
                {n.expanded ? "▾" : "▸"} {n.name}/
              </button>
            ) : (
              <button
                type="button"
                className={`file-tree-item ${selected === n.path ? "active" : ""}`}
                onClick={() => void openPreview(n.path)}
              >
                {n.name}
              </button>
            )}
            {n.isDir &&
              n.expanded &&
              n.children &&
              renderNodes(n.children, depth + 1)}
            {n.isDir && n.expanded && n.truncated && (
              <p
                className="muted"
                style={{ fontSize: "0.75rem", margin: "0.15rem 0 0 1rem" }}
              >
                Listado truncado a 200 entradas.
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="panel file-tree">
      <h2>Archivos</h2>
      <p className="muted file-tree-host" style={{ fontSize: "0.85rem" }}>
        {hostname || "—"} · {cwd || workspacePath || "sin daemon"}
      </p>
      {displayErr && <p className="error">{displayErr}</p>}
      <label htmlFor="file-tree-q">Buscar por nombre</label>
      <input
        id="file-tree-q"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="ej. auth"
        disabled={Boolean(displayErr)}
      />
      {searchErr && <p className="error">{searchErr}</p>}
      {query.trim() && (
        <ul className="file-tree-list file-tree-search">
          {matches.map((m) => (
            <li key={m.path}>
              <button
                type="button"
                className={`file-tree-item ${selected === m.path ? "active" : ""}`}
                onClick={() => void openPreview(m.path)}
              >
                {m.isDir ? `${m.path}/` : m.path}
              </button>
            </li>
          ))}
          {matches.length === 0 && !searchErr && (
            <li className="muted">Sin coincidencias</li>
          )}
        </ul>
      )}
      {searchTruncated && (
        <p className="muted">Mostrando 50 matches.</p>
      )}
      <div className="file-tree-split">
        <div>
          {!displayErr && renderNodes(roots, 0)}
          {roots.length === 0 && !displayErr && (
            <p className="muted">Vacío (o todo ignorado).</p>
          )}
          {rootTruncated && (
            <p className="muted">Listado truncado a 200 entradas.</p>
          )}
        </div>
        <FilePreviewPanel data={preview} loading={previewLoading} />
      </div>
    </div>
  );
}
