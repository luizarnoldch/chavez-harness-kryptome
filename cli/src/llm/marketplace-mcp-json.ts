import { MARKETPLACE_FILE, marketplaceHostProtected } from "./marketplace-constants";
import type { MarketplaceMcpRecipe } from "./marketplace-constants";

export type McpJsonFile = {
  mcpServers: Record<string, Record<string, unknown>>;
  disabledServers: string[];
};

export type McpJsonPatch = {
  next: McpJsonFile;
  previous: McpJsonFile;
  diff: string;
  action: "upsert" | "remove" | "disable" | "noop";
  path: typeof MARKETPLACE_FILE;
};

const HOST = new Set(["chavez-git", "chavez-skills"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseMcpJsonFile(raw: unknown): McpJsonFile {
  const root = asRecord(raw) ?? {};
  const block = asRecord(root.mcpServers) ?? {};
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [k, val] of Object.entries(block)) {
    const o = asRecord(val);
    if (o) mcpServers[k] = o;
  }
  const disabled = Array.isArray(root.disabledServers)
    ? root.disabledServers.map((x) => String(x)).filter(Boolean)
    : [];
  return { mcpServers, disabledServers: [...new Set(disabled)] };
}

export function emptyMcpJson(): McpJsonFile {
  return { mcpServers: {}, disabledServers: [] };
}

export function recipeToMcpServer(recipe: MarketplaceMcpRecipe): Record<string, unknown> {
  if (recipe.transport === "stdio") {
    return {
      command: recipe.command,
      args: recipe.args ?? [],
    };
  }
  return {
    type: recipe.transport,
    url: recipe.url,
  };
}

function serialize(file: McpJsonFile): string {
  const body: Record<string, unknown> = {
    mcpServers: file.mcpServers,
  };
  if (file.disabledServers.length) body.disabledServers = file.disabledServers;
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function unifiedDiff(previous: McpJsonFile, next: McpJsonFile): string {
  const a = serialize(previous).split("\n");
  const b = serialize(next).split("\n");
  const lines = [`--- a/${MARKETPLACE_FILE}`, `+++ b/${MARKETPLACE_FILE}`];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] != null) lines.push(`-${a[i]}`);
    if (b[i] != null) lines.push(`+${b[i]}`);
  }
  return lines.join("\n");
}

export function applyMcpInstall(
  current: McpJsonFile,
  name: string,
  recipe: MarketplaceMcpRecipe,
): McpJsonPatch | { error: string } {
  if (HOST.has(name)) return { error: marketplaceHostProtected(name) };
  const previous = {
    mcpServers: { ...current.mcpServers },
    disabledServers: [...current.disabledServers],
  };
  const already =
    current.mcpServers[name] &&
    !current.disabledServers.includes(name);
  if (already) {
    return {
      next: current,
      previous,
      diff: "",
      action: "noop",
      path: MARKETPLACE_FILE,
    };
  }
  const next: McpJsonFile = {
    mcpServers: {
      ...current.mcpServers,
      [name]: recipeToMcpServer(recipe),
    },
    disabledServers: current.disabledServers.filter((n) => n !== name),
  };
  return {
    next,
    previous,
    diff: unifiedDiff(previous, next),
    action: "upsert",
    path: MARKETPLACE_FILE,
  };
}

export function applyMcpUninstall(
  current: McpJsonFile,
  name: string,
  opts?: { presentInOtherProjectFiles?: boolean },
): McpJsonPatch | { error: string } {
  if (HOST.has(name)) return { error: marketplaceHostProtected(name) };
  const previous = {
    mcpServers: { ...current.mcpServers },
    disabledServers: [...current.disabledServers],
  };
  const inFile = Boolean(current.mcpServers[name]);
  const disabled = current.disabledServers.includes(name);
  const elsewhere = Boolean(opts?.presentInOtherProjectFiles);
  if (!inFile && !elsewhere) {
    return { error: `Not installed: ${name}` };
  }
  if (!inFile && elsewhere && disabled) {
    return { error: `Not installed: ${name}` };
  }
  const next: McpJsonFile = {
    mcpServers: { ...current.mcpServers },
    disabledServers: [...current.disabledServers],
  };
  let action: McpJsonPatch["action"] = "remove";
  if (inFile && !elsewhere) {
    delete next.mcpServers[name];
    next.disabledServers = next.disabledServers.filter((n) => n !== name);
    action = "remove";
  } else {
    if (!next.disabledServers.includes(name)) next.disabledServers.push(name);
    action = "disable";
  }
  return {
    next,
    previous,
    diff: unifiedDiff(previous, next),
    action,
    path: MARKETPLACE_FILE,
  };
}

export function serializeMcpJson(file: McpJsonFile): string {
  return serialize(file);
}
