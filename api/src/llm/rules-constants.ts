export const CANONICAL_DISALLOW_TOOLS = [
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "bash",
] as const;
export type CanonicalDisallowTool =
  (typeof CANONICAL_DISALLOW_TOOLS)[number];

export const USER_RULES_MAX = 50;
export const USER_RULE_TITLE_MAX = 120;
export const USER_RULE_BODY_MAX = 32_000;

export const USER_RULES_CAP_ERROR = "Maximum 50 user rules";
export const USER_RULE_TITLE_ERROR = "title must be 1–120 characters";
export const USER_RULE_BODY_ERROR = "body must be 1–32000 characters";
export const INVALID_DISALLOW_ERROR =
  "disallowTools must be canonical tool names: read, write, edit, grep, glob, bash";

export function isCanonicalDisallowTool(
  v: unknown,
): v is CanonicalDisallowTool {
  return (
    typeof v === "string" &&
    (CANONICAL_DISALLOW_TOOLS as readonly string[]).includes(v)
  );
}

export function parseCanonicalToolList(
  v: unknown,
): CanonicalDisallowTool[] | null {
  if (v == null) return [];
  if (typeof v === "string") {
    const parts = v
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.some((p) => !isCanonicalDisallowTool(p))) return null;
    return parts as CanonicalDisallowTool[];
  }
  if (!Array.isArray(v)) return null;
  const out: CanonicalDisallowTool[] = [];
  for (const item of v) {
    const s = String(item).trim().toLowerCase();
    if (!isCanonicalDisallowTool(s)) return null;
    out.push(s);
  }
  return out;
}
