import type { ChavezWsClient } from "../ws/client";

export type TurnBookendOpts = {
  chatId: string;
  streamId: string;
  queueId?: string;
  phase: "start" | "end";
  status?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Emit agent.turn.started / agent.turn.ended for queue drain + busy tracking.
 * Failures (API not ready, socket down) must not abort the turn.
 */
export async function emitTurnBookends(
  client: ChavezWsClient,
  opts: TurnBookendOpts,
): Promise<void> {
  try {
    if (opts.phase === "start") {
      await client.request({
        type: "agent.turn.started",
        chatId: opts.chatId,
        streamId: opts.streamId,
        ...(opts.queueId ? { queueId: opts.queueId } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      });
    } else {
      await client.request({
        type: "agent.turn.ended",
        chatId: opts.chatId,
        streamId: opts.streamId,
        status: opts.status ?? "finished",
        ...(opts.queueId ? { queueId: opts.queueId } : {}),
      });
    }
  } catch {
    // connection already dead / unknown type — turn continues
  }
}
