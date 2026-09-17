import { describe, expect, test } from "bun:test";
import {
  filterMarketplaceRows,
  formatMarketplaceRow,
  marketplaceOverlayTitle,
  mergeMarketplaceView,
} from "./marketplace-overlay";

describe("marketplace-overlay", () => {
  test("formatMarketplaceRow shows oficial origin and no when not installed", () => {
    const line = formatMarketplaceRow({
      kind: "mcp",
      origin: "oficial",
      installed: false,
      name: "github",
    });
    expect(line).toContain("oficial");
    expect(line).toContain("no");
    expect(line).toContain("github");
  });

  test("formatMarketplaceRow shows proyecto origin and yes when installed", () => {
    const line = formatMarketplaceRow({
      kind: "mcp",
      origin: "proyecto",
      installed: true,
      name: "echo",
    });
    expect(line).toContain("proyecto");
    expect(line).toContain("yes");
    expect(line).toContain("echo");
  });

  test("filterMarketplaceRows git includes github, limit 10", () => {
    const view = mergeMarketplaceView({});
    const filtered = filterMarketplaceRows(view.entries, "git", 10);
    expect(filtered.some((r) => r.name === "github")).toBe(true);
    expect(filtered.some((r) => r.name === "commit")).toBe(false);
    expect(filtered.length).toBeLessThanOrEqual(10);
  });

  test("host chavez-git does not appear in merged view", () => {
    const view = mergeMarketplaceView({
      installedMcp: [{ name: "chavez-git", layer: "host", path: "" }],
    });
    expect(view.entries.some((r) => r.name === "chavez-git")).toBe(false);
  });

  test("marketplaceOverlayTitle includes entry count", () => {
    const view = mergeMarketplaceView({});
    expect(marketplaceOverlayTitle(view)).toContain(String(view.entries.length));
  });
});
