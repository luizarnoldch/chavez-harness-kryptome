export type GitBashKind = "none" | "read" | "mutate" | "forbidden";

export type GitBashClass = {
  kind: GitBashKind;
  force: boolean;
  targetBranch: string | null;
  subcommand: string | null;
};

const READ_SUB = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "describe",
  "ls-files",
  "blame",
  "cat-file",
  "remote",
  "config",
]);

const MUTATE_SUB = new Set([
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "branch",
  "merge",
  "rebase",
  "cherry-pick",
  "stash",
  "reset",
  "revert",
  "tag",
  "clean",
  "mv",
  "rm",
  "restore",
  "worktree",
]);

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/);
}

/** First git invocation in a simple command (no pipes/and). */
export function classifyGitBash(command: string): GitBashClass {
  const empty: GitBashClass = {
    kind: "none",
    force: false,
    targetBranch: null,
    subcommand: null,
  };
  const raw = command.trim();
  if (!raw) return empty;
  if (/[|;&`$]/.test(raw) && /\bgit\b/.test(raw)) {
    // Opaque compound: treat as mutate so it cannot bypass guards via `git push --force`.
    if (/\bgit\s+push\b/.test(raw) && isForcePush(raw) && targetsProtected(raw)) {
      return { kind: "forbidden", force: true, targetBranch: "main", subcommand: "push" };
    }
    if (/\bgit\b/.test(raw)) {
      return { kind: "mutate", force: isForcePush(raw), targetBranch: null, subcommand: "compound" };
    }
    return empty;
  }
  const tokens = tokenize(raw);
  let i = 0;
  if (tokens[0] === "sudo") i += 1;
  if (tokens[i] !== "git") return empty;
  i += 1;
  while (tokens[i] && (tokens[i].startsWith("-") || tokens[i] === "-C")) {
    if (tokens[i] === "-C") i += 2;
    else i += 1;
  }
  const sub = tokens[i] || null;
  const rest = tokens.slice(i + 1).join(" ");
  const force = sub === "push" && isForcePush(rest);
  const target = pushDestBranch(tokens.slice(i + 1));
  if (force && isProtectedBranchName(target)) {
    return { kind: "forbidden", force: true, targetBranch: target, subcommand: "push" };
  }
  if (sub && READ_SUB.has(sub) && sub !== "remote" && sub !== "config") {
    return { kind: "read", force: false, targetBranch: target, subcommand: sub };
  }
  if (sub === "remote" || sub === "config") {
    const mutating = /\b(add|set-url|remove|rename|unset)\b/.test(rest);
    return {
      kind: mutating ? "mutate" : "read",
      force: false,
      targetBranch: null,
      subcommand: sub,
    };
  }
  if (sub && MUTATE_SUB.has(sub)) {
    return { kind: "mutate", force, targetBranch: target, subcommand: sub };
  }
  if (sub) return { kind: "mutate", force, targetBranch: target, subcommand: sub };
  return empty;
}

export function isForcePush(s: string): boolean {
  return /(?:^|\s)(--force|-f|--force-with-lease)(?:\s|$|=)/.test(s);
}

function isProtectedBranchName(name: string | null): boolean {
  return name === "main" || name === "master";
}

function targetsProtected(command: string): boolean {
  return /(^|\s)(origin\/)?(main|master)(\s|$)/.test(command);
}

function pushDestBranch(args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  // git push [<remote>] [<refspec>]
  if (positional.length >= 2) {
    const spec = positional[1];
    const dest = spec.includes(":") ? spec.split(":").pop() : spec;
    return dest || null;
  }
  return null;
}
