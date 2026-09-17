import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MARKETPLACE_FILE,
  MARKETPLACE_RECIPE_MISMATCH,
  marketplaceHostProtected,
  marketplaceNotFound,
} from "./marketplace-constants";
import { mcpJsonFilesEqual } from "./marketplace-mcp-json";
import {
  applyPatch,
  assertRecipeMatchesCatalog,
  planMcpInstall,
  planMcpUninstall,
  readProjectMcpJson,
} from "./marketplace-fs";
import { parseMcpJsonFile } from "./marketplace-mcp-json";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "marketplace-fs-"));
}

describe("marketplace-fs", () => {
  test("planMcpInstall on empty dir → upsert github with npx command", () => {
    const tmp = tempDir();
    const patch = planMcpInstall(tmp, "github");
    expect("error" in patch).toBe(false);
    if ("error" in patch) return;
    expect(patch.action).toBe("upsert");
    applyPatch(tmp, patch);
    const raw = readFileSync(join(tmp, MARKETPLACE_FILE), "utf8");
    const parsed = parseMcpJsonFile(JSON.parse(raw));
    expect(parsed.mcpServers.github!.command).toBe("npx");
  });

  test("marketplace-fs.ts does not import child_process", () => {
    const src = readFileSync(
      join(import.meta.dir, "marketplace-fs.ts"),
      "utf8",
    );
    expect(src.includes("child_process")).toBe(false);
  });

  test("planMcpInstall unknown id → not found", () => {
    const tmp = tempDir();
    const patch = planMcpInstall(tmp, "nope");
    expect(patch).toEqual({ error: marketplaceNotFound("nope") });
  });

  test("planMcpInstall skill id → not found", () => {
    const tmp = tempDir();
    const patch = planMcpInstall(tmp, "commit");
    expect(patch).toEqual({ error: marketplaceNotFound("commit") });
  });

  test("install then uninstall github → key removed from .mcp.json", () => {
    const tmp = tempDir();
    const install = planMcpInstall(tmp, "github");
    if ("error" in install) throw new Error(install.error);
    applyPatch(tmp, install);
    const uninstall = planMcpUninstall(tmp, "github");
    if ("error" in uninstall) throw new Error(uninstall.error);
    expect(uninstall.action).toBe("remove");
    applyPatch(tmp, uninstall);
    const parsed = readProjectMcpJson(tmp);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.mcpServers.github).toBeUndefined();
  });

  test("uninstall echo elsewhere → disable in .mcp.json, settings.json intact", () => {
    const tmp = tempDir();
    const settingsDir = join(tmp, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const settingsContent = JSON.stringify(
      { mcpServers: { echo: { command: "echo", args: ["hi"] } } },
      null,
      2,
    );
    writeFileSync(settingsPath, settingsContent, "utf8");

    const uninstall = planMcpUninstall(tmp, "echo");
    if ("error" in uninstall) throw new Error(uninstall.error);
    expect(uninstall.action).toBe("disable");
    applyPatch(tmp, uninstall);

    expect(readFileSync(settingsPath, "utf8")).toBe(settingsContent);
    const mcp = readProjectMcpJson(tmp);
    expect("error" in mcp).toBe(false);
    if ("error" in mcp) throw new Error(mcp.error);
    expect(mcp.disabledServers).toContain("echo");
  });

  test("invalid .mcp.json → planMcpInstall returns illegible error, no overwrite", () => {
    const tmp = tempDir();
    writeFileSync(join(tmp, MARKETPLACE_FILE), "{ not json", "utf8");
    const read = readProjectMcpJson(tmp);
    expect("error" in read).toBe(true);
    if (!("error" in read)) return;
    expect(read.error).toContain(".mcp.json is illegible");
    const patch = planMcpInstall(tmp, "github");
    expect("error" in patch).toBe(true);
    if (!("error" in patch)) return;
    expect(patch.error).toBe(read.error);
  });

  test("mcpJsonFilesEqual detects changed .mcp.json since patch.previous", () => {
    const tmp = tempDir();
    const install = planMcpInstall(tmp, "github");
    if ("error" in install) throw new Error(install.error);
    expect(mcpJsonFilesEqual(install.previous, install.next)).toBe(false);
    applyPatch(tmp, install);
    const current = readProjectMcpJson(tmp);
    if ("error" in current) throw new Error(current.error);
    expect(mcpJsonFilesEqual(current, install.previous)).toBe(false);
    expect(mcpJsonFilesEqual(current, install.next)).toBe(true);
  });

  test("assertRecipeMatchesCatalog mismatch → MARKETPLACE_RECIPE_MISMATCH", () => {
    const err = assertRecipeMatchesCatalog("github", {
      transport: "stdio",
      command: "evil",
    });
    expect(err).toBe(MARKETPLACE_RECIPE_MISMATCH);
  });

  test("assertRecipeMatchesCatalog mismatch on requiredEnv", () => {
    const err = assertRecipeMatchesCatalog("github", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      requiredEnv: ["OTHER_TOKEN"],
    });
    expect(err).toBe(MARKETPLACE_RECIPE_MISMATCH);
  });

  test("planMcpUninstall chavez-git → host protected", () => {
    const tmp = tempDir();
    const patch = planMcpUninstall(tmp, "chavez-git");
    expect(patch).toEqual({ error: marketplaceHostProtected("chavez-git") });
  });
});
