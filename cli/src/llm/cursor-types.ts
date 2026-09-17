export type CursorParamValue = {
  value: string;
  displayName?: string;
};

export type CursorParameterDefinition = {
  id: string;
  displayName?: string;
  values: CursorParamValue[];
};

export type CursorParamSelection = {
  id: string;
  value: string;
};

export type CursorVariant = {
  params: CursorParamSelection[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};

export type CursorModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorParameterDefinition[];
  variants?: CursorVariant[];
};

export type CursorCatalog = {
  id: "cursor";
  label: string;
  models: CursorModelInfo[];
};

export const ROUTER_MODEL_ID = "auto-smart";
export const OPTIMIZE_FOR_ID = "optimize_for";
