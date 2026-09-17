import { canonicalToolName } from "./tool-names";

export const DEFAULT_CURSOR_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "glob",
  "ls",
  "shell",
] as const;

export function canonicalCursorToolName(name: string): string {
  return canonicalToolName(name);
}

export function stringifyToolPayload(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
