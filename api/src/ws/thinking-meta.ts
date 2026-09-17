export function mergeAssistantMetadata(input: {
  streamId: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const status = input.status === "cancelled" ? "cancelled" : "finished";
  return {
    streamId: input.streamId,
    status,
    ...(input.metadata || {}),
  };
}

export function shouldPersistCancelledAssistant(input: {
  content?: string;
  metadata?: Record<string, unknown> | null;
  status?: string;
}): boolean {
  if (input.status === "cancelled") return true;
  if ((input.content || "").trim()) return true;
  const thinking = input.metadata?.thinking as
    | { text?: string; omitted?: boolean }
    | undefined;
  return Boolean(thinking && (thinking.omitted || (thinking.text || "").trim()));
}
