export const MARKETPLACE_ORIGINS = ["oficial", "proyecto", "usuario"] as const;
export type MarketplaceOrigin = (typeof MARKETPLACE_ORIGINS)[number];

export const MARKETPLACE_KINDS = ["mcp", "skill"] as const;
export type MarketplaceKind = (typeof MARKETPLACE_KINDS)[number];

export const MARKETPLACE_PICKER_LIMIT = 10;
export const MARKETPLACE_FILE = ".mcp.json";
export const MARKETPLACE_RPC_TIMEOUT_MS = 5_000;

export { NO_DAEMON_ERROR } from "./undo-constants";

export const MARKETPLACE_PLAN_DENIED =
  "Plan mode: installing or uninstalling project MCP writes the repo. Switch to ask or auto.";

export const MARKETPLACE_CATALOG_ERROR = "Official catalog failed to load";
export const MARKETPLACE_KIND_LAYER =
  "Skills install to the user account; MCP installs to the project .mcp.json";
export const MARKETPLACE_ASK_WAITING =
  "ask: writing .mcp.json needs approval from Web, TUI, or this CLI — not auto-approved";
export const MARKETPLACE_ASK_PROMPT = `Write ${MARKETPLACE_FILE}? (y/n)`;
export const MARKETPLACE_DENIED = "User denied marketplace write";
export const MARKETPLACE_EMPTY = "0 marketplace entries";
export const MARKETPLACE_LIST_HEADER = "kind  origin     installed  name";
export const MARKETPLACE_RECIPE_MISMATCH =
  "Marketplace recipe does not match the official catalog — refusing to write";
export const MARKETPLACE_MCP_JSON_CHANGED =
  ".mcp.json changed since approval was requested — retry install";

export function marketplaceMcpJsonIllegible(reason?: string): string {
  const base =
    "Project .mcp.json is illegible — fix invalid JSON before marketplace writes";
  return reason ? `${base} (${reason})` : base;
}

export const MARKETPLACE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type MarketplaceMcpRecipe = {
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  requiredEnv?: string[];
};

export type MarketplaceEntry = {
  id: string;
  kind: MarketplaceKind;
  name: string;
  title: string;
  description: string;
  origin: MarketplaceOrigin;
  recipe?: MarketplaceMcpRecipe;
  body?: string;
};

export type MarketplaceViewRow = {
  id: string;
  kind: MarketplaceKind;
  name: string;
  title: string;
  description: string;
  origin: MarketplaceOrigin;
  installed: boolean;
  layer?: "project" | "local" | "host" | "user";
  path?: string;
  requiredEnv: string[];
  catalogId?: string;
};

export type MarketplaceView = {
  entries: MarketplaceViewRow[];
  errors: string[];
  nativeToolsContinue: boolean;
};

export function marketplaceNotFound(id: string): string {
  return `Marketplace entry not found: ${id}`;
}

export function marketplaceEntryInvalid(id: string, reason: string): string {
  return `Marketplace entry "${id}" is invalid: ${reason}`;
}

export function marketplaceAlreadyInstalled(name: string): string {
  return `Already installed: ${name}`;
}

export function marketplaceNotInstalled(name: string): string {
  return `Not installed: ${name}`;
}

export function marketplaceHostProtected(name: string): string {
  return `Cannot install or uninstall host MCP server "${name}"`;
}

export function marketplaceInstalled(kind: MarketplaceKind, name: string): string {
  return `Installed ${kind} ${name}`;
}

export function marketplaceUninstalled(kind: MarketplaceKind, name: string): string {
  return `Uninstalled ${kind} ${name}`;
}

export function isMarketplaceId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 64 && MARKETPLACE_ID_RE.test(v);
}
