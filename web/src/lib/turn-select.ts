import type { Checkpoint } from "./undo-constants";

export type ChatRow = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
};

export type LastTurn = {
  streamId: string;
  user: ChatRow;
  assistant: ChatRow | null;
  checkpoint: Checkpoint | null;
  undone: boolean;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}

export function parseCheckpoint(raw: unknown): Checkpoint | null {
  const o = rec(raw);
  if (!o) return null;
  if (o.kind !== "git" && o.kind !== "none") return null;
  if (typeof o.streamId !== "string" || !o.streamId) return null;
  return {
    kind: o.kind,
    streamId: o.streamId,
    reason:
      o.reason === "not_git" || o.reason === "git_missing" || o.reason === "git_error"
        ? o.reason
        : undefined,
    headSha: typeof o.headSha === "string" ? o.headSha : null,
    commitSha: typeof o.commitSha === "string" ? o.commitSha : null,
    treeSha: typeof o.treeSha === "string" ? o.treeSha : null,
    branch: typeof o.branch === "string" ? o.branch : null,
    paths: asStringArray(o.paths),
    commitsCreated: asStringArray(o.commitsCreated),
    hadBash: Boolean(o.hadBash),
    appliedMutations: Boolean(o.appliedMutations),
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date(0).toISOString(),
    finalizedAt: typeof o.finalizedAt === "string" ? o.finalizedAt : undefined,
  };
}

export function metaOf(row: ChatRow): Record<string, unknown> {
  return rec(row.metadata) ?? {};
}

export function streamIdOf(row: ChatRow): string | null {
  const m = metaOf(row);
  if (typeof m.streamId === "string" && m.streamId) return m.streamId;
  const cp = parseCheckpoint(m.checkpoint);
  return cp?.streamId ?? null;
}

export function isUndone(row: ChatRow): boolean {
  return metaOf(row).undone === true;
}

/**
 * Last agent turn = newest user/assistant row that carries streamId/checkpoint.
 * Tool rows are ignored for grouping. Manual chat.append without streamId is not a turn.
 */
export function selectLastTurn(messages: ChatRow[]): LastTurn | null {
  let streamId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]!;
    if (row.role === "tool") continue;
    const sid = streamIdOf(row);
    if (sid) {
      streamId = sid;
      break;
    }
  }
  if (!streamId) return null;

  const inTurn = messages.filter((m) => streamIdOf(m) === streamId);
  const user =
    [...inTurn].reverse().find((m) => m.role === "user") ??
    [...messages].reverse().find((m) => m.role === "user" && streamIdOf(m) === streamId);
  if (!user) return null;
  const assistant =
    [...inTurn].reverse().find((m) => m.role === "assistant") ?? null;
  const checkpoint =
    parseCheckpoint(metaOf(user).checkpoint) ??
    parseCheckpoint(metaOf(assistant ?? user).checkpoint);
  const undone = isUndone(user) || (assistant ? isUndone(assistant) : false);
  return { streamId, user, assistant, checkpoint, undone };
}

export function canUndoLastTurn(messages: ChatRow[]): {
  enabled: boolean;
  reason: string | null;
  last: LastTurn | null;
} {
  const last = selectLastTurn(messages);
  if (!last) return { enabled: false, reason: null, last: null };
  if (last.undone) return { enabled: false, reason: "UNDO_ALREADY", last };
  if (!last.checkpoint) return { enabled: false, reason: "UNDO_NO_CHECKPOINT", last };
  if (last.checkpoint.kind !== "git" || !last.checkpoint.commitSha) {
    return { enabled: false, reason: "UNDO_REQUIRES_GIT", last };
  }
  if (!last.checkpoint.appliedMutations) {
    return { enabled: false, reason: "UNDO_NOOP", last };
  }
  return { enabled: true, reason: null, last };
}
