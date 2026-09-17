import type { ChavezWsClient } from "../ws/client";
import { restoreTurn } from "./git-restore";
import { parseCheckpoint } from "./turn-select";
import {
  UNDO_NO_CHECKPOINT,
  UNDO_REQUIRES_GIT,
  type Checkpoint,
} from "./undo-constants";

export async function handleUndoDispatch(input: {
  client: ChavezWsClient;
  cwd: string;
  data: {
    requestId?: string;
    chatId?: string;
    streamId?: string;
    checkpoint?: unknown;
    path?: string;
  };
}): Promise<void> {
  const requestId = String(input.data.requestId || "");
  const chatId = String(input.data.chatId || "");
  const cwd = input.data.path || input.cwd;
  if (!requestId || !chatId) return;
  const checkpoint = parseCheckpoint(input.data.checkpoint);
  if (!checkpoint) {
    await input.client.request({
      type: "agent.turn.undo.result",
      requestId,
      chatId,
      streamId: String(input.data.streamId || ""),
      status: "error",
      metadata: { error: UNDO_NO_CHECKPOINT, chatId },
    });
    return;
  }
  if (checkpoint.kind !== "git" || !checkpoint.commitSha) {
    await input.client.request({
      type: "agent.turn.undo.result",
      requestId,
      chatId,
      streamId: checkpoint.streamId,
      status: "error",
      metadata: { error: UNDO_REQUIRES_GIT, chatId },
    });
    return;
  }
  const out = await restoreTurn({ cwd, chatId, checkpoint: checkpoint as Checkpoint });
  await input.client.request({
    type: "agent.turn.undo.result",
    requestId,
    chatId,
    streamId: out.streamId,
    status: out.noop && out.message === UNDO_REQUIRES_GIT ? "error" : "done",
    metadata: {
      ...out,
      error:
        out.noop && out.message === UNDO_REQUIRES_GIT
          ? UNDO_REQUIRES_GIT
          : undefined,
    },
  });
}
