import { readFileSync, statSync, existsSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";
import {
  DIFF_SNAPSHOT_MAX_BYTES,
  NO_GIT_FOR_BASH,
  toPosixRel,
  type DiffStatus,
} from "./diff-constants";
import {
  computeUnifiedDiff,
  emptySnapshot,
  isBinaryBuffer,
  type ComputedDiff,
  type Snapshot,
} from "./unified-diff";
import { proposedAfterSnapshot, toolPathFromInput } from "./proposed-edit";
import { changedPaths, gitPorcelain, type PorcelainEntry } from "./git-porcelain";

export type PublishedDiff = ComputedDiff & {
  status: DiffStatus;
  toolCallId: string | null;
};

function relToCwd(cwd: string, p: string): string {
  const abs = isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : join(cwd, p);
  return toPosixRel(relative(cwd, abs) || p);
}

export function readSnapshot(cwd: string, relOrAbs: string): Snapshot {
  const rel = relToCwd(cwd, relOrAbs);
  const abs = isAbsolute(relOrAbs) || /^[A-Za-z]:/.test(relOrAbs) ? relOrAbs : join(cwd, rel);
  if (!existsSync(abs)) return emptySnapshot();
  let st;
  try {
    st = statSync(abs);
  } catch {
    return emptySnapshot();
  }
  if (st.isDirectory()) {
    return { existed: true, text: null, binary: true, tooBig: false, byteSize: 0 };
  }
  const byteSize = st.size;
  if (byteSize > DIFF_SNAPSHOT_MAX_BYTES) {
    const buf = readFileSync(abs).subarray(0, Math.min(64_000, DIFF_SNAPSHOT_MAX_BYTES));
    const binary = isBinaryBuffer(buf);
    return {
      existed: true,
      text: binary ? null : buf.toString("utf8"),
      binary,
      tooBig: true,
      byteSize,
    };
  }
  const buf = readFileSync(abs);
  const binary = isBinaryBuffer(buf);
  return {
    existed: true,
    text: binary ? null : buf.toString("utf8"),
    binary,
    tooBig: false,
    byteSize,
  };
}

const PATH_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

export class TurnDiffCollector {
  private originals = new Map<string, Snapshot>();
  private toolCallByPath = new Map<string, string>();
  private bashBefore: PorcelainEntry[] | null = null;
  private bashNoted = false;
  private dropped = new Set<string>();

  constructor(
    public readonly streamId: string,
    public readonly cwd: string,
  ) {}

  /** Call immediately before returning allow from canUseTool. */
  async beforeAllow(sdkName: string, input: Record<string, unknown> | null, toolCallId: string): Promise<void> {
    if (READ_TOOLS.has(sdkName)) return;
    if (PATH_TOOLS.has(sdkName)) {
      const p = toolPathFromInput(input);
      if (!p) return;
      const rel = relToCwd(this.cwd, p);
      if (!this.originals.has(rel)) {
        this.originals.set(rel, readSnapshot(this.cwd, p));
      }
      this.toolCallByPath.set(rel, toolCallId);
      this.dropped.delete(rel);
      return;
    }
    if (sdkName === "Bash") {
      if (this.bashBefore == null) {
        this.bashBefore = await gitPorcelain(this.cwd);
      }
    }
  }

  propose(
    sdkName: string,
    input: Record<string, unknown> | null,
    toolCallId: string,
  ): PublishedDiff | null {
    if (!PATH_TOOLS.has(sdkName)) return null;
    const p = toolPathFromInput(input);
    if (!p) return null;
    const rel = relToCwd(this.cwd, p);
    const before = this.originals.get(rel) ?? readSnapshot(this.cwd, p);
    if (!this.originals.has(rel)) this.originals.set(rel, before);
    const after = proposedAfterSnapshot(sdkName, input, before);
    if (!after) return null;
    const computed = computeUnifiedDiff({ path: rel, before, after });
    this.toolCallByPath.set(rel, toolCallId);
    return { ...computed, status: "proposed", toolCallId };
  }

  dropProposed(toolCallId: string): string[] {
    const dropped: string[] = [];
    for (const [path, id] of this.toolCallByPath) {
      if (id === toolCallId) {
        this.dropped.add(path);
        dropped.push(path);
      }
    }
    return dropped;
  }

  async afterTool(sdkName: string, input: Record<string, unknown> | null, status: string): Promise<void> {
    if (status === "error") return;
    if (sdkName === "Bash") this.bashNoted = true;
    if (PATH_TOOLS.has(sdkName)) {
      const p = toolPathFromInput(input);
      if (p) this.dropped.delete(relToCwd(this.cwd, p));
    }
  }

  async finalize(): Promise<PublishedDiff[]> {
    if (this.bashNoted) {
      const after = await gitPorcelain(this.cwd);
      if (this.bashBefore && after) {
        for (const p of changedPaths(this.bashBefore, after)) {
          if (this.originals.has(p)) continue;
          const now = readSnapshot(this.cwd, p);
          if (now.existed) {
            this.originals.set(p, emptySnapshot()); // created via bash
          } else {
            this.originals.set(p, {
              existed: true,
              text: "",
              binary: false,
              tooBig: false,
              byteSize: 0,
            });
          }
        }
      }
    }
    const out: PublishedDiff[] = [];
    for (const [path, before] of this.originals) {
      if (this.dropped.has(path)) continue;
      const after = readSnapshot(this.cwd, path);
      const sameText =
        !before.binary &&
        !after.binary &&
        (before.text || "") === (after.text || "") &&
        before.existed === after.existed;
      if (sameText) continue;
      if (!before.existed && !after.existed) continue;
      const computed = computeUnifiedDiff({ path, before, after });
      out.push({
        ...computed,
        status: "applied",
        toolCallId: this.toolCallByPath.get(path) ?? null,
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  bashWithoutGitNotice(): string | null {
    if (this.bashNoted && this.bashBefore == null) return NO_GIT_FOR_BASH;
    return null;
  }
}

export function toUpsertPayload(d: PublishedDiff): Record<string, unknown> {
  return {
    path: d.path,
    kind: d.kind,
    status: d.status,
    toolCallId: d.toolCallId,
    additions: d.additions,
    deletions: d.deletions,
    preview: d.preview,
    body: d.omitted ? null : d.body,
    truncated: d.truncated,
    binary: d.binary,
    omitted: d.omitted,
    byteSize: d.byteSize,
  };
}
