import { describe, expect, test } from "bun:test";
import {
  MARKETPLACE_KIND_LAYER,
  validateMarketplaceInstallBody,
} from "../llm/marketplace-constants";
import { loadOfficialCatalog } from "../llm/marketplace-catalog";

describe("marketplace routes validation", () => {
  test("{ kind: skill, id: commit } → ok", () => {
    const r = validateMarketplaceInstallBody({ kind: "skill", id: "commit" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("skill");
      expect(r.id).toBe("commit");
    }
  });

  test("{ kind: mcp, id: github } → MARKETPLACE_KIND_LAYER", () => {
    const r = validateMarketplaceInstallBody({ kind: "mcp", id: "github" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(MARKETPLACE_KIND_LAYER);
  });

  test("loadOfficialCatalog has 4 entries", () => {
    expect(loadOfficialCatalog().entries.length).toBe(4);
  });
});
