import { MARKETPLACE_FILE } from "./marketplace-constants";

export type MarketplaceWatchPush = {
  type: string;
  data?: unknown;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function formatMarketplaceWatchLine(
  msg: MarketplaceWatchPush,
): string | null {
  const data = rec(msg.data) ?? {};
  if (msg.type === "marketplace.install.ask") {
    const name = String(data.name || "");
    return `marketplace · ask · write ${MARKETPLACE_FILE} · ${name}`;
  }
  if (msg.type === "marketplace.changed") {
    const op = String(data.op || data.action || "changed");
    const name = String(
      data.name ||
        rec(data.view)?.name ||
        extractNameFromMessage(String(data.message || rec(data.view)?.message || "")),
    );
    return name ? `marketplace · ${op} · ${name}` : `marketplace · ${op}`;
  }
  return null;
}

function extractNameFromMessage(message: string): string {
  const m = message.match(/^(?:Installed|Uninstalled)\s+\w+\s+(\S+)/);
  return m?.[1] ?? "";
}
