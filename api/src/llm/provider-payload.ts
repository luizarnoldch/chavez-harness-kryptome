import { PROVIDER_LABELS } from "./catalog";
import { parseClaudeModels, parseCursorModels } from "./catalog-codec";

export function publicProviderPayload(input: {
  kind: "claude" | "cursor";
  linked: boolean;
  raw: unknown;
  lastError: string | null;
  authKind?: string;
  updatedAt?: Date;
}) {
  const models =
    input.kind === "claude"
      ? parseClaudeModels(input.raw)
      : parseCursorModels(input.raw);
  return {
    linked: input.linked,
    authKind: input.authKind,
    updatedAt: input.updatedAt,
    label: PROVIDER_LABELS[input.kind],
    runnable: input.linked && models.length > 0,
    models,
    raw: input.raw,
    catalogError: input.lastError,
  };
}
