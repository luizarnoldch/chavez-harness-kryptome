export type DiffKind = "created" | "modified" | "deleted";
export type DiffStatus = "proposed" | "applied" | "rejected";

export type TurnFileDiff = {
  id: string;
  chatId?: string;
  streamId: string;
  toolCallId?: string | null;
  path: string;
  kind: DiffKind | string;
  status: DiffStatus | string;
  additions: number;
  deletions: number;
  preview: string;
  truncated?: boolean;
  binary?: boolean;
  omitted?: boolean;
  byteSize?: number | null;
  body?: string | null;
};

export function isVisibleDiff(d: { status?: string }): boolean {
  return d.status === "proposed" || d.status === "applied";
}

export function diffsForStream(diffs: TurnFileDiff[], streamId: string | undefined): TurnFileDiff[] {
  if (!streamId) return [];
  return diffs.filter((d) => d.streamId === streamId && isVisibleDiff(d));
}

export function streamIdOf(m: { metadata?: Record<string, unknown> | null }): string | undefined {
  const s = m.metadata?.streamId;
  return typeof s === "string" && s ? s : undefined;
}

export function kindLabel(kind: string): string {
  if (kind === "created") return "created";
  if (kind === "deleted") return "deleted";
  return "modified";
}

export function statLabel(d: TurnFileDiff): string {
  return `+${d.additions} −${d.deletions}`;
}
