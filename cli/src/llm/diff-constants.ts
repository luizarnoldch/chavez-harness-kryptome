export const DIFF_KINDS = ["created", "modified", "deleted"] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];

export const DIFF_STATUSES = ["proposed", "applied", "rejected"] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

export const DIFF_PREVIEW_MAX_LINES = 200;
export const DIFF_PREVIEW_MAX_CHARS = 8000;
export const DIFF_SNAPSHOT_MAX_BYTES = 1_048_576;
export const DIFF_DELETED_PREVIEW_LINES = 40;
export const DIFF_DP_CELL_CAP = 2_000_000;

export const DIFF_BINARY_MARKER = "[binary file]";
export const NO_GIT_FOR_BASH =
  "Bash mutations are not in the turn diff set (workspace is not a git repo)";

export function diffTruncatedMarker(shown: number, total: number): string {
  return `[truncated: showing ${shown} of ${total} lines]`;
}

export function diffBodyOmitted(bytes: number): string {
  return `[omitted: file was ${bytes} bytes; full blob not stored]`;
}

export function isDiffKind(v: unknown): v is DiffKind {
  return v === "created" || v === "modified" || v === "deleted";
}

export function isDiffStatus(v: unknown): v is DiffStatus {
  return v === "proposed" || v === "applied" || v === "rejected";
}

export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
