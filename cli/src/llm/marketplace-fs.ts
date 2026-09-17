import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MARKETPLACE_FILE,
  MARKETPLACE_RECIPE_MISMATCH,
  marketplaceNotFound,
} from "./marketplace-constants";
import { lookupOfficial, recipesEqual } from "./marketplace-catalog";
import {
  applyMcpInstall,
  applyMcpUninstall,
  emptyMcpJson,
  parseMcpJsonFile,
  serializeMcpJson,
  type McpJsonFile,
  type McpJsonPatch,
} from "./marketplace-mcp-json";
import { loadMcpFromDisk } from "./mcp-load";

export function readProjectMcpJson(cwd: string): McpJsonFile {
  const abs = join(cwd, MARKETPLACE_FILE);
  if (!existsSync(abs)) return emptyMcpJson();
  try {
    const raw = readFileSync(abs, "utf8");
    if (!raw.trim()) return emptyMcpJson();
    return parseMcpJsonFile(JSON.parse(raw));
  } catch {
    return parseMcpJsonFile(null);
  }
}

export function writeProjectMcpJson(cwd: string, file: McpJsonFile): string {
  const abs = join(cwd, MARKETPLACE_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  const text = serializeMcpJson(file);
  writeFileSync(abs, text, "utf8");
  return abs;
}

export function planMcpInstall(
  cwd: string,
  id: string,
): McpJsonPatch | { error: string } {
  const found = lookupOfficial(id);
  if (!found.ok) return { error: found.error };
  if (found.entry.kind !== "mcp") {
    return { error: marketplaceNotFound(id) };
  }
  if (!found.entry.recipe) {
    return { error: marketplaceNotFound(id) };
  }
  const current = readProjectMcpJson(cwd);
  return applyMcpInstall(current, found.entry.name, found.entry.recipe);
}

export function planMcpUninstall(
  cwd: string,
  name: string,
): McpJsonPatch | { error: string } {
  const current = readProjectMcpJson(cwd);
  const disk = loadMcpFromDisk(cwd);
  const elsewhere = disk.servers.some(
    (s) => s.name === name && s.path !== MARKETPLACE_FILE && s.layer === "project",
  );
  return applyMcpUninstall(current, name, { presentInOtherProjectFiles: elsewhere });
}

export function assertRecipeMatchesCatalog(
  id: string,
  recipe: { transport: string; command?: string; args?: string[]; url?: string },
): string | null {
  const found = lookupOfficial(id);
  if (!found.ok) return found.error;
  if (found.entry.kind !== "mcp" || !found.entry.recipe) return found.error;
  if (!recipesEqual(found.entry.recipe, recipe as typeof found.entry.recipe)) {
    return MARKETPLACE_RECIPE_MISMATCH;
  }
  return null;
}

export function applyPatch(cwd: string, patch: McpJsonPatch): void {
  writeProjectMcpJson(cwd, patch.next);
}
