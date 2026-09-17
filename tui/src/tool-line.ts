type ToolMetadata = Record<string, unknown>;

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

export function indentIfChild(
  line: string,
  parentToolCallId: unknown,
): string {
  if (!parentToolCallId) return line;
  const currentDepth = Math.min(2, Math.floor((line.match(/^ */)?.[0].length ?? 0) / 2));
  if (currentDepth >= 2) return line;
  return `  ${line}`;
}

export function formatTuiToolLine(
  metadata: ToolMetadata,
  content: string,
): string {
  const kind = stringValue(metadata.kind, "");
  const status = stringValue(metadata.status, "running");

  if (kind === "subagent") {
    const agentType = stringValue(
      metadata.agentType ?? metadata.subagentId,
      "subagent",
    );
    return `subagent · ${agentType} · ${status}`;
  }
  if (kind === "skill") {
    const input =
      metadata.input && typeof metadata.input === "object"
        ? (metadata.input as ToolMetadata)
        : {};
    return `skill · ${stringValue(metadata.name ?? input.name, "skill")} · ${status}`;
  }
  if (kind === "mcp") {
    const server = stringValue(metadata.mcpServer, "");
    const tool = stringValue(metadata.mcpTool, "");
    const canonical = stringValue(
      metadata.canonical,
      server && tool
        ? `mcp:${server}/${tool}`
        : stringValue(metadata.toolName ?? metadata.sdkName, "mcp"),
    );
    return `mcp · ${canonical} · ${status}`;
  }

  return content;
}

export function mcpFailedBanner(
  status:
    | { failed?: unknown; servers?: unknown }
    | Array<Record<string, unknown>>
    | null
    | undefined,
): string | null {
  if (!status) return null;
  const payload = Array.isArray(status) ? { servers: status } : status;
  const explicit = Array.isArray(payload.failed)
    ? payload.failed.map(String).filter(Boolean)
    : [];
  const failed =
    explicit.length > 0
      ? explicit
      : Array.isArray(payload.servers)
        ? payload.servers
            .filter(
              (server): server is Record<string, unknown> =>
                !!server &&
                typeof server === "object" &&
                (server as Record<string, unknown>).status === "failed",
            )
            .map((server) => String(server.name || ""))
            .filter(Boolean)
        : [];
  return failed.length
    ? `MCP failed: ${failed.join(", ")} — native tools continue`
    : null;
}
