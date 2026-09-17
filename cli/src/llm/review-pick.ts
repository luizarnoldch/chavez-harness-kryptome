export type TurnDiffRow = {
  streamId?: string;
  path: string;
  kind?: string;
  status?: string;
  preview?: string;
  additions?: number;
  deletions?: number;
  truncated?: boolean;
};

export type PickedTurnDiffs = {
  streamId: string;
  files: TurnDiffRow[];
};

/** Last streamId that has proposed/applied diffs. Rejected rows are omitted. */
export function pickLastTurnDiffs(diffs: TurnDiffRow[] | null | undefined): PickedTurnDiffs | null {
  if (!diffs || diffs.length === 0) return null;
  const visible = diffs.filter(
    (d) => d.status === "applied" || d.status === "proposed" || d.status == null,
  );
  if (!visible.length) return null;
  let lastId: string | null = null;
  for (let i = visible.length - 1; i >= 0; i--) {
    const id = visible[i]!.streamId;
    if (id) {
      lastId = id;
      break;
    }
  }
  if (!lastId) {
    return { streamId: "unknown", files: visible };
  }
  const files = visible.filter((d) => d.streamId === lastId);
  return files.length ? { streamId: lastId, files } : null;
}

export function turnDiffsToUnified(files: TurnDiffRow[]): { body: string; truncated: boolean } {
  const chunks: string[] = [];
  let truncated = false;
  for (const f of files) {
    const header = `--- a/${f.path}\n+++ b/${f.path}`;
    const preview = (f.preview || "").trim();
    if (f.truncated) truncated = true;
    chunks.push(preview ? `${header}\n${preview}` : header);
  }
  return { body: chunks.join("\n\n"), truncated };
}
