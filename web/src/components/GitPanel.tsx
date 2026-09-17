import { useEffect, useState } from "react";
import {
  GITHUB_UNLINKED_UI,
  NO_DAEMON_ERROR,
  NOT_A_GIT_UI,
  formatGitSnapshot,
  type GitHeadDiff,
  type GitSnapshot,
} from "../lib/git-display";
import { queryKeys } from "../lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useWs } from "../lib/ws-context";
import { useWsGitDiff, useWsGitStatus } from "../lib/ws-hooks";

export function GitPanel({
  workspaceId,
  githubLinked,
}: {
  workspaceId?: string;
  githubLinked: boolean;
}) {
  const gitStatus = useWsGitStatus();
  const gitDiff = useWsGitDiff();
  const ws = useWs();
  const qc = useQueryClient();
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [diff, setDiff] = useState<GitHeadDiff | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return ws.onPush((ev) => {
      const data = (ev.data || {}) as Record<string, unknown>;
      if (ev.type === "workspace.git.snapshot") {
        const snap = (data.snapshot || data) as GitSnapshot;
        if (snap && typeof snap === "object" && "isRepo" in snap) {
          setSnapshot(snap);
          if (workspaceId) {
            qc.setQueryData(queryKeys.gitSnapshot(workspaceId), snap);
          }
        }
      }
      if (ev.type === "github.pr.created") {
        const url = String(data.url || "");
        if (url) setPrUrl(url);
      }
      if (ev.type === "chat.tool.result") {
        const message = data.message as { metadata?: Record<string, unknown> } | undefined;
        const meta = (message?.metadata || data.metadata || {}) as Record<string, unknown>;
        if (typeof meta.prUrl === "string" && meta.prUrl) setPrUrl(meta.prUrl);
      }
    });
  }, [ws, qc, workspaceId]);

  async function onStatus() {
    setError(null);
    try {
      const res = await gitStatus.mutateAsync();
      const snap = (res.data as { snapshot?: GitSnapshot } | undefined)?.snapshot;
      if (snap) {
        setSnapshot(snap);
        if (workspaceId) qc.setQueryData(queryKeys.gitSnapshot(workspaceId), snap);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDiff() {
    setError(null);
    try {
      const res = await gitDiff.mutateAsync();
      const d = (res.data as { diff?: GitHeadDiff; snapshot?: GitSnapshot } | undefined);
      if (d?.diff) setDiff(d.diff);
      if (d?.snapshot) setSnapshot(d.snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const notRepo = snapshot && snapshot.isRepo === false;

  return (
    <div className="panel git-panel" style={{ marginBottom: "0.75rem" }}>
      <p style={{ margin: "0 0 0.5rem" }}>
        <span className="badge git">git vs HEAD</span>
        {snapshot?.isRepo ? (
          <span className="muted" style={{ marginLeft: "0.5rem" }}>
            {snapshot.branch || "(detached)"} ↑{snapshot.ahead} ↓{snapshot.behind}{" "}
            dirty={snapshot.dirty.length}
          </span>
        ) : null}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" className="secondary" onClick={() => void onStatus()}>
          {gitStatus.isPending ? "…" : "Git status"}
        </button>
        <button type="button" className="secondary" onClick={() => void onDiff()}>
          {gitDiff.isPending ? "…" : "Diff vs HEAD"}
        </button>
      </div>
      {error ? (
        <p className="error">
          {error.includes("No daemon bound") ? NO_DAEMON_ERROR : error}
        </p>
      ) : null}
      {notRepo ? <p className="muted">{NOT_A_GIT_UI}</p> : null}
      {snapshot?.isRepo ? (
        <pre>{formatGitSnapshot(snapshot)}</pre>
      ) : null}
      {diff?.isRepo ? (
        <pre>
          {diff.truncated ? "[truncated]\n" : ""}
          {[diff.stat, diff.unified].filter(Boolean).join("\n\n")}
        </pre>
      ) : null}
      {prUrl ? (
        <p>
          PR:{" "}
          <a href={prUrl} target="_blank" rel="noreferrer">
            {prUrl}
          </a>
        </p>
      ) : null}
      {!githubLinked ? (
        <p className="muted">
          {GITHUB_UNLINKED_UI}{" "}
          <a href="/providers?provider=github">/providers</a>
        </p>
      ) : null}
    </div>
  );
}
