import {
  MARKETPLACE_PICKER_LIMIT,
  type MarketplaceEntry,
  type MarketplaceView,
  type MarketplaceViewRow,
} from "./marketplace-constants";
import { loadOfficialCatalog } from "./marketplace-catalog";

export type InstalledMcp = {
  name: string;
  layer: "project" | "local" | "host";
  path: string;
};

export type InstalledSkill = {
  name: string;
  layer: "user" | "project" | "local";
  catalogId?: string | null;
};

export type {
  MarketplaceEntry,
  MarketplaceMcpRecipe,
  MarketplaceView,
  MarketplaceViewRow,
} from "./marketplace-constants";

const HOST = new Set(["chavez-git", "chavez-skills"]);

export function mergeMarketplaceView(input: {
  catalog?: MarketplaceEntry[];
  catalogErrors?: string[];
  installedMcp?: InstalledMcp[];
  installedSkills?: InstalledSkill[];
}): MarketplaceView {
  const loaded = input.catalog ? { entries: input.catalog, errors: input.catalogErrors ?? [] } : loadOfficialCatalog();
  const mcp = (input.installedMcp ?? []).filter((s) => !HOST.has(s.name));
  const skills = input.installedSkills ?? [];
  const rows: MarketplaceViewRow[] = [];
  const seenMcp = new Set<string>();
  const seenSkill = new Set<string>();

  for (const e of loaded.entries) {
    if (e.kind === "mcp") {
      const hit = mcp.find((s) => s.name === e.name);
      rows.push({
        id: e.id,
        kind: "mcp",
        name: e.name,
        title: e.title,
        description: e.description,
        origin: "oficial",
        installed: Boolean(hit),
        layer: hit?.layer,
        path: hit?.path,
        requiredEnv: e.recipe?.requiredEnv ?? [],
        catalogId: e.id,
      });
      if (hit) seenMcp.add(hit.name);
    } else {
      const hit = skills.find((s) => s.name === e.name);
      rows.push({
        id: e.id,
        kind: "skill",
        name: e.name,
        title: e.title,
        description: e.description,
        origin: "oficial",
        installed: Boolean(hit),
        layer: hit?.layer ?? (hit ? "user" : undefined),
        requiredEnv: [],
        catalogId: e.id,
      });
      if (hit) seenSkill.add(hit.name);
    }
  }

  for (const s of mcp) {
    if (seenMcp.has(s.name)) continue;
    rows.push({
      id: `project:${s.name}`,
      kind: "mcp",
      name: s.name,
      title: s.name,
      description: "",
      origin: "proyecto",
      installed: true,
      layer: s.layer,
      path: s.path,
      requiredEnv: [],
    });
  }

  for (const s of skills) {
    if (seenSkill.has(s.name)) continue;
    rows.push({
      id: `${s.layer}:${s.name}`,
      kind: "skill",
      name: s.name,
      title: s.name,
      description: "",
      origin: s.layer === "user" ? "usuario" : "proyecto",
      installed: true,
      layer: s.layer,
      requiredEnv: [],
      catalogId: s.catalogId ?? undefined,
    });
  }

  return { entries: rows, errors: loaded.errors, nativeToolsContinue: true };
}

export function filterMarketplaceRows(
  rows: MarketplaceViewRow[],
  query: string,
  limit = MARKETPLACE_PICKER_LIMIT,
): MarketplaceViewRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) =>
        `${r.kind} ${r.name} ${r.title} ${r.origin}`.toLowerCase().includes(q),
      )
    : rows;
  return filtered.slice(0, limit);
}

export function formatMarketplaceList(view: MarketplaceView): string {
  if (!view.entries.length && !view.errors.length) return "0 marketplace entries";
  const lines = ["kind  origin     installed  name"];
  for (const r of view.entries) {
    const inst = r.installed ? "yes" : "no ";
    const origin = r.origin.padEnd(9, " ");
    lines.push(`${r.kind.padEnd(4, " ")}  ${origin}  ${inst}        ${r.name}`);
  }
  for (const e of view.errors) lines.push(`error  ${e}`);
  return lines.join("\n");
}
