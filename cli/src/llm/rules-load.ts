import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { workspaceHash } from "../workspace";
import {
  LOCAL_CWD_RELATIVE,
  PROJECT_ROOT_FILES,
  RULE_PROJECT_FILES_MAX,
} from "./rules-constants";
import { parseRuleFile, toRuleSource } from "./rules-parse";
import type { RuleSource } from "./rules-merge";

function readUtf8IfFile(abs: string): string | null {
  try {
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function listRuleFiles(dirAbs: string, exts: Set<string>): string[] {
  if (!existsSync(dirAbs)) return [];
  let st;
  try {
    st = statSync(dirAbs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let ents: string[] = [];
    try {
      ents = readdirSync(d);
    } catch {
      return;
    }
    for (const name of ents) {
      if (name.startsWith(".") && name !== ".") continue;
      const p = join(d, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) {
        const lower = name.toLowerCase();
        const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
        if (exts.has(ext)) out.push(p);
      }
    }
  };
  walk(dirAbs);
  return out.sort();
}

function relPosix(cwd: string, abs: string): string {
  return relative(cwd, abs).split(sep).join("/");
}

export function localMachineRulesPath(cwd: string): string {
  return join(
    homedir(),
    ".chavez",
    "workspaces",
    workspaceHash(cwd),
    "rules.local.md",
  );
}

export function loadProjectRules(cwd: string): RuleSource[] {
  const out: RuleSource[] = [];
  const seen = new Set<string>();
  const add = (abs: string, rel: string) => {
    if (seen.has(rel)) return;
    const raw = readUtf8IfFile(abs);
    if (raw == null) return;
    seen.add(rel);
    const parsed = parseRuleFile(raw, rel);
    out.push(
      toRuleSource("project", parsed, { id: `project:${rel}`, path: rel }),
    );
  };

  for (const rel of PROJECT_ROOT_FILES) {
    add(join(cwd, rel), rel);
  }
  const extraDirs = [
    join(cwd, ".claude", "rules"),
    join(cwd, ".cursor", "rules"),
  ];
  for (const dir of extraDirs) {
    const files = listRuleFiles(dir, new Set([".md", ".mdc"]));
    for (const abs of files) {
      if (out.length >= RULE_PROJECT_FILES_MAX) break;
      add(abs, relPosix(cwd, abs));
    }
  }
  return out.slice(0, RULE_PROJECT_FILES_MAX);
}

export function loadLocalRules(cwd: string): RuleSource[] {
  const out: RuleSource[] = [];
  for (const rel of LOCAL_CWD_RELATIVE) {
    const raw = readUtf8IfFile(join(cwd, rel));
    if (raw == null) continue;
    const parsed = parseRuleFile(raw, rel);
    out.push(toRuleSource("local", parsed, { id: `local:${rel}`, path: rel }));
  }
  const machine = localMachineRulesPath(cwd);
  const rawM = readUtf8IfFile(machine);
  if (rawM != null) {
    const rel = `~/.chavez/workspaces/${workspaceHash(cwd)}/rules.local.md`;
    const parsed = parseRuleFile(rawM, rel);
    out.push(
      toRuleSource("local", parsed, { id: "local:machine", path: rel }),
    );
  }
  return out;
}

export function writeLocalMachineRules(cwd: string, content: string): string {
  const abs = localMachineRulesPath(cwd);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, { encoding: "utf8", mode: 0o600 });
  return abs;
}
