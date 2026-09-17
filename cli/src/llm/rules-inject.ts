import { parseRuleFile, toRuleSource } from "./rules-parse";
import {
  assembleBundle,
  formatRulesPrompt,
  rulesMetadata,
  type RuleSource,
  type RulesBundle,
  type RulesMetadata,
} from "./rules-merge";
import { loadLocalRules, loadProjectRules } from "./rules-load";
import { ensureLocalRulesGitExcluded } from "./rules-git-exclude";
import type { CanonicalDisallowTool } from "./rules-constants";

export type DispatchUserRule = {
  id: string;
  title: string;
  body: string;
  enabled?: boolean;
  disallowTools?: string[];
  allowTools?: string[];
};

export function userRulesFromDispatch(
  rows: DispatchUserRule[] | undefined,
): RuleSource[] {
  if (!rows?.length) return [];
  return rows.map((r) => {
    const parsed = parseRuleFile(
      r.body.startsWith("---") ? r.body : `---\ntitle: ${r.title}\n---\n${r.body}`,
      r.title,
    );
    return toRuleSource("user", parsed, {
      id: r.id,
      enabled: r.enabled !== false,
    });
  }).map((src, i) => ({
    ...src,
    title: rows[i]!.title || src.title,
    disallowTools: (rows[i]!.disallowTools as CanonicalDisallowTool[]) ?? src.disallowTools,
    allowTools: (rows[i]!.allowTools as CanonicalDisallowTool[]) ?? src.allowTools,
  }));
}

export function loadTurnRules(input: {
  cwd: string;
  userRules?: DispatchUserRule[];
  userRulesEnabled?: boolean;
}): { bundle: RulesBundle; metadata: RulesMetadata; appendSystemPrompt?: string } {
  try {
    ensureLocalRulesGitExcluded(input.cwd);
  } catch {
    // exclude is best-effort; never fail the turn
  }
  let project: RuleSource[] = [];
  let local: RuleSource[] = [];
  try {
    project = loadProjectRules(input.cwd);
  } catch {
    project = [];
  }
  try {
    local = loadLocalRules(input.cwd);
  } catch {
    local = [];
  }
  const bundle = assembleBundle({
    user: userRulesFromDispatch(input.userRules),
    project,
    local,
    userRulesEnabled: input.userRulesEnabled !== false,
  });
  return {
    bundle,
    metadata: rulesMetadata(bundle),
    appendSystemPrompt: formatRulesPrompt(bundle),
  };
}

export function applyRulesToClaudeOptions(
  options: Record<string, unknown>,
  append: string | undefined,
): Record<string, unknown> {
  const next = { ...options, settingSources: [] as string[] };
  if (append) next.appendSystemPrompt = append;
  return next;
}

/** Cursor SDK replaces systemPrompt wholesale — prepend a block to the user prompt instead. */
export function applyRulesToCursorPrompt(
  prompt: string,
  append: string | undefined,
): string {
  if (!append) return prompt;
  return `${append}\n\n---\n\n${prompt}`;
}
