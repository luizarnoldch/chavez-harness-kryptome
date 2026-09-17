import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { workspaceHash } from "../workspace";
import {
  PROJECT_MCP_FILES,
  MCP_CONFIG_FILES_MAX,
  MCP_CONNECT_TIMEOUT_MS,
  mcpConfigParseError,
  type McpServerConfigJson,
  type McpServerSource,
} from "./mcp-constants";
import {
  applyDisabled,
  mergeMcpLayers,
  parseMcpServersObject,
  type McpParseResult,
} from "./mcp-parse";

function readJsonFile(
  abs: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!existsSync(abs)) return { ok: true, value: null };
  try {
    const raw = readFileSync(abs, "utf8");
    if (!raw.trim()) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function loadMcpFromDisk(
  cwd: string,
  opts?: { localFile?: string },
): McpParseResult {
  const projectParts: McpParseResult[] = [];
  let files = 0;
  for (const rel of PROJECT_MCP_FILES) {
    if (files >= MCP_CONFIG_FILES_MAX) break;
    const abs = join(cwd, rel);
    const got = readJsonFile(abs);
    files += 1;
    if (!got.ok) {
      projectParts.push({
        servers: [],
        errors: [{ path: rel, reason: got.reason }],
        collisions: [],
        disabledServers: [],
      });
      continue;
    }
    if (got.value == null) continue;
    projectParts.push(parseMcpServersObject(got.value, rel, "project"));
  }
  const project = projectParts.reduce<McpParseResult>(
    (acc, p) => ({
      servers: [...acc.servers, ...p.servers],
      errors: [...acc.errors, ...p.errors],
      collisions: [...acc.collisions, ...p.collisions],
      disabledServers: [...new Set([...acc.disabledServers, ...p.disabledServers])],
    }),
    { servers: [], errors: [], collisions: [], disabledServers: [] },
  );

  const localRel = `~/.chavez/workspaces/${workspaceHash(cwd)}/mcp.json`;
  const localAbs =
    opts?.localFile ??
    join(homedir(), ".chavez", "workspaces", workspaceHash(cwd), "mcp.json");
  const localGot = readJsonFile(localAbs);
  const local: McpParseResult = !localGot.ok
    ? {
        servers: [],
        errors: [{ path: localRel, reason: localGot.reason }],
        collisions: [],
        disabledServers: [],
      }
    : localGot.value == null
      ? { servers: [], errors: [], collisions: [], disabledServers: [] }
      : parseMcpServersObject(localGot.value, localRel, "local");

  return applyDisabled(mergeMcpLayers(project, local));
}

export function toClaudeMcpServers(
  sources: McpServerSource[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of sources) {
    out[s.name] = claudeSdkConfig(s.config);
  }
  return out;
}

function claudeSdkConfig(c: McpServerConfigJson): Record<string, unknown> {
  const timeout = c.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  if (c.transport === "stdio") {
    return {
      type: "stdio",
      command: c.command,
      args: c.args ?? [],
      env: c.env,
      timeout,
    };
  }
  if (c.transport === "sse") {
    return { type: "sse", url: c.url, headers: c.headers, timeout };
  }
  return { type: "http", url: c.url, headers: c.headers, timeout };
}

void mcpConfigParseError;
