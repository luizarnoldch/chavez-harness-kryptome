import {
  EFFORT_FULL,
  type ClaudeModelInfo,
  type EffortLevel,
} from "./claude-types";

export type { EffortLevel } from "./claude-types";
export { EFFORT_FULL } from "./claude-types";
export type { ClaudeModelInfo } from "./claude-types";
export type ModelInfo = ClaudeModelInfo;

/** Approx USD per 1M tokens (public list prices; update as needed). */
export const CLAUDE_MODELS: ClaudeModelInfo[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    inputPricePerMTok: 15,
    outputPricePerMTok: 75,
    effortLevels: EFFORT_FULL,
    contextWindowTokens: 200_000,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    effortLevels: EFFORT_FULL,
    contextWindowTokens: 200_000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    inputPricePerMTok: 1,
    outputPricePerMTok: 5,
    effortLevels: ["none", "low", "medium", "high"],
    contextWindowTokens: 200_000,
  },
  {
    id: "claude-opus-4-5-20251101",
    label: "Opus 4.5",
    inputPricePerMTok: 15,
    outputPricePerMTok: 75,
    effortLevels: EFFORT_FULL,
    contextWindowTokens: 200_000,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5",
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    effortLevels: EFFORT_FULL,
    contextWindowTokens: 200_000,
  },
];

export const PROVIDER_LABELS: Record<"claude" | "cursor", string> = {
  claude: "Claude (Anthropic)",
  cursor: "Cursor",
};

export function defaultClaudeModelId(): string | null {
  return CLAUDE_MODELS[0]?.id ?? null;
}

export function getCatalog(providerId: string):
  | {
      id: "claude";
      label: string;
      models: ClaudeModelInfo[];
      runnable: boolean;
    }
  | undefined {
  if (providerId !== "claude") return undefined;
  return {
    id: "claude",
    label: PROVIDER_LABELS.claude,
    models: CLAUDE_MODELS,
    runnable: true,
  };
}

export function getModel(
  providerId: string,
  modelId: string,
): ModelInfo | undefined {
  if (providerId !== "claude") return undefined;
  return CLAUDE_MODELS.find((m) => m.id === modelId);
}

export function defaultModelId(providerId: string): string | null {
  if (providerId !== "claude") return null;
  return defaultClaudeModelId();
}

export function defaultEffort(
  providerId: string,
  modelId: string,
): EffortLevel {
  const model = getModel(providerId, modelId);
  if (!model?.effortLevels.length) return "none";
  if (model.effortLevels.includes("medium")) return "medium";
  return model.effortLevels[0];
}

export function modelContextWindow(
  providerId: string,
  modelId: string | null | undefined,
): number {
  const model = modelId ? getModel(providerId, modelId) : undefined;
  return model?.contextWindowTokens ?? 200_000;
}
