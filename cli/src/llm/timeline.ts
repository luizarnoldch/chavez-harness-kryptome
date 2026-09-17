export type TimelineMessage = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  chatId?: string;
};

export function mergeTimeline(
  existing: TimelineMessage[],
  incoming: TimelineMessage | TimelineMessage[],
): TimelineMessage[] {
  const map = new Map<string, TimelineMessage>();
  for (const m of existing) map.set(m.id, m);
  const list = Array.isArray(incoming) ? incoming : [incoming];
  for (const m of list) {
    if (!m?.id) continue;
    const prev = map.get(m.id);
    map.set(m.id, prev ? { ...prev, ...m } : m);
  }
  return [...map.values()].sort((a, b) => {
    const ta = new Date(a.createdAt ?? 0).getTime();
    const tb = new Date(b.createdAt ?? 0).getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}

export function applyStreamDelta(
  prev: string,
  delta: string,
  seq: number | undefined,
  state: { nextSeq: number; buffer: Map<number, string> },
): string {
  if (seq == null || !Number.isFinite(seq)) return prev + delta;
  state.buffer.set(seq, delta);
  let out = prev;
  while (state.buffer.has(state.nextSeq)) {
    out += state.buffer.get(state.nextSeq)!;
    state.buffer.delete(state.nextSeq);
    state.nextSeq += 1;
  }
  return out;
}

export function shouldShowLiveAssistant(
  messages: TimelineMessage[],
  streamId: string | null,
  streaming: boolean,
): boolean {
  if (!streaming) return false;
  if (!streamId) return true;
  return !messages.some(
    (m) =>
      m.role === "assistant" &&
      m.metadata &&
      String((m.metadata as { streamId?: unknown }).streamId) === streamId,
  );
}
