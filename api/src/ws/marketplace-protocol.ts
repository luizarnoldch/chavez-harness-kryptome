import {
  MARKETPLACE_KIND_LAYER,
  marketplaceHostProtected,
} from "../llm/marketplace-constants";
import type { ClientMessage } from "./protocol";

export function meta(msg: ClientMessage): Record<string, unknown> {
  return msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
}

/** HTTP install/uninstall: skills only. MCP must use WebSocket. */
export function installKindLayerError(kind: string): string | null {
  if (kind === "mcp") return MARKETPLACE_KIND_LAYER;
  if (kind === "skill") return null;
  if (!kind) return MARKETPLACE_KIND_LAYER;
  return MARKETPLACE_KIND_LAYER;
}

/** WS install/uninstall: MCP only. Skills must use HTTP POST. */
export function wsInstallKindLayerError(kind: string): string | null {
  if (kind === "skill") return "use POST /marketplace/install for skills";
  if (kind === "mcp") return null;
  if (!kind) return MARKETPLACE_KIND_LAYER;
  return MARKETPLACE_KIND_LAYER;
}

export function wsUninstallKindLayerError(kind: string): string | null {
  if (kind === "skill") return "use POST /marketplace/uninstall for skills";
  if (kind === "mcp") return null;
  if (!kind) return MARKETPLACE_KIND_LAYER;
  return MARKETPLACE_KIND_LAYER;
}

export function hostProtected(name: string): string | null {
  if (name === "chavez-git" || name === "chavez-skills") {
    return marketplaceHostProtected(name);
  }
  return null;
}

/** Disk-changing install/uninstall did not happen (CAS ask still pending). */
export function isMarketplaceApplied(data: Record<string, unknown>): boolean {
  return data.status !== "awaiting_approval" && !data.error;
}
