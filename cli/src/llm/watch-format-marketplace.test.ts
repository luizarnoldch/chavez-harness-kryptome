import { describe, expect, test } from "bun:test";
import { formatMarketplaceWatchLine } from "./watch-format-marketplace";

describe("formatMarketplaceWatchLine", () => {
  test("install ask includes .mcp.json and name", () => {
    expect(
      formatMarketplaceWatchLine({
        type: "marketplace.install.ask",
        data: { name: "github", path: ".mcp.json", diff: "+servers" },
      }),
    ).toBe("marketplace · ask · write .mcp.json · github");
  });

  test("changed includes op and name", () => {
    expect(
      formatMarketplaceWatchLine({
        type: "marketplace.changed",
        data: { kind: "skill", op: "install", name: "commit" },
      }),
    ).toBe("marketplace · install · commit");
    expect(
      formatMarketplaceWatchLine({
        type: "marketplace.changed",
        data: { op: "uninstall", name: "echo" },
      }),
    ).toBe("marketplace · uninstall · echo");
  });
});
