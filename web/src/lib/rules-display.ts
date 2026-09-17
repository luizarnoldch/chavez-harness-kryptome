export function rulesWatchLine(counts: {
  user: number;
  project: number;
  local: number;
  total: number;
}): string {
  if (!counts.total) return "0 reglas";
  return `rules: ${counts.total} (user=${counts.user} project=${counts.project} local=${counts.local})`;
}

export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

export type CanonicalDisallowTool =
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "bash";

export type UserRule = {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  createdAt: string;
  updatedAt: string;
};

export type RuleRef = {
  layer: "user" | "project" | "local";
  id?: string;
  title: string;
  path?: string;
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  chars: number;
  truncated: boolean;
  globs?: string[];
  alwaysApply?: boolean;
};

export type RulesMetadata = {
  counts: { user: number; project: number; local: number; total: number };
  applied: RuleRef[];
};

export type WorkspaceRulesSnapshot = {
  project: RuleRef[];
  local: RuleRef[];
  localContent: string;
  localPath: string;
};
