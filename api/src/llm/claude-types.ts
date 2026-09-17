export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeModelInfo = {
  id: string;
  label: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  effortLevels: EffortLevel[];
};

export type ClaudeCatalog = {
  id: "claude";
  label: string;
  models: ClaudeModelInfo[];
};

export const EFFORT_FULL: EffortLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
