import { PathEscapeError, resolveInsideCwd } from "./workspace-path";
import { toolClass } from "./tool-names";

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

export function extractToolPath(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Deny file tools whose path leaves cwd. Bash has no single path field;
 * network/FS de bash es plan 26. Reads y writes se sandboxean igual.
 */
export function assertToolPathInsideCwd(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
): void {
  const p = extractToolPath(input);
  if (!p) return;
  const cls = toolClass(sdkName);
  if (cls === "other" && !p) return;
  resolveInsideCwd(cwd, p);
}

export function denyIfEscapes(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
): { behavior: "deny"; message: string } | null {
  try {
    assertToolPathInsideCwd(cwd, sdkName, input);
    return null;
  } catch (err) {
    const rel = err instanceof PathEscapeError ? err.relPath : String(err);
    return {
      behavior: "deny",
      message: `Path outside workspace: ${rel}`,
    };
  }
}
