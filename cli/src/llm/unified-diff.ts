import {
  DIFF_BINARY_MARKER,
  DIFF_DELETED_PREVIEW_LINES,
  DIFF_DP_CELL_CAP,
  DIFF_PREVIEW_MAX_CHARS,
  DIFF_PREVIEW_MAX_LINES,
  DIFF_SNAPSHOT_MAX_BYTES,
  type DiffKind,
  diffBodyOmitted,
  diffTruncatedMarker,
  toPosixRel,
} from "./diff-constants";

export type Snapshot = {
  existed: boolean;
  text: string | null;
  binary: boolean;
  tooBig: boolean;
  byteSize: number;
};

export type ComputedDiff = {
  path: string;
  kind: DiffKind;
  additions: number;
  deletions: number;
  preview: string;
  body: string | null;
  truncated: boolean;
  binary: boolean;
  byteSize: number;
  omitted: boolean;
};

function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function isBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Prefix/suffix LCS with DP only when a.length * b.length <= DIFF_DP_CELL_CAP. */
export function diffLines(a: string[], b: string[]): Array<{ type: "eq" | "del" | "add"; line: string }> {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let as = a.length;
  let bs = b.length;
  while (as > pre && bs > pre && a[as - 1] === b[bs - 1]) {
    as -= 1;
    bs -= 1;
  }
  const aa = a.slice(pre, as);
  const bb = b.slice(pre, bs);
  const out: Array<{ type: "eq" | "del" | "add"; line: string }> = [];
  for (let i = 0; i < pre; i++) out.push({ type: "eq", line: a[i]! });

  if (aa.length * bb.length > DIFF_DP_CELL_CAP) {
    for (const line of aa) out.push({ type: "del", line });
    for (const line of bb) out.push({ type: "add", line });
  } else if (aa.length === 0) {
    for (const line of bb) out.push({ type: "add", line });
  } else if (bb.length === 0) {
    for (const line of aa) out.push({ type: "del", line });
  } else {
    const n = aa.length;
    const m = bb.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] =
          aa[i] === bb[j]
            ? (dp[i + 1]![j + 1]! + 1)
            : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (aa[i] === bb[j]) {
        out.push({ type: "eq", line: aa[i]! });
        i += 1;
        j += 1;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        out.push({ type: "del", line: aa[i]! });
        i += 1;
      } else {
        out.push({ type: "add", line: bb[j]! });
        j += 1;
      }
    }
    while (i < n) {
      out.push({ type: "del", line: aa[i]! });
      i += 1;
    }
    while (j < m) {
      out.push({ type: "add", line: bb[j]! });
      j += 1;
    }
  }

  for (let i = as; i < a.length; i++) out.push({ type: "eq", line: a[i]! });
  return out;
}

function hunkify(
  ops: Array<{ type: "eq" | "del" | "add"; line: string }>,
  path: string,
): { text: string; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "add") additions += 1;
    if (op.type === "del") deletions += 1;
  }
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  // Single hunk covering the file (agent edits are typically small).
  const oldCount = ops.filter((o) => o.type !== "add").length;
  const newCount = ops.filter((o) => o.type !== "del").length;
  lines.push(`@@ -1,${oldCount} +1,${newCount} @@`);
  for (const op of ops) {
    if (op.type === "eq") lines.push(` ${op.line}`);
    else if (op.type === "del") lines.push(`-${op.line}`);
    else lines.push(`+${op.line}`);
  }
  return { text: lines.join("\n") + "\n", additions, deletions };
}

export function truncateUnified(
  text: string,
  maxLines = DIFF_PREVIEW_MAX_LINES,
  maxChars = DIFF_PREVIEW_MAX_CHARS,
): { preview: string; truncated: boolean; shownLines: number; totalLines: number } {
  const raw = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const totalLines = raw.length;
  let slice = raw;
  let truncated = false;
  if (slice.length > maxLines) {
    slice = slice.slice(0, maxLines);
    truncated = true;
  }
  let preview = slice.join("\n");
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    preview = `${preview}\n${diffTruncatedMarker(slice.length, totalLines)}`;
  }
  return { preview, truncated, shownLines: slice.length, totalLines };
}

export function kindFromSnapshots(before: Snapshot, afterExisted: boolean, afterEmpty: boolean): DiffKind {
  if (!before.existed && afterExisted) return "created";
  if (before.existed && !afterExisted) return "deleted";
  if (before.existed && afterExisted && afterEmpty && (before.text || "") !== "") {
    // write that emptied the file still counts as modified, not deleted
    return "modified";
  }
  return "modified";
}

export function computeUnifiedDiff(input: {
  path: string;
  before: Snapshot;
  after: Snapshot;
}): ComputedDiff {
  const path = toPosixRel(input.path);
  const kind = kindFromSnapshots(
    input.before,
    input.after.existed,
    !input.after.binary && (input.after.text || "") === "",
  );

  if (input.before.binary || input.after.binary) {
    const byteSize = Math.max(input.before.byteSize, input.after.byteSize);
    const header = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      DIFF_BINARY_MARKER,
    ].join("\n");
    return {
      path,
      kind,
      additions: 0,
      deletions: 0,
      preview: header,
      body: header,
      truncated: false,
      binary: true,
      byteSize,
      omitted: false,
    };
  }

  if (kind === "deleted" && (input.before.tooBig || input.before.byteSize > DIFF_SNAPSHOT_MAX_BYTES)) {
    const oldLines = splitLines(input.before.text || "");
    const shown = oldLines.slice(0, DIFF_DELETED_PREVIEW_LINES);
    const header = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ /dev/null`,
      `@@ -1,${oldLines.length} +0,0 @@`,
      ...shown.map((l) => `-${l}`),
      diffBodyOmitted(input.before.byteSize),
    ].join("\n");
    return {
      path,
      kind: "deleted",
      additions: 0,
      deletions: oldLines.length || 1,
      preview: header,
      body: null,
      truncated: true,
      binary: false,
      byteSize: input.before.byteSize,
      omitted: true,
    };
  }

  const oldText = kind === "created" ? "" : input.before.text || "";
  const newText = kind === "deleted" ? "" : input.after.text || "";
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);
  const hunk = hunkify(ops, path);
  const cap = truncateUnified(hunk.text);
  const tooBig =
    input.before.tooBig ||
    input.after.tooBig ||
    input.before.byteSize > DIFF_SNAPSHOT_MAX_BYTES ||
    input.after.byteSize > DIFF_SNAPSHOT_MAX_BYTES;
  return {
    path,
    kind,
    additions: hunk.additions,
    deletions: hunk.deletions,
    preview: cap.preview,
    body: tooBig ? null : hunk.text,
    truncated: cap.truncated || tooBig,
    binary: false,
    byteSize: Math.max(input.before.byteSize, input.after.byteSize),
    omitted: tooBig,
  };
}

export function emptySnapshot(): Snapshot {
  return { existed: false, text: "", binary: false, tooBig: false, byteSize: 0 };
}

export function textSnapshot(text: string): Snapshot {
  const byteSize = Buffer.byteLength(text, "utf8");
  const tooBig = byteSize > DIFF_SNAPSHOT_MAX_BYTES;
  return {
    existed: true,
    text: tooBig ? text.slice(0, DIFF_SNAPSHOT_MAX_BYTES) : text,
    binary: false,
    tooBig,
    byteSize,
  };
}
