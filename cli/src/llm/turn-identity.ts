export type TurnIdentity = {
  streamId: string;
  executionMode?: string | null;
  provider?: string | null;
  modelId?: string | null;
  effort?: string | null;
};

export function turnUserMetadata(
  identity: TurnIdentity,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(extra || {}),
    streamId: identity.streamId,
    ...(identity.executionMode ? { executionMode: identity.executionMode } : {}),
    ...(identity.provider ? { provider: identity.provider } : {}),
    ...(identity.modelId ? { modelId: identity.modelId } : {}),
    ...(identity.effort ? { effort: identity.effort } : {}),
  };
}

export function turnToolMetadata(
  identity: Pick<TurnIdentity, "streamId">,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(extra || {}), streamId: identity.streamId };
}
