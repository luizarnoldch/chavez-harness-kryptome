import { describe, expect, test } from "bun:test";
import {
  loadOfficialCatalog,
  lookupOfficial,
  recipesEqual,
  validateMarketplaceEntry,
} from "./marketplace-catalog";
import type { MarketplaceEntry } from "./marketplace-constants";

describe("marketplace-catalog", () => {
  test("loadOfficialCatalog has exactly 4 ids", () => {
    const { entries } = loadOfficialCatalog();
    expect(entries.map((e) => e.id).sort()).toEqual([
      "commit",
      "github",
      "pr-review",
      "sequential-thinking",
    ]);
  });

  test("lookupOfficial github ok with npx command", () => {
    const r = lookupOfficial("github");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.recipe?.command).toBe("npx");
    }
  });

  test("lookupOfficial nope returns exact error", () => {
    const r = lookupOfficial("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Marketplace entry not found: nope");
    }
  });

  test("validateMarketplaceEntry mcp without command or url returns reason", () => {
    const bad: MarketplaceEntry = {
      id: "bad-mcp",
      kind: "mcp",
      name: "bad-mcp",
      title: "Bad",
      description: "Bad",
      origin: "oficial",
      recipe: { transport: "stdio" },
    };
    expect(validateMarketplaceEntry(bad)).toBe("stdio recipe missing command");
  });

  test("recipesEqual true for github copies, false when args change", () => {
    const { entries } = loadOfficialCatalog();
    const github = entries.find((e) => e.id === "github")!;
    const copy = structuredClone(github.recipe);
    expect(recipesEqual(github.recipe, copy)).toBe(true);
    const changed = { ...copy!, args: ["-y", "other-package"] };
    expect(recipesEqual(github.recipe, changed)).toBe(false);
  });
});
