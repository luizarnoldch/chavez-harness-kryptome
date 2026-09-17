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
  disabledServers: string[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseDisabledServers(raw: unknown): string[] {
  const root = asRecord(raw);
  if (!root || !Array.isArray(root.disabledServers)) return [];
  return [...new Set(root.disabledServers.map((x) => String(x)).filter(Boolean))];
}

const HOST_FILTER_EXEMPT = new Set<string>(HOST_MCP_NAMES);

function filterDisabledServers(
  servers: McpServerSource[],
  disabled: Set<string>,
): McpServerSource[] {
  return servers.filter((s) => {
    if (HOST_FILTER_EXEMPT.has(s.name)) return true;
    return !disabled.has(s.name);
  });
}

export function parseMcpServersObject(
  raw: unknown,
  path: string,
  layer: "project" | "local",
): McpParseResult {
  const errors: McpParseResult["errors"] = [];
  const collisions: McpParseResult["collisions"] = [];
  const servers: McpServerSource[] = [];
  const disabledServers = parseDisabledServers(raw);

  const root = asRecord(raw);
  if (!root) {
    errors.push({ path, reason: "root must be an object" });
    return { servers, errors, collisions, disabledServers: [] };
  }
  const mcpServers = asRecord(root.mcpServers);
  if (!mcpServers) {
    return { servers, errors, collisions, disabledServers };
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
  return { servers, errors, collisions, disabledServers };
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

function mergeDisabled(results: McpParseResult[]): string[] {
  const out = new Set<string>();
  for (const r of results) {
    for (const n of r.disabledServers) out.add(n);
  }
  return [...out];
}

export function applyDisabled(result: McpParseResult): McpParseResult {
  const disabled = new Set(result.disabledServers);
  return {
    ...result,
    servers: result.servers.filter((s) => {
      if (s.layer === "host") return true;
      if (s.name === "chavez-git" || s.name === "chavez-skills") return true;
      return !disabled.has(s.name);
    }),
  };
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
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      servers.push(s);
    }
  }
  const disabledServers = mergeDisabled(results);
  return {
    servers: filterDisabledServers(servers, new Set(disabledServers)),
    errors,
    collisions,
    disabledServers,
  };
}

/** Local layer last so it overrides project on the same name. */
export function mergeMcpLayers(
  project: McpParseResult,
  local: McpParseResult,
): McpParseResult {
  const byName = new Map<string, McpServerSource>();
  for (const s of project.servers) byName.set(s.name, s);
  for (const s of local.servers) byName.set(s.name, s);
  const disabledServers = mergeDisabled([project, local]);
  const servers = filterDisabledServers(
    [...byName.values()],
    new Set(disabledServers),
  );
  return {
    servers,
    errors: [...project.errors, ...local.errors],
    collisions: [...project.collisions, ...local.collisions],
    disabledServers,
  };
}

void mcpConfigParseError;
void mcpNameCollision;
