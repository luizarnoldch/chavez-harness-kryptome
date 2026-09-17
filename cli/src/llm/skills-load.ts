import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { workspaceHash } from "../workspace";
import {
  PROJECT_SKILL_GLOBS,
  LOCAL_SKILL_GLOBS,
  LOCAL_MACHINE_SKILLS_DIR,
  SKILL_PROJECT_MAX,
  type SkillSource,
  type SkillsBundle,
} from "./skills-constants";
import { parseSkillMd, userSkillToSource } from "./skills-parse";
import { mergeSkillLayers } from "./skills-merge";

function expandSkillGlob(cwd: string, glob: string): string[] {
  // Only patterns like "<dir>/*/SKILL.md"
  const parts = glob.split("/");
  const root = join(cwd, ...parts.slice(0, -2)); // drop */SKILL.md
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: string[] = [];
  for (const ent of readdirSync(root)) {
    const skillMd = join(root, ent, "SKILL.md");
    if (existsSync(skillMd) && statSync(skillMd).isFile()) out.push(skillMd);
  }
  return out;
}

function loadFromGlobs(
  cwd: string,
  globs: readonly string[],
  layer: "project" | "local",
  cap: number,
): SkillSource[] {
  const files: string[] = [];
  for (const g of globs) files.push(...expandSkillGlob(cwd, g));
  const out: SkillSource[] = [];
  for (const abs of files.slice(0, cap)) {
    let raw = "";
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const fallback = basename(dirname(abs));
    const rel = abs.startsWith(cwd)
      ? abs.slice(cwd.length).replace(/^\//, "")
      : abs;
    const parsed = parseSkillMd(raw, fallback, layer, rel);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function loadSkillsFromDisk(
  cwd: string,
  userRows: Array<{
    name: string;
    description: string;
    body: string;
    enabled: boolean;
  }>,
  opts?: { localDir?: string },
): SkillsBundle {
  const project = loadFromGlobs(
    cwd,
    PROJECT_SKILL_GLOBS,
    "project",
    SKILL_PROJECT_MAX,
  );
  const localCwd = loadFromGlobs(
    cwd,
    LOCAL_SKILL_GLOBS,
    "local",
    SKILL_PROJECT_MAX,
  );
  const machineDir =
    opts?.localDir ??
    join(
      homedir(),
      ".chavez",
      "workspaces",
      workspaceHash(cwd),
      LOCAL_MACHINE_SKILLS_DIR,
    );
  const localFromMachine: SkillSource[] = [];
  if (existsSync(machineDir) && statSync(machineDir).isDirectory()) {
    for (const ent of readdirSync(machineDir).slice(0, SKILL_PROJECT_MAX)) {
      const skillMd = join(machineDir, ent, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      try {
        const parsed = parseSkillMd(
          readFileSync(skillMd, "utf8"),
          ent,
          "local",
          `~/.chavez/workspaces/${workspaceHash(cwd)}/skills/${ent}/SKILL.md`,
        );
        if (parsed) localFromMachine.push(parsed);
      } catch {
        // skip unreadable skill; do not fail the turn
      }
    }
  }
  const user = userRows.map(userSkillToSource);
  return mergeSkillLayers({
    user,
    project,
    local: [...localCwd, ...localFromMachine],
  });
}
