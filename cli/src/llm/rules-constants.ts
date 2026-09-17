export { NO_DAEMON_ERROR } from "./undo-constants";

export const RULE_LAYERS = ["user", "project", "local"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

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
export const RULE_BODY_MAX_CHARS = 32_000;
export const RULE_PREVIEW_CHARS = 2_000;
export const RULES_PROMPT_MAX_CHARS = 80_000;
export const RULE_PROJECT_FILES_MAX = 40;
export const RULES_RPC_TIMEOUT_MS = 5_000;

export const USER_RULES_CAP_ERROR = "Maximum 50 user rules";
export const USER_RULE_TITLE_ERROR = "title must be 1–120 characters";
export const USER_RULE_BODY_ERROR = "body must be 1–32000 characters";
export const INVALID_DISALLOW_ERROR =
  "disallowTools must be canonical tool names: read, write, edit, grep, glob, bash";

export const RULES_PREAMBLE =
  "Chavez project rules are in effect. Three layers apply: user, project, local. If they conflict, local overrides project, and project overrides user.";

export const NO_RULES_LABEL = "0 reglas";

export function ruleToolDenied(
  layer: RuleLayer,
  title: string,
  tool: string,
): string {
  return `Rule (${layer} "${title}"): tool "${tool}" is disallowed`;
}

export function localRuleCommitDenied(path: string): string {
  return `Refusing to commit local rule file: ${path}`;
}

export const LOCAL_CWD_RELATIVE = [
  "CLAUDE.local.md",
  "CHAVEZ.local.md",
  ".chavez/rules.local.md",
] as const;

export const GITEXCLUDE_LINES = [
  "CHAVEZ.local.md",
  "CLAUDE.local.md",
  ".chavez/",
] as const;

export const PROJECT_ROOT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".cursor/rules.md",
  ".claude/CLAUDE.md",
] as const;

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
