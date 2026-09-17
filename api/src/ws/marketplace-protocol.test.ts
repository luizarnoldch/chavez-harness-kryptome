import { describe, expect, test } from "bun:test";
import { lookupOfficial } from "../llm/marketplace-catalog";
import {
  MARKETPLACE_KIND_LAYER,
  validateMarketplaceInstallBody,
} from "../llm/marketplace-constants";
import {
  hostProtected,
  installKindLayerError,
  isMarketplaceApplied,
  wsInstallKindLayerError,
} from "./marketplace-protocol";

describe("marketplace-protocol helpers", () => {
  test("HTTP install rejects mcp with MARKETPLACE_KIND_LAYER", () => {
    expect(installKindLayerError("mcp")).toBe(MARKETPLACE_KIND_LAYER);
    const r = validateMarketplaceInstallBody({ kind: "mcp", id: "github" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(MARKETPLACE_KIND_LAYER);
  });

  test("WS install rejects skill with HTTP delegate message", () => {
    expect(wsInstallKindLayerError("skill")).toBe(
      "use POST /marketplace/install for skills",
    );
  });

  test("hostProtected chavez-skills returns host error", () => {
    expect(hostProtected("chavez-skills")).toBe(
      'Cannot install or uninstall host MCP server "chavez-skills"',
    );
  });

  test("lookupOfficial nope returns not found", () => {
    const r = lookupOfficial("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Marketplace entry not found: nope");
    }
  });

  test("awaiting_approval is not applied", () => {
    expect(isMarketplaceApplied({ status: "awaiting_approval" })).toBe(false);
    expect(isMarketplaceApplied({ entries: [] })).toBe(true);
    expect(isMarketplaceApplied({ error: "denied" })).toBe(false);
  });
});
