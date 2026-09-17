import {
  INVALID_PROVIDER_MODEL,
  INVALID_PROVIDER_PARAM,
  clampCursorParams,
  findClaudeModel,
  findCursorModel,
} from "./catalog-codec";
import type { ClaudeCatalog, EffortLevel } from "./claude-types";
import type { CursorCatalog, CursorParamSelection } from "./cursor-types";

export type PrefsPatch = {
  activeProvider?: string | null;
  activeModel?: string | null;
  activeEffort?: string | null;
  activeParams?: CursorParamSelection[] | null;
};

export type ValidatedPrefs = {
  activeProvider: "claude" | "cursor" | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams: CursorParamSelection[] | null;
};

const EFFORTS = new Set<EffortLevel>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function validatePreferences(
  patch: PrefsPatch,
  current: ValidatedPrefs,
  catalogs: { claude: ClaudeCatalog; cursor: CursorCatalog },
): ValidatedPrefs {
  const provider = (patch.activeProvider !== undefined
    ? patch.activeProvider
    : current.activeProvider) as ValidatedPrefs["activeProvider"];

  if (provider !== null && provider !== "claude" && provider !== "cursor") {
    throw new Error("provider must be claude or cursor");
  }

  let model =
    patch.activeModel !== undefined ? patch.activeModel : current.activeModel;
  let effort =
    patch.activeEffort !== undefined ? patch.activeEffort : current.activeEffort;
  let params =
    patch.activeParams !== undefined ? patch.activeParams : current.activeParams;

  if (provider === "claude") {
    if (model) {
      const m = findClaudeModel(catalogs.claude, model);
      if (!m) throw new Error(INVALID_PROVIDER_MODEL(model, "claude"));
      if (effort && !m.effortLevels.includes(effort as EffortLevel)) {
        effort = m.effortLevels.includes("medium")
          ? "medium"
          : (m.effortLevels[0] ?? "none");
      }
    }
    params = null;
  }

  if (provider === "cursor") {
    if (model) {
      const m = findCursorModel(catalogs.cursor, model);
      if (!m) throw new Error(INVALID_PROVIDER_MODEL(model, "cursor"));
      const clamped = clampCursorParams(m, params ?? []);
      for (const p of params ?? []) {
        if (
          !m.parameters?.some(
            (d) => d.id === p.id && d.values.some((v) => v.value === p.value),
          )
        ) {
          throw new Error(INVALID_PROVIDER_PARAM(p.id, p.value, model));
        }
      }
      params = clamped;
    }
    if (effort && !EFFORTS.has(effort as EffortLevel)) {
      effort = null;
    }
  }

  return {
    activeProvider: provider,
    activeModel: model,
    activeEffort: effort,
    activeParams: params,
  };
}

export function defaultsForProvider(
  provider: "claude" | "cursor",
  catalogs: { claude: ClaudeCatalog; cursor: CursorCatalog },
): Pick<ValidatedPrefs, "activeModel" | "activeEffort" | "activeParams"> {
  if (provider === "claude") {
    const m = catalogs.claude.models[0];
    return {
      activeModel: m?.id ?? null,
      activeEffort: m?.effortLevels.includes("medium")
        ? "medium"
        : (m?.effortLevels[0] ?? "none"),
      activeParams: null,
    };
  }
  const m = catalogs.cursor.models[0];
  return {
    activeModel: m?.id ?? null,
    activeEffort: null,
    activeParams: m ? clampCursorParams(m, []) : null,
  };
}
