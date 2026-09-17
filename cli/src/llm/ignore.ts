import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  HARNESS_JUNK_DIR_NAMES,
  HARNESS_SECRET_PATTERNS,
  HUGE_BINARY_BYTES,
  HUGE_FILE_BYTES,
  VAULT_DIR_NAME,
  type IgnoreClass,
} from "./ignore-patterns";
import { toPosix } from "./workspace-path";

export { reasonForClass } from "./ignore-patterns";

export type IgnoreRule = {
  base: string;
  raw: string;
  negate: boolean;
  dirOnly: boolean;
  /** secret harness rules cannot be undone by gitignore. */
  locked: boolean;
  class: Exclude<IgnoreClass, "none" | "huge">;
  re: RegExp;
};

export type IgnoreSet = {
  cwd: string;
  vaultRoot: string;
  rules: IgnoreRule[];
};

export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegex(ch: string): string {
  return /[\\^$+{}[\]()|.]/.test(ch) ? `\\${ch}` : ch;
}

/** Convert one gitignore glob to a RegExp matching a posix relative path. */
export function globToRegExp(glob: string, anchored: boolean): RegExp {
  let src = "";
  let i = 0;
  while (i < glob.length) {
    const a = glob[i];
    const b = glob[i + 1];
    if (a === "*" && b === "*") {
      if (glob[i + 2] === "/") {
        src += "(?:.*/)?";
        i += 3;
        continue;
      }
      src += ".*";
      i += 2;
      continue;
    }
    if (a === "*") {
      src += "[^/]*";
      i += 1;
      continue;
    }
    if (a === "?") {
      src += "[^/]";
      i += 1;
      continue;
    }
    src += escapeRegex(a!);
    i += 1;
  }
  const body = anchored ? `^${src}` : `(?:^|/)${src}`;
  return new RegExp(`${body}(?:/.*)?$`);
}

export function parseIgnoreLine(
  line: string,
  base: string,
  cls: IgnoreRule["class"],
  locked: boolean,
): IgnoreRule | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.trim() || trimmed.startsWith("#")) return null;
  let raw = trimmed;
  let negate = false;
  if (raw.startsWith("!")) {
    negate = true;
    raw = raw.slice(1);
  }
  raw = raw.replace(/\\ /g, " ");
  let dirOnly = false;
  if (raw.endsWith("/") && raw !== "/") {
    dirOnly = true;
    raw = raw.slice(0, -1);
  }
  if (!raw || raw === ".") return null;
  const anchored = raw.startsWith("/") || raw.slice(0, -1).includes("/");
  const glob = raw.startsWith("/") ? raw.slice(1) : raw;
  return {
    base: toPosixRel(base),
    raw,
    negate,
    dirOnly,
    locked,
    class: cls,
    re: globToRegExp(glob, anchored && !glob.includes("**")),
  };
}

function loadLines(absFile: string): string[] {
  try {
    return readFileSync(absFile, "utf8").split("\n");
  } catch {
    return [];
  }
}

function addPatterns(
  rules: IgnoreRule[],
  patterns: readonly string[],
  base: string,
  cls: IgnoreRule["class"],
  locked: boolean,
) {
  for (const line of patterns) {
    const rule = parseIgnoreLine(line, base, cls, locked);
    if (rule) rules.push(rule);
  }
}

function walkGitignores(cwd: string, rules: IgnoreRule[]) {
  const stack = [cwd];
  const seen = new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const gi = join(dir, ".gitignore");
    if (existsSync(gi)) {
      const base = toPosixRel(relative(cwd, dir));
      addPatterns(rules, loadLines(gi), base === "" ? "" : base, "junk", false);
    }
    const cz = join(dir, ".chavezignore");
    if (existsSync(cz)) {
      const base = toPosixRel(relative(cwd, dir));
      addPatterns(rules, loadLines(cz), base === "" ? "" : base, "junk", false);
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === "." || ent.name === "..") continue;
      if ((HARNESS_JUNK_DIR_NAMES as readonly string[]).includes(ent.name)) {
        continue;
      }
      stack.push(join(dir, ent.name));
    }
  }
}

export function loadIgnore(cwd: string): IgnoreSet {
  const cwdReal = cwd;
  const rules: IgnoreRule[] = [];
  for (const name of HARNESS_JUNK_DIR_NAMES) {
    addPatterns(rules, [name, `${name}/`, `**/${name}`, `**/${name}/`], "", "junk", true);
  }
  addPatterns(rules, HARNESS_SECRET_PATTERNS, "", "secret", true);
  addPatterns(
    rules,
    [VAULT_DIR_NAME, `${VAULT_DIR_NAME}/`, `**/${VAULT_DIR_NAME}`, `**/${VAULT_DIR_NAME}/`],
    "",
    "vault",
    true,
  );
  const exclude = join(cwdReal, ".git", "info", "exclude");
  if (existsSync(exclude)) {
    addPatterns(rules, loadLines(exclude), "", "junk", false);
  }
  walkGitignores(cwdReal, rules);
  return {
    cwd: cwdReal,
    vaultRoot: join(homedir(), VAULT_DIR_NAME),
    rules,
  };
}

function pathUnder(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relUnderBase(rel: string, base: string): string | null {
  if (!base) return rel;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (rel === base) return "";
  if (!rel.startsWith(prefix)) return null;
  return rel.slice(prefix.length);
}

type Hit = { negate: boolean; class: IgnoreRule["class"]; locked: boolean };

function ruleMatches(rule: IgnoreRule, posix: string, isDir: boolean): boolean {
  const local = relUnderBase(posix, rule.base);
  if (local == null) return false;
  const candidate = local;
  if (
    rule.dirOnly &&
    !isDir &&
    !candidate.includes("/") &&
    posix ===
      (rule.base
        ? `${rule.base}/${rule.raw.replace(/\/$/, "")}`
        : rule.raw.replace(/\/$/, ""))
  ) {
    return false;
  }
  if (!rule.re.test(candidate) && !rule.re.test(posix)) return false;
  if (
    rule.dirOnly &&
    !isDir &&
    candidate === rule.raw.replace(/\/$/, "") &&
    !posix.startsWith(
      (rule.base ? `${rule.base}/` : "") + rule.raw.replace(/\/$/, "") + "/",
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Last matching rule wins (gitignore), except a later non-locked `!`
 * cannot undo a locked secret/vault/junk harness hit.
 */
function lastHit(set: IgnoreSet, rel: string, isDir: boolean): Hit | null {
  const posix = toPosixRel(rel);
  let hit: Hit | null = null;
  let lockedIgnore: Hit | null = null;
  for (const rule of set.rules) {
    if (!ruleMatches(rule, posix, isDir)) continue;
    const thisHit: Hit = {
      negate: rule.negate,
      class: rule.class,
      locked: rule.locked,
    };
    if (!rule.negate && rule.locked) {
      lockedIgnore = thisHit;
    }
    if (
      rule.negate &&
      !rule.locked &&
      lockedIgnore &&
      (lockedIgnore.class === "secret" ||
        lockedIgnore.class === "vault" ||
        lockedIgnore.class === "junk")
    ) {
      continue;
    }
    if (rule.negate && rule.locked && rule.class === "secret") {
      hit = thisHit;
      if (lockedIgnore?.class === "secret") lockedIgnore = null;
      continue;
    }
    hit = thisHit;
  }
  return hit;
}

export type ClassifyOpts = {
  isDir?: boolean;
  size?: number;
  absPath?: string;
  binary?: boolean;
};

/**
 * Walk prefixes so ignoring `node_modules` also ignores `node_modules/pkg/index.js`.
 * Locked secret/vault hits cannot be undone by a later gitignore negation.
 */
export function classifyPath(
  set: IgnoreSet,
  relPath: string,
  opts: ClassifyOpts = {},
): IgnoreClass {
  const posix = toPosixRel(relPath);
  if (!posix || posix === ".") {
    if (opts.absPath && pathUnder(set.vaultRoot, opts.absPath)) return "vault";
    return "none";
  }
  if (opts.absPath && pathUnder(set.vaultRoot, opts.absPath)) return "vault";

  const parts = posix.split("/").filter(Boolean);
  let current: IgnoreClass = "none";
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join("/");
    const isDir = i < parts.length - 1 || Boolean(opts.isDir);
    const hit = lastHit(set, prefix, isDir);
    if (!hit) continue;
    if (hit.negate) {
      if (current === "vault") continue;
      if (current === "secret" && !hit.locked) continue;
      if (hit.locked && hit.class === "secret") {
        current = current === "vault" ? "vault" : "none";
        continue;
      }
      if (current === "junk" && hit.locked) continue;
      current = "none";
      continue;
    }
    if (hit.class === "vault") current = "vault";
    else if (hit.class === "secret" && current !== "vault") current = "secret";
    else if (hit.class === "junk" && current === "none") current = "junk";
  }

  if (current === "none" && !opts.isDir) {
    const size = opts.size ?? 0;
    if (size >= HUGE_FILE_BYTES) return "huge";
    if (opts.binary && size >= HUGE_BINARY_BYTES) return "huge";
  }
  return current;
}

export function isIgnored(
  set: IgnoreSet,
  relPath: string,
  opts: ClassifyOpts = {},
): boolean {
  return classifyPath(set, relPath, opts) !== "none";
}

export function shouldDescend(set: IgnoreSet, relDir: string, absPath?: string): boolean {
  const cls = classifyPath(set, relDir, { isDir: true, absPath });
  return cls === "none";
}

export function classifyAbs(set: IgnoreSet, absPath: string): IgnoreClass {
  let st: { isDirectory(): boolean; size: number } | null = null;
  try {
    st = statSync(absPath);
  } catch {
    st = null;
  }
  const rel = toPosix(relative(set.cwd, absPath));
  if (rel.startsWith("..") || (rel && rel.split(sep)[0] === "..")) {
    return "none";
  }
  return classifyPath(set, rel || ".", {
    isDir: st?.isDirectory() ?? false,
    size: st && !st.isDirectory() ? st.size : undefined,
    absPath,
  });
}
