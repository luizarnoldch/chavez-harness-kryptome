export const SKILL_LAYERS = ["user", "project", "local"] as const;
export type SkillLayer = (typeof SKILL_LAYERS)[number];

export const USER_SKILLS_MAX = 50;
export const USER_SKILL_NAME_MAX = 64;
export const USER_SKILL_DESC_MAX = 200;
export const USER_SKILL_BODY_MAX = 32_000;
export const SKILL_BODY_MAX_CHARS = 32_000;
export const SKILL_PREVIEW_CHARS = 2_000;
export const SKILLS_PROMPT_MAX_CHARS = 40_000;
export const SKILL_PROJECT_MAX = 40;

export const USER_SKILLS_CAP_ERROR = "Maximum 50 user skills";
export const USER_SKILL_NAME_ERROR =
  "name must be 1–64 chars, kebab-case [a-z0-9-]+";
export const USER_SKILL_DESC_ERROR = "description must be 1–200 characters";
export const USER_SKILL_BODY_ERROR = "body must be 1–32000 characters";
export const NO_SKILLS_LABEL = "0 skills";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PROJECT_SKILL_GLOBS = [
  ".claude/skills/*/SKILL.md",
  ".cursor/skills/*/SKILL.md",
  ".chavez/skills/*/SKILL.md",
] as const;

export const LOCAL_SKILL_GLOBS = [".chavez/skills.local/*/SKILL.md"] as const;

export const LOCAL_MACHINE_SKILLS_DIR = "skills"; // under ~/.chavez/workspaces/<hash>/

export const SKILLS_PREAMBLE =
  "Chavez skills are in effect. Three layers apply: user, project, local. If the same skill name exists in more than one layer, local overrides project, and project overrides user. Load a skill with the skill tool before following its instructions. Do not invent a skill that is not listed.";

export type SkillSource = {
  layer: SkillLayer;
  name: string;
  description: string;
  body: string;
  path?: string;
  enabled: boolean;
  chars: number;
  truncated: boolean;
};

export type SkillRef = Omit<SkillSource, "body">;

export type SkillsBundle = {
  user: SkillSource[];
  project: SkillSource[];
  local: SkillSource[];
  /** After same-name merge: local > project > user. */
  applied: SkillSource[];
};

export type SkillsMetadata = {
  counts: { user: number; project: number; local: number; total: number };
  applied: SkillRef[];
  activated: string[];
};

export type SkillsSnapshot = {
  counts: SkillsMetadata["counts"];
  applied: SkillRef[];
};

export function isSkillName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 1 &&
    v.length <= USER_SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(v)
  );
}
