import { eq } from "drizzle-orm";
import { db } from "../db";
import { turnFileDiffs } from "../db/schema";
import {
  assembleTurnReplay,
  formatTurnReplay,
  redactReplayJson,
  redactReplayText,
  type ReplayDiffRow,
  type ReplayResult,
  type TurnReplay,
  REPLAY_NO_TURN,
} from "./turn-replay";

type Msg = {
  id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export async function loadReplayDiffs(
  chatId: string,
  streamId: string | null,
): Promise<ReplayDiffRow[]> {
  try {
    const rows = await db
      .select({
        streamId: turnFileDiffs.streamId,
        path: turnFileDiffs.path,
        kind: turnFileDiffs.kind,
        status: turnFileDiffs.status,
        additions: turnFileDiffs.additions,
        deletions: turnFileDiffs.deletions,
        preview: turnFileDiffs.preview,
        truncated: turnFileDiffs.truncated,
        // body intentionally omitted
      })
      .from(turnFileDiffs)
      .where(eq(turnFileDiffs.chatId, chatId));
    return rows
      .filter((r) => !streamId || r.streamId === streamId)
      .map((r) => ({
        streamId: r.streamId,
        path: r.path,
        kind: r.kind,
        status: r.status,
        additions: r.additions,
        deletions: r.deletions,
        preview: r.preview,
        truncated: Boolean(r.truncated),
      }));
  } catch {
    return [];
  }
}

function belt(replay: TurnReplay): TurnReplay {
  return redactReplayJson(replay) as TurnReplay;
}

export async function buildChatReplay(input: {
  chatId: string;
  messages: Msg[];
  streamId?: string | null;
  diffs?: ReplayDiffRow[];
}): Promise<ReplayResult> {
  const diffs =
    input.diffs ?? (await loadReplayDiffs(input.chatId, input.streamId ?? null));
  const assembled = assembleTurnReplay({
    chatId: input.chatId,
    messages: input.messages,
    diffs,
    streamId: input.streamId,
  });
  if (!assembled.ok) return assembled;
  const replay = belt(assembled.replay);
  replay.prompt = redactReplayText(replay.prompt);
  replay.assistant = redactReplayText(replay.assistant);
  if (replay.error) replay.error = redactReplayText(replay.error);
  return { ok: true, replay, text: formatTurnReplay(replay) };
}

export { REPLAY_NO_TURN };
