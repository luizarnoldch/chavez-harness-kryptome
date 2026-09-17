import type { ClaudeCatalog, ClaudeModelInfo, EffortLevel } from "./claude-types";
import type { CursorCatalog, CursorModelInfo, CursorParamSelection } from "./cursor-types";
import { OPTIMIZE_FOR_ID, ROUTER_MODEL_ID } from "./cursor-types";

export const INVALID_PROVIDER_MODEL = (model: string, provider: string) =>
  `modelId "${model}" does not belong to provider ${provider}`;

export const INVALID_PROVIDER_PARAM = (
  id: string,
  value: string,
  model: string,
) => `param "${id}=${value}" is not valid for model ${model}`;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function parseContextWindow(m: Record<string, unknown>): number {
  const raw =
    m.contextWindowTokens ??
    m.contextWindow ??
    m.context_window ??
    m.max_input_tokens;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 200_000;
}

export function parseClaudeModels(raw: unknown): ClaudeModelInfo[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(root?.models);
  const out: ClaudeModelInfo[] = [];
  for (const item of list) {
    const m = asRecord(item);
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const effortLevels = asArray(m.effortLevels).filter(
      (e): e is EffortLevel =>
        e === "none" ||
        e === "low" ||
        e === "medium" ||
        e === "high" ||
        e === "xhigh" ||
        e === "max",
    );
    out.push({
      id: m.id,
      label: typeof m.label === "string" ? m.label : m.id,
      inputPricePerMTok: Number(m.inputPricePerMTok) || 0,
      outputPricePerMTok: Number(m.outputPricePerMTok) || 0,
      effortLevels,
      contextWindowTokens: parseContextWindow(m),
    });
  }
  return out;
}

export function parseCursorModels(raw: unknown): CursorModelInfo[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(root?.models);
  const out: CursorModelInfo[] = [];
  for (const item of list) {
    const m = asRecord(item);
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const parameters = asArray(m.parameters).flatMap((p) => {
      const pr = asRecord(p);
      if (!pr || typeof pr.id !== "string") return [];
      return [
        {
          id: pr.id,
          displayName:
            typeof pr.displayName === "string" ? pr.displayName : undefined,
          values: asArray(pr.values).flatMap((v) => {
            const vr = asRecord(v);
            if (!vr || typeof vr.value !== "string") return [];
            return [
              {
                value: vr.value,
                displayName:
                  typeof vr.displayName === "string"
                    ? vr.displayName
                    : undefined,
              },
            ];
          }),
        },
      ];
    });
    const variants = asArray(m.variants).flatMap((v) => {
      const vr = asRecord(v);
      if (!vr || typeof vr.displayName !== "string") return [];
      const params: CursorParamSelection[] = asArray(vr.params).flatMap((p) => {
        const pr = asRecord(p);
        if (!pr || typeof pr.id !== "string" || typeof pr.value !== "string") {
          return [];
        }
        return [{ id: pr.id, value: pr.value }];
      });
      return [
        {
          params,
          displayName: vr.displayName,
          description:
            typeof vr.description === "string" ? vr.description : undefined,
          isDefault: vr.isDefault === true,
        },
      ];
    });
    out.push({
      id: m.id,
      displayName:
        typeof m.displayName === "string"
          ? m.displayName
          : typeof m.label === "string"
            ? m.label
            : m.id,
      description: typeof m.description === "string" ? m.description : undefined,
      aliases: asArray(m.aliases).filter((a): a is string => typeof a === "string"),
      parameters: parameters.length ? parameters : undefined,
      variants: variants.length ? variants : undefined,
      contextWindowTokens: parseContextWindow(m),
    });
  }
  return out;
}

export function wrapClaudeRaw(models: ClaudeModelInfo[]): unknown {
  return { provider: "claude", models };
}

export function wrapCursorRaw(models: unknown): unknown {
  return { provider: "cursor", models };
}

export function findClaudeModel(
  catalog: ClaudeCatalog,
  modelId: string,
): ClaudeModelInfo | undefined {
  return catalog.models.find((m) => m.id === modelId);
}

export function findCursorModel(
  catalog: CursorCatalog,
  modelId: string,
): CursorModelInfo | undefined {
  return catalog.models.find(
    (m) => m.id === modelId || m.aliases?.includes(modelId),
  );
}

export function hasCursorRouter(catalog: CursorCatalog): boolean {
  const m = findCursorModel(catalog, ROUTER_MODEL_ID);
  return Boolean(
    m?.parameters?.some(
      (p) => p.id === OPTIMIZE_FOR_ID && p.values.length > 0,
    ),
  );
}

export function defaultCursorParams(
  model: CursorModelInfo,
): CursorParamSelection[] {
  const defVariant = model.variants?.find((v) => v.isDefault);
  if (defVariant?.params?.length) return defVariant.params.map((p) => ({ ...p }));
  const params: CursorParamSelection[] = [];
  for (const p of model.parameters ?? []) {
    if (p.id === OPTIMIZE_FOR_ID) {
      const balanced = p.values.find((v) => v.value === "balanced");
      params.push({
        id: p.id,
        value: balanced?.value ?? p.values[0]!.value,
      });
      continue;
    }
    if (p.values[0]) params.push({ id: p.id, value: p.values[0].value });
  }
  return params;
}

export function paramAllowed(
  model: CursorModelInfo,
  sel: CursorParamSelection,
): boolean {
  const def = model.parameters?.find((p) => p.id === sel.id);
  if (!def) return false;
  return def.values.some((v) => v.value === sel.value);
}

export function clampCursorParams(
  model: CursorModelInfo,
  params: CursorParamSelection[] | null | undefined,
): CursorParamSelection[] {
  const next = (params ?? []).filter((p) => paramAllowed(model, p));
  const have = new Set(next.map((p) => p.id));
  for (const d of defaultCursorParams(model)) {
    if (!have.has(d.id)) next.push(d);
  }
  return next;
}
