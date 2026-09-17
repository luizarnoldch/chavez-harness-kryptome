import { describe, expect, test } from "bun:test";
import { lookupOfficial } from "./marketplace-catalog";
import { marketplaceHostProtected } from "./marketplace-constants";
import {
  applyMcpInstall,
  applyMcpUninstall,
  emptyMcpJson,
  serializeMcpJson,
} from "./marketplace-mcp-json";

describe("marketplace-mcp-json", () => {
  const githubRecipe = lookupOfficial("github");
  if (!githubRecipe.ok) throw new Error("github recipe missing");

  test("install github on empty → upsert, npx command, diff contains github", () => {
    const r = applyMcpInstall(emptyMcpJson(), "github", githubRecipe.entry.recipe!);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.action).toBe("upsert");
    expect(r.next.mcpServers.github!.command).toBe("npx");
    expect(r.diff).toContain("+");
    expect(r.diff).toContain("github");
    expect(r.next.mcpServers.github).not.toHaveProperty("env");
  });

  test("reinstall → noop, empty diff", () => {
    const first = applyMcpInstall(emptyMcpJson(), "github", githubRecipe.entry.recipe!);
    if ("error" in first) throw new Error(first.error);
    const r = applyMcpInstall(first.next, "github", githubRecipe.entry.recipe!);
    if ("error" in r) throw new Error(r.error);
    expect(r.action).toBe("noop");
    expect(r.diff).toBe("");
  });

  test("uninstall key only in .mcp.json → remove, key absent", () => {
    const installed = applyMcpInstall(emptyMcpJson(), "github", githubRecipe.entry.recipe!);
    if ("error" in installed) throw new Error(installed.error);
    const r = applyMcpUninstall(installed.next, "github");
    if ("error" in r) throw new Error(r.error);
    expect(r.action).toBe("remove");
    expect(r.next.mcpServers.github).toBeUndefined();
    expect(r.next.disabledServers).toEqual([]);
  });

  test("uninstall with presentInOtherProjectFiles → disable, key kept if in file", () => {
    const installed = applyMcpInstall(emptyMcpJson(), "github", githubRecipe.entry.recipe!);
    if ("error" in installed) throw new Error(installed.error);
    const r = applyMcpUninstall(installed.next, "github", {
      presentInOtherProjectFiles: true,
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.action).toBe("disable");
    expect(r.next.disabledServers).toContain("github");
    expect(r.next.mcpServers.github).toBeDefined();
  });

  test("uninstall elsewhere only → disable, empty mcpServers, disabledServers has name", () => {
    const r = applyMcpUninstall(emptyMcpJson(), "github", {
      presentInOtherProjectFiles: true,
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.action).toBe("disable");
    expect(r.next.mcpServers).toEqual({});
    expect(r.next.disabledServers).toEqual(["github"]);
  });

  test("uninstall chavez-git → host protected error", () => {
    const r = applyMcpUninstall(emptyMcpJson(), "chavez-git");
    expect(r).toEqual({ error: marketplaceHostProtected("chavez-git") });
  });

  test("serializeMcpJson ends with newline, omits empty disabledServers", () => {
    const s = serializeMcpJson(emptyMcpJson());
    expect(s.endsWith("\n")).toBe(true);
    expect(s).not.toContain("disabledServers");
  });
});
