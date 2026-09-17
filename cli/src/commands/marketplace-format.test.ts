import { describe, expect, test } from "bun:test";
import { formatMarketplaceList } from "../llm/marketplace-view";
import type { MarketplaceView } from "../llm/marketplace-constants";
import { parseMarketplaceArgs } from "./marketplace-args";

describe("parseMarketplaceArgs", () => {
  test("list", () => {
    expect(parseMarketplaceArgs(["list"])).toEqual({ action: "list", json: false });
    expect(parseMarketplaceArgs([])).toEqual({ action: "list", json: false });
    expect(parseMarketplaceArgs(["list", "--json"])).toEqual({
      action: "list",
      json: true,
    });
  });

  test("install skill", () => {
    expect(parseMarketplaceArgs(["install", "skill", "commit"])).toEqual({
      action: "install",
      kind: "skill",
      id: "commit",
    });
  });

  test("install mcp without id throws usage", () => {
    expect(() => parseMarketplaceArgs(["install", "mcp"])).toThrow(
      /chavez marketplace install mcp/,
    );
  });

  test("uninstall mcp chavez-git parses", () => {
    expect(parseMarketplaceArgs(["uninstall", "mcp", "chavez-git"])).toEqual({
      action: "uninstall",
      kind: "mcp",
      name: "chavez-git",
    });
  });
});

describe("formatMarketplaceList", () => {
  test("oficial and proyecto origins", () => {
    const view: MarketplaceView = {
      entries: [
        {
          id: "github",
          kind: "mcp",
          name: "github",
          title: "GitHub",
          description: "GitHub MCP",
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
          layer: "project",
          path: ".mcp.json",
          requiredEnv: [],
        },
      ],
      errors: [],
      nativeToolsContinue: true,
    };
    const text = formatMarketplaceList(view);
    expect(text).toContain("kind  origin     installed  name");
    expect(text).toContain("oficial");
    expect(text).toContain("proyecto");
    expect(text).toContain("github");
    expect(text).toContain("echo");
  });
});
