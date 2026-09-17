import type { McpServerConfigJson, McpServerSource } from "./mcp-constants";
import {
  MCP_SERVERS_MAX,
  HOST_MCP_NAMES,
  mcpConfigParseError,
  mcpNameCollision,
} from "./mcp-constants";

export type McpParseResult = {
  servers: McpServerSource[];
  errors: { path: string; reason: string }[];
  collisions: { name: string; alias: string }[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseMcpServersObject(
  raw: unknown,
  path: string,
  layer: "project" | "local",
): McpParseResult {
  const errors: McpParseResult["errors"] = [];
  const collisions: McpParseResult["collisions"] = [];
  const servers: McpServerSource[] = [];

  const root = asRecord(raw);
  if (!root) {
    errors.push({ path, reason: "root must be an object" });
    return { servers, errors, collisions };
  }
  const mcpServers = asRecord(root.mcpServers);
  if (!mcpServers) {
    return { servers, errors, collisions }; // archivo sin mcpServers = vacío, no error
  }

  const names = Object.keys(mcpServers).slice(0, MCP_SERVERS_MAX);
  for (const name of names) {
    const entry = asRecord(mcpServers[name]);
    if (!entry) {
      errors.push({ path, reason: `server "${name}" must be an object` });
      continue;
    }
    const parsed = parseOneServer(name, entry);
    if ("reason" in parsed) {
      errors.push({ path, reason: parsed.reason });
      continue;
    }
    let finalName = parsed.name;
    if ((HOST_MCP_NAMES as readonly string[]).includes(finalName)) {
      const alias = `${finalName}-project`;
      collisions.push({ name: finalName, alias });
      finalName = alias;
    }
    servers.push({
      name: finalName,
      config: { ...parsed, name: finalName },
      layer,
      path,
    });
  }
  return { servers, errors, collisions };
}

function parseOneServer(
  name: string,
  entry: Record<string, unknown>,
): McpServerConfigJson | { reason: string } {
  const type = String(
    entry.type || (entry.command ? "stdio" : entry.url ? "http" : ""),
  );
  if (type === "sse" || (type === "http" && typeof entry.url === "string")) {
    if (typeof entry.url !== "string" || !entry.url) {
      return { reason: `server "${name}" missing url` };
    }
    return {
      name,
      transport: type === "sse" ? "sse" : "http",
      url: entry.url,
      headers: sanitizeStringMap(entry.headers),
      timeoutMs: num(entry.timeout),
    };
  }
  if (typeof entry.command !== "string" || !entry.command) {
    return { reason: `server "${name}" missing command` };
  }
  return {
    name,
    transport: "stdio",
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : [],
    env: sanitizeStringMap(entry.env),
    timeoutMs: num(entry.timeout),
  };
}

function sanitizeStringMap(v: unknown): Record<string, string> | undefined {
  const o = asRecord(v);
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) out[k] = String(val);
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function mergeMcpParseResults(results: McpParseResult[]): McpParseResult {
  const servers: McpServerSource[] = [];
  const errors: McpParseResult["errors"] = [];
  const collisions: McpParseResult["collisions"] = [];
  const seen = new Set<string>();
  for (const r of results) {
    errors.push(...r.errors);
    collisions.push(...r.collisions);
    for (const s of r.servers) {
      if (seen.has(s.name)) continue; // first file wins; local se parsea después y pisa si llamas reversed
      seen.add(s.name);
      servers.push(s);
    }
  }
  return { servers, errors, collisions };
}

/** Local layer last so it overrides project on the same name. */
export function mergeMcpLayers(
  project: McpParseResult,
  local: McpParseResult,
): McpParseResult {
  const byName = new Map<string, McpServerSource>();
  for (const s of project.servers) byName.set(s.name, s);
  for (const s of local.servers) byName.set(s.name, s);
  return {
    servers: [...byName.values()],
    errors: [...project.errors, ...local.errors],
    collisions: [...project.collisions, ...local.collisions],
  };
}

void mcpConfigParseError;
void mcpNameCollision;
