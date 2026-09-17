// keep-in-sync with cli/src/llm/marketplace-view.ts

export const MARKETPLACE_PICKER_LIMIT = 10;

export type MarketplaceViewRow = {
  id: string;
  kind: string;
  name: string;
  title: string;
  description: string;
  origin: string;
  installed: boolean;
  layer?: string;
  path?: string;
  requiredEnv: string[];
  catalogId?: string;
};

export type MarketplaceView = {
  entries: MarketplaceViewRow[];
  errors: string[];
  nativeToolsContinue: boolean;
};

export function formatMarketplaceRow(row: {
  kind: string;
  origin: string;
  installed: boolean;
  name: string;
}): string {
  return `${row.kind} · ${row.origin} · ${row.installed ? "instalado" : "disponible"} · ${row.name}`;
}

export function originLabel(origin: string): string {
  if (origin === "oficial") return "oficial";
  if (origin === "proyecto") return "proyecto";
  if (origin === "usuario") return "usuario";
  return origin;
}

export function originBadgeClass(origin: string): string {
  if (origin === "oficial") return "ok";
  if (origin === "proyecto") return "";
  return "muted";
}

export function filterMarketplaceRows(
  rows: MarketplaceViewRow[],
  query: string,
  limit?: number,
): MarketplaceViewRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) =>
        `${r.kind} ${r.name} ${r.title} ${r.origin}`.toLowerCase().includes(q),
      )
    : rows;
  if (limit == null) return filtered;
  return filtered.slice(0, limit);
}
