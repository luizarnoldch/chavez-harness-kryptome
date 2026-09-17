import {
  isTurnUsageMeta,
  stripUsageSecrets,
  type TurnUsageMeta,
} from "./usage-codec";

export function prepareStreamEndMeta(
  metadata: unknown,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const meta = { ...(metadata as Record<string, unknown>) };
  try {
    if (isTurnUsageMeta(meta)) {
      const stripped = stripUsageSecrets(meta.usage);
      if (stripped) (meta as TurnUsageMeta).usage = stripped;
      else delete meta.usage;
    } else if (meta.usage && typeof meta.usage === "object") {
      const stripped = stripUsageSecrets(meta.usage);
      if (stripped) meta.usage = stripped;
      else delete meta.usage;
    }
  } catch {
    delete meta.usage;
  }
  return meta;
}

export function shouldPersistAssistant(
  content: string,
  meta: Record<string, unknown>,
): boolean {
  return Boolean(content.trim()) || isTurnUsageMeta(meta);
}
