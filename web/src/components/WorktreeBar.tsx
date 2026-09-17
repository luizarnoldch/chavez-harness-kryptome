import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnections } from "../lib/hooks";
import { queryKeys } from "../lib/query-keys";
import { useWs } from "../lib/ws-context";
import {
  useWsBind,
  useWsWorktreeAdd,
  useWsWorktreeList,
  useWsWorktreeSelect,
} from "../lib/ws-hooks";
import {
  NO_DAEMON_ERROR,
  WEB_CWD_SEP,
  WEB_WORKTREE_BADGE,
  WORKTREE_MAIN_TOKEN,
  WORKTREE_NO_GIT_UI,
} from "../lib/worktree-constants";

const NO_FS_COPY =
  "No hay filesystem: arranca el daemon en este workspace (`chavez headless workspace open` o `chavez tui`).";
const WORKTREE_REQUIRES_GIT =
  "Worktree requires a git repository in the workspace";

type WorktreeEntry = {
  path: string;
  branch: string | null;
  isMain: boolean;
};

type WorktreeSnapshot = {
  isRepo: boolean;
  cwd: string;
  hostname: string;
  bindPath: string;
  current: WorktreeEntry | null;
  worktrees: WorktreeEntry[];
};

function shortPath(p: string): string {
  const parts = p.replace(/\/$/, "").split("/");
  return parts.length <= 2 ? p : parts.slice(-2).join("/");
}

function findDaemon(
  connections: ReturnType<typeof useConnections>["data"],
  workspaceId?: string,
) {
  return (connections || []).find(
    (c) =>
      c.clientKind === "daemon" &&
      (!workspaceId || c.workspaceId === workspaceId),
  );
}

export function WorktreeBar({ workspaceId }: { workspaceId?: string }) {
  const connections = useConnections(Boolean(workspaceId));
  const ws = useWs();
  const qc = useQueryClient();
  const bind = useWsBind();
  const listMut = useWsWorktreeList();
  const selectMut = useWsWorktreeSelect();
  const addMut = useWsWorktreeAdd();
  const daemon = findDaemon(connections.data, workspaceId);

  const [snapshot, setSnapshot] = useState<WorktreeSnapshot | null>(null);
  const [labelHost, setLabelHost] = useState<string | null>(null);
  const [labelCwd, setLabelCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [newPath, setNewPath] = useState("");

  const hostname =
    labelHost ?? snapshot?.hostname ?? daemon?.hostname ?? "daemon";
  const cwd =
    labelCwd ?? snapshot?.cwd ?? daemon?.cwd ?? daemon?.path ?? "";
  const isRepo = snapshot?.isRepo ?? true;
  const busy = Boolean(daemon?.turnBusy);
  const controlsDisabled =
    !isRepo || busy || listMut.isPending || selectMut.isPending || addMut.isPending;

  function showError(msg: string | undefined | null) {
    if (msg) setError(msg);
  }

  async function refreshList() {
    if (!daemon?.path) return;
    setError(null);
    try {
      await bind.mutateAsync(daemon.path);
      const res = await listMut.mutateAsync();
      if (!res.ok) {
        showError(res.error);
        return;
      }
      const snap = res.data as WorktreeSnapshot;
      setSnapshot(snap);
      setLabelHost(snap.hostname ?? daemon.hostname ?? null);
      setLabelCwd(snap.cwd ?? daemon.cwd ?? daemon.path ?? null);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!daemon?.path || ws.status !== "open") return;
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on daemon bind path
  }, [daemon?.path, ws.status, workspaceId]);

  useEffect(() => {
    return ws.onPush((ev) => {
      if (ev.type !== "workspace.cwd.changed") return;
      const data = (ev.data || {}) as {
        workspaceId?: string;
        hostname?: string | null;
        cwd?: string;
        snapshot?: WorktreeSnapshot;
      };
      if (workspaceId && data.workspaceId !== workspaceId) return;
      if (data.hostname) setLabelHost(data.hostname);
      if (data.cwd) setLabelCwd(data.cwd);
      if (data.snapshot) setSnapshot(data.snapshot);
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
    });
  }, [ws, workspaceId, qc]);

  async function onSelect(path: string) {
    if (controlsDisabled) return;
    setError(null);
    try {
      if (daemon?.path) await bind.mutateAsync(daemon.path);
      const res = await selectMut.mutateAsync({ path });
      if (!res.ok) {
        showError(res.error);
        return;
      }
      const snap = res.data as WorktreeSnapshot;
      setSnapshot(snap);
      setLabelHost(snap.hostname ?? daemon?.hostname ?? null);
      setLabelCwd(snap.cwd ?? daemon?.cwd ?? daemon?.path ?? null);
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (controlsDisabled) return;
    const branch = newBranch.trim();
    if (!branch) return;
    setError(null);
    try {
      if (daemon?.path) await bind.mutateAsync(daemon.path);
      const res = await addMut.mutateAsync({
        branch,
        path: newPath.trim() || undefined,
        createBranch: true,
      });
      if (!res.ok) {
        showError(res.error);
        return;
      }
      const snap = res.data as WorktreeSnapshot;
      setSnapshot(snap);
      setLabelHost(snap.hostname ?? daemon?.hostname ?? null);
      setLabelCwd(snap.cwd ?? daemon?.cwd ?? daemon?.path ?? null);
      setNewBranch("");
      setNewPath("");
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!daemon) {
    return <p className="muted worktree-bar">{NO_FS_COPY}</p>;
  }

  return (
    <div className="worktree-bar">
      <code>
        {hostname}
        {WEB_CWD_SEP}
        {cwd}
      </code>
      {snapshot?.current && !snapshot.current.isMain && (
        <span className="badge">{WEB_WORKTREE_BADGE}</span>
      )}
      {snapshot && !snapshot.isRepo && (
        <p className="muted" style={{ margin: 0, flexBasis: "100%" }}>
          {WORKTREE_NO_GIT_UI}
        </p>
      )}
      {snapshot?.isRepo && (
        <>
          <select
            aria-label="Worktree"
            value={snapshot.current?.path ?? ""}
            disabled={controlsDisabled}
            onChange={(e) => {
              const path = e.target.value;
              if (path) void onSelect(path);
            }}
          >
            {(snapshot.worktrees || []).map((w) => (
              <option key={w.path} value={w.path}>
                {(w.branch || "detached") + WEB_CWD_SEP + shortPath(w.path)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={controlsDisabled}
            onClick={() => void onSelect(WORKTREE_MAIN_TOKEN)}
          >
            Main
          </button>
          <form
            onSubmit={onAdd}
            style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}
          >
            <input
              placeholder="rama"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              disabled={controlsDisabled}
              aria-label="Nueva rama"
            />
            <input
              placeholder="path (opcional)"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              disabled={controlsDisabled}
              aria-label="Path opcional"
            />
            <button type="submit" disabled={controlsDisabled || !newBranch.trim()}>
              {addMut.isPending ? "Creando…" : "Crear worktree"}
            </button>
          </form>
        </>
      )}
      {error && (
        <p className="error" style={{ margin: 0, flexBasis: "100%" }}>
          {error}
        </p>
      )}
    </div>
  );
}
