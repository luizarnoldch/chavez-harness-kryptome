import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITEXCLUDE_LINES, localRuleCommitDenied } from "./rules-constants";

export function isLocalRuleRelPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (n === "CHAVEZ.local.md" || n === "CLAUDE.local.md") return true;
  if (n === ".chavez/rules.local.md") return true;
  if (n === ".chavez" || n.startsWith(".chavez/")) return true;
  return false;
}

export function gitExcludePath(cwd: string): string {
  return join(cwd, ".git", "info", "exclude");
}

/** No-op if cwd is not a git repo. Never writes .gitignore (that would be a commit). */
export function ensureLocalRulesGitExcluded(cwd: string): void {
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) return;
  const infoDir = join(gitDir, "info");
  mkdirSync(infoDir, { recursive: true });
  const file = gitExcludePath(cwd);
  let existing = "";
  try {
    existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    existing = "";
  }
  const have = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const missing = GITEXCLUDE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return;
  const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
  const block = `${prefix}# Chavez local rules (do not commit)\n${missing.join("\n")}\n`;
  writeFileSync(file, existing + block, "utf8");
}

export function localRuleCommitBlockedReason(relPath: string): string | null {
  if (!isLocalRuleRelPath(relPath)) return null;
  return localRuleCommitDenied(relPath.replace(/\\/g, "/"));
}
