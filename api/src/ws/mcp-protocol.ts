export const MCP_NATIVE_TOOLS_OK = "Native tools continue";
export const MCP_FAILED_PREFIX = "MCP server failed: ";

type McpServerLike = {
  name?: unknown;
  status?: unknown;
};

export function formatMcpFailedSystem(
  servers: readonly McpServerLike[],
): string | null {
  const failed = servers
    .filter((server) => server.status === "failed")
    .map((server) =>
      typeof server.name === "string" && server.name.trim()
        ? server.name.trim()
        : "unknown",
    );
  if (failed.length === 0) return null;
  return `${MCP_FAILED_PREFIX}${failed.join(", ")} — ${MCP_NATIVE_TOOLS_OK}`;
}

export function preserveToolMetadata(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...incoming };
}
