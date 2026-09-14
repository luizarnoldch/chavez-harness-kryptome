export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelInfo = {
  id: string;
  label: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  effortLevels: EffortLevel[];
};

export type ProviderCatalog = {
  id: "claude" | "cursor";
  label: string;
  models: ModelInfo[];
  runnable: boolean;
};

const EFFORT_FULL: EffortLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Approx USD per 1M tokens (public list prices; update as needed). */
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    inputPricePerMTok: 15,
    outputPricePerMTok: 75,
    effortLevels: EFFORT_FULL,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    effortLevels: EFFORT_FULL,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    inputPricePerMTok: 1,
    outputPricePerMTok: 5,
    effortLevels: ["none", "low", "medium", "high"],
  },
  {
    id: "claude-opus-4-5-20251101",
    label: "Opus 4.5",
    inputPricePerMTok: 15,
    outputPricePerMTok: 75,
    effortLevels: EFFORT_FULL,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5",
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    effortLevels: EFFORT_FULL,
  },
];

export const CURSOR_MODELS: ModelInfo[] = [
  {
    id: "composer-2.5",
    label: "Composer 2.5 (stub)",
    inputPricePerMTok: 0,
    outputPricePerMTok: 0,
    effortLevels: ["none"],
  },
];

export const PROVIDER_CATALOGS: ProviderCatalog[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    models: CLAUDE_MODELS,
    runnable: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    models: CURSOR_MODELS,
    runnable: false,
  },
];

export function getCatalog(providerId: string): ProviderCatalog | undefined {
  return PROVIDER_CATALOGS.find((p) => p.id === providerId);
}

export function getModel(
  providerId: string,
  modelId: string
): ModelInfo | undefined {
  return getCatalog(providerId)?.models.find((m) => m.id === modelId);
}

export function defaultModelId(providerId: string): string | null {
  return getCatalog(providerId)?.models[0]?.id ?? null;
}

export function defaultEffort(providerId: string, modelId: string): EffortLevel {
  const model = getModel(providerId, modelId);
  if (!model?.effortLevels.length) return "none";
  if (model.effortLevels.includes("medium")) return "medium";
  return model.effortLevels[0];
}
