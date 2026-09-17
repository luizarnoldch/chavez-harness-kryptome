import type { MarketplaceView } from "../../cli/src/llm/marketplace-constants";
import { NO_DAEMON_ERROR } from "../../cli/src/llm/mcp-constants";

export {
  filterMarketplaceRows,
  mergeMarketplaceView,
} from "../../cli/src/llm/marketplace-view";
export { MARKETPLACE_PICKER_LIMIT } from "../../cli/src/llm/marketplace-constants";

export function formatMarketplaceRow(row: {
  kind: string;
  origin: string;
  installed: boolean;
  name: string;
}): string {
  const inst = row.installed ? "yes" : "no";
  return `${row.kind} · ${row.origin} · ${inst} · ${row.name}`;
}

export function marketplaceOverlayTitle(view: MarketplaceView | null): string {
  if (!view) return "Marketplace";
  return `Marketplace  n=${view.entries.length}`;
}

export function marketplaceProjectNotice(
  view: MarketplaceView | null,
): string | null {
  if (!view?.errors?.some((e) => e === NO_DAEMON_ERROR || e.includes(NO_DAEMON_ERROR))) {
    return null;
  }
  return `proyecto: ${NO_DAEMON_ERROR}`;
}
