import {
  NO_RULES_LABEL,
  RULES_PREAMBLE,
  RULES_PROMPT_MAX_CHARS,
  ruleToolDenied,
  type CanonicalDisallowTool,
  type RuleLayer,
} from "./rules-constants";
import { pactCommandFromRules } from "./verify-pact";

export type RuleSource = {
  layer: RuleLayer;
  id?: string;
  title: string;
  body: string;
  path?: string;
  enabled: boolean;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  chars: number;
  truncated: boolean;
  globs?: string[];
  alwaysApply?: boolean;
  verifyCommand?: string | null;
};

export type RuleRef = Omit<RuleSource, "body">;

export type RulesBundle = {
  user: RuleSource[];
  project: RuleSource[];
  local: RuleSource[];
  userRulesEnabled: boolean;
  disallowedTools: CanonicalDisallowTool[];
  verifyCommand: string | null;
};

export type RulesMetadata = {
  counts: { user: number; project: number; local: number; total: number };
  applied: RuleRef[];
};

export function enabledOnly(rules: RuleSource[]): RuleSource[] {
  return rules.filter(
    (r) =>
      r.enabled &&
      (r.body.trim() ||
        r.disallowTools.length ||
        r.allowTools.length ||
        (r.verifyCommand && r.verifyCommand.trim())),
  );
}

/**
 * Apply layers in order user → project → local.
 * Each layer unions its disallowTools, then subtracts its allowTools.
 * Later layer wins on explicit conflict (allow in local undoes user/project disallow).
 */
export function mergeDisallowedTools(
  user: RuleSource[],
  project: RuleSource[],
  local: RuleSource[],
): CanonicalDisallowTool[] {
  const set = new Set<CanonicalDisallowTool>();
  const apply = (rules: RuleSource[]) => {
    for (const r of rules) {
      for (const t of r.disallowTools) set.add(t);
      for (const t of r.allowTools) set.delete(t);
    }
  };
  apply(user);
  apply(project);
  apply(local);
  return [...set];
}

export function assembleBundle(input: {
  user: RuleSource[];
  project: RuleSource[];
  local: RuleSource[];
  userRulesEnabled: boolean;
}): RulesBundle {
  const user = input.userRulesEnabled ? enabledOnly(input.user) : [];
  const project = enabledOnly(input.project);
  const local = enabledOnly(input.local);
  const bundle: RulesBundle = {
    user,
    project,
    local,
    userRulesEnabled: input.userRulesEnabled,
    disallowedTools: mergeDisallowedTools(user, project, local),
    verifyCommand: null,
  };
  bundle.verifyCommand = pactCommandFromRules([
    ...bundle.user,
    ...bundle.project,
    ...bundle.local,
  ]);
  return bundle;
}

export function toRuleRef(r: RuleSource): RuleRef {
  const { body: _body, ...ref } = r;
  return ref;
}

export function rulesMetadata(bundle: RulesBundle): RulesMetadata {
  const applied = [...bundle.user, ...bundle.project, ...bundle.local].map(
    toRuleRef,
  );
  return {
    counts: {
      user: bundle.user.length,
      project: bundle.project.length,
      local: bundle.local.length,
      total: applied.length,
    },
    applied,
  };
}

export function formatRulesPrompt(bundle: RulesBundle): string | undefined {
  const sections: string[] = [];
  const pushLayer = (label: string, rules: RuleSource[]) => {
    if (!rules.length) return;
    sections.push(`## ${label}`);
    for (const r of rules) {
      const where = r.path ? ` (\`${r.path}\`)` : "";
      const globs =
        r.globs && r.globs.length
          ? `\nGlobs: ${r.globs.join(", ")}`
          : "";
      const tools =
        r.disallowTools.length || r.allowTools.length
          ? `\nStructured: disallowTools=[${r.disallowTools.join(",")}] allowTools=[${r.allowTools.join(",")}]`
          : "";
      sections.push(`### ${r.title}${where}${globs}${tools}\n\n${r.body}`);
    }
  };
  pushLayer("User rules", bundle.user);
  pushLayer("Project rules", bundle.project);
  pushLayer("Local rules (highest precedence)", bundle.local);
  if (!sections.length && !bundle.disallowedTools.length) return undefined;

  const extra = bundle.disallowedTools.length
    ? `\n\nHard tool restrictions (enforced by the host, not only this text): disallowed tools = ${bundle.disallowedTools.join(", ")}.`
    : "";
  const verifyLine = bundle.verifyCommand
    ? `\n\nWorkspace verification command (use this exact command after edits; do not invent another): \`${bundle.verifyCommand}\``
    : "";
  let text = `${RULES_PREAMBLE}\n\n${sections.join("\n\n")}${extra}${verifyLine}`;
  if (text.length > RULES_PROMPT_MAX_CHARS) {
    text = `${text.slice(0, RULES_PROMPT_MAX_CHARS)}\n\n[rules prompt truncated]`;
  }
  return text;
}

export function findDisallowingRule(
  bundle: RulesBundle,
  tool: CanonicalDisallowTool,
): RuleSource | null {
  // Highest layer that still disallows after merge: search local → project → user
  for (const r of [...bundle.local].reverse()) {
    if (r.allowTools.includes(tool)) return null;
    if (r.disallowTools.includes(tool)) return r;
  }
  for (const r of [...bundle.project].reverse()) {
    if (r.allowTools.includes(tool)) return null;
    if (r.disallowTools.includes(tool)) return r;
  }
  for (const r of [...bundle.user].reverse()) {
    if (r.allowTools.includes(tool)) return null;
    if (r.disallowTools.includes(tool)) return r;
  }
  return null;
}

export function denyIfRuleDisallowed(
  bundle: RulesBundle,
  canonicalTool: string,
): { behavior: "deny"; message: string } | null {
  const tool = canonicalTool as CanonicalDisallowTool;
  if (!bundle.disallowedTools.includes(tool)) return null;
  const rule = findDisallowingRule(bundle, tool);
  const layer = rule?.layer ?? "local";
  const title = rule?.title ?? "rule";
  return {
    behavior: "deny",
    message: ruleToolDenied(layer, title, tool),
  };
}

export function rulesWatchLine(meta: RulesMetadata): string {
  const { counts } = meta;
  if (counts.total === 0) return NO_RULES_LABEL;
  return `rules: ${counts.total} (user=${counts.user} project=${counts.project} local=${counts.local})`;
}
