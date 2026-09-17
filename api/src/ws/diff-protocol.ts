export const DIFF_KINDS = ["created", "modified", "deleted"] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];
export const DIFF_STATUSES = ["proposed", "applied", "rejected"] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

export const DIFF_PREVIEW_MAX_LINES = 200;
export const DIFF_PREVIEW_MAX_CHARS = 8000;

export function isDiffKind(v: unknown): v is DiffKind {
  return v === "created" || v === "modified" || v === "deleted";
}
export function isDiffStatus(v: unknown): v is DiffStatus {
  return v === "proposed" || v === "applied" || v === "rejected";
}

export type DiffUpsertInput = {
  path?: unknown;
  kind?: unknown;
  status?: unknown;
  toolCallId?: unknown;
  additions?: unknown;
  deletions?: unknown;
  preview?: unknown;
  body?: unknown;
  truncated?: unknown;
  binary?: unknown;
  omitted?: unknown;
  byteSize?: unknown;
};

export type StoredDiff = {
  id: string;
  chatId: string;
  streamId: string;
  toolCallId: string | null;
  path: string;
  kind: DiffKind;
  status: DiffStatus;
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
  binary: boolean;
  omitted: boolean;
  byteSize: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toPreview(row: {
  id: string;
  chatId: string;
  streamId: string;
  toolCallId: string | null;
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
  binary: boolean;
  omitted: boolean;
  byteSize: number | null;
  createdAt: Date;
  updatedAt: Date;
}): StoredDiff {
  return {
    id: row.id,
    chatId: row.chatId,
    streamId: row.streamId,
    toolCallId: row.toolCallId,
    path: row.path,
    kind: row.kind as DiffKind,
    status: row.status as DiffStatus,
    additions: row.additions,
    deletions: row.deletions,
    preview: row.preview,
    truncated: row.truncated,
    binary: row.binary,
    omitted: row.omitted,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function parseDiffUpsert(raw: DiffUpsertInput): {
  path: string;
  kind: DiffKind;
  status: DiffStatus;
  toolCallId: string | null;
  additions: number;
  deletions: number;
  preview: string;
  body: string | null;
  truncated: boolean;
  binary: boolean;
  omitted: boolean;
  byteSize: number | null;
} | { error: string } {
  const path = typeof raw.path === "string" ? raw.path.replace(/\\/g, "/").replace(/^\.\//, "").trim() : "";
  if (!path || path.startsWith("/") || path.includes("..")) {
    return { error: "diff.path must be a relative posix path inside the workspace" };
  }
  if (!isDiffKind(raw.kind)) return { error: "diff.kind must be created, modified, or deleted" };
  if (!isDiffStatus(raw.status)) return { error: "diff.status must be proposed, applied, or rejected" };
  let preview = typeof raw.preview === "string" ? raw.preview : "";
  const truncatedFlag = Boolean(raw.truncated);
  if (preview.length > DIFF_PREVIEW_MAX_CHARS) {
    preview = preview.slice(0, DIFF_PREVIEW_MAX_CHARS) + `\n[truncated: showing preview of ${preview.length} chars]`;
  }
  const body = typeof raw.body === "string" ? raw.body : null;
  return {
    path,
    kind: raw.kind,
    status: raw.status,
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
    additions: Number.isFinite(Number(raw.additions)) ? Math.max(0, Number(raw.additions)) : 0,
    deletions: Number.isFinite(Number(raw.deletions)) ? Math.max(0, Number(raw.deletions)) : 0,
    preview,
    body: raw.omitted ? null : body,
    truncated: truncatedFlag || preview.length >= DIFF_PREVIEW_MAX_CHARS,
    binary: Boolean(raw.binary),
    omitted: Boolean(raw.omitted) || (raw.kind === "deleted" && body == null && Boolean(raw.truncated)),
    byteSize: Number.isFinite(Number(raw.byteSize)) ? Number(raw.byteSize) : null,
  };
}

export function visibleStatus(status: string): boolean {
  return status === "proposed" || status === "applied";
}
