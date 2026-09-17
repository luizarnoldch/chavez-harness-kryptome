import { parseMcpSdkName } from "./mcp-names";
import type { McpToolAnnotations } from "./mcp-constants";

export type McpGateClass = "read" | "write";

export function annotationsFromUnknown(v: unknown): McpToolAnnotations {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const readOnly = o.readOnly === true || o.readOnlyHint === true;
  const destructive = o.destructive === true || o.destructiveHint === true;
  const openWorld = o.openWorld === true || o.openWorldHint === true;
  return { readOnly, destructive, openWorld };
}

/** Conservative: missing annotations ⇒ write (ask/plan). */
export function mcpGateClass(ann: McpToolAnnotations): McpGateClass {
  if (ann.readOnly && !ann.destructive) return "read";
  return "write";
}

export function isMcpToolName(toolName: string): boolean {
  return parseMcpSdkName(toolName) != null;
}
