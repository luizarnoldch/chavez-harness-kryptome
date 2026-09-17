import { describe, expect, test } from "bun:test";
import { loadOfficialCatalog, lookupOfficial } from "./marketplace-catalog";

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

  test("lookupOfficial nope returns exact error", () => {
    const r = lookupOfficial("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Marketplace entry not found: nope");
    }
  });
});
