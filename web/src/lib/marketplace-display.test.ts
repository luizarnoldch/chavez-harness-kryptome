import { describe, expect, test } from "bun:test";
import {
  filterMarketplaceRows,
  formatMarketplaceRow,
  type MarketplaceViewRow,
} from "./marketplace-display";

const rows: MarketplaceViewRow[] = [
  {
    id: "github",
    kind: "mcp",
    name: "github",
    title: "GitHub",
    description: "",
    origin: "oficial",
    installed: false,
    requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  },
  {
    id: "commit",
    kind: "skill",
    name: "commit",
    title: "Commit message",
    description: "",
    origin: "oficial",
    installed: false,
    requiredEnv: [],
  },
  {
    id: "project:echo",
    kind: "mcp",
    name: "echo",
    title: "echo",
    description: "",
    origin: "proyecto",
    installed: true,
    requiredEnv: [],
  },
];

describe("marketplace-display", () => {
  test("github oficial no instalado", () => {
    const line = formatMarketplaceRow({
      kind: "mcp",
      origin: "oficial",
      installed: false,
      name: "github",
    });
    expect(line).toBe("mcp · oficial · disponible · github");
  });

  test("echo proyecto instalado", () => {
    const line = formatMarketplaceRow({
      kind: "mcp",
      origin: "proyecto",
      installed: true,
      name: "echo",
    });
    expect(line).toBe("mcp · proyecto · instalado · echo");
  });

  test("filter git includes github not commit", () => {
    const filtered = filterMarketplaceRows(rows, "git", 10);
    expect(filtered.some((r) => r.name === "github")).toBe(true);
    expect(filtered.some((r) => r.name === "commit")).toBe(false);
    expect(filtered.length).toBeLessThanOrEqual(10);
  });
});
