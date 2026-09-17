export { NO_DAEMON_ERROR } from "./undo-constants";
export { GIT_MCP_SERVER } from "./git-constants";
import { GIT_MCP_SERVER } from "./git-constants";

export const SKILLS_MCP_SERVER = "chavez-skills";
export const SKILL_TOOL_ID = "skill";

export const MCP_CONNECT_TIMEOUT_MS = 5_000;
export const MCP_TOOL_TIMEOUT_MS = 30_000;
export const MCP_SERVERS_MAX = 20;
export const MCP_CONFIG_FILES_MAX = 8;
export const MCP_RPC_TIMEOUT_MS = 5_000;

export const MCP_FAILED_PREFIX = "MCP server failed: ";
export const MCP_NATIVE_TOOLS_OK = "Native tools continue";
export const NO_MCP_LABEL = "0 MCP";

export const PLAN_MCP_MUTATION_DENIED =
  "Plan mode: mutating MCP tools are disabled. Switch to ask or auto to apply changes.";

export const HOST_MCP_NAMES = [GIT_MCP_SERVER, SKILLS_MCP_SERVER] as const;

export const PROJECT_MCP_FILES = [
  ".mcp.json",
  ".claude/settings.json",
  ".cursor/mcp.json",
] as const;

export const MCP_PREAMBLE =
  "Project MCP servers are loaded by Chavez. Native filesystem tools always remain available. If an MCP server failed, you still have read/write/edit/grep/glob/bash. Do not pretend a failed server's tools exist.";

export const MCP_STATUSES = [
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
] as const;
export type McpRuntimeStatus = (typeof MCP_STATUSES)[number];

export const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export type McpToolAnnotations = {
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
};

export type McpServerConfigJson = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type McpServerSource = {
  name: string;
  config: McpServerConfigJson;
  layer: "project" | "local";
  path: string;
};

export type McpServerRuntimeStatus = {
  name: string;
  status: McpRuntimeStatus;
  transport: McpTransport;
  error?: string;
  tools?: { name: string; readOnly: boolean; destructive: boolean }[];
  layer: "project" | "local" | "host";
};

export type McpSnapshot = {
  servers: McpServerRuntimeStatus[];
  failed: string[];
  nativeToolsContinue: true;
};

export const MCP_CONFIG_PARSE_ERROR = "MCP config parse failed";

export function mcpConfigParseError(path: string, reason: string): string {
  return `MCP config parse failed (${path}): ${reason}`;
}

export function mcpFailedMessage(name: string, error: string): string {
  return `${MCP_FAILED_PREFIX}${name} — ${error}`;
}

export function mcpNameCollision(name: string, alias: string): string {
  return `Project MCP server "${name}" collides with host server; loaded as "${alias}"`;
}

export function mcpFailedLabel(names: string[]): string {
  return `MCP failed: ${names.join(", ")}`;
}
