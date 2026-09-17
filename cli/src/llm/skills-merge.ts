import {
  SKILLS_PREAMBLE,
  SKILLS_PROMPT_MAX_CHARS,
  type SkillRef,
  type SkillSource,
  type SkillsBundle,
  type SkillsMetadata,
} from "./skills-constants";

export function mergeSkillLayers(input: {
  user: SkillSource[];
  project: SkillSource[];
  local: SkillSource[];
}): SkillsBundle {
  const enabled = (xs: SkillSource[]) => xs.filter((s) => s.enabled);
  const user = enabled(input.user);
  const project = enabled(input.project);
  const local = enabled(input.local);
  const byName = new Map<string, SkillSource>();
  for (const s of user) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);
  return { user, project, local, applied: [...byName.values()] };
}

export function skillsMetadata(
  bundle: SkillsBundle,
  activated: string[] = [],
): SkillsMetadata {
  const ref = (s: SkillSource): SkillRef => {
    const { body: _b, ...rest } = s;
    return rest;
  };
  return {
    counts: {
      user: bundle.user.length,
      project: bundle.project.length,
      local: bundle.local.length,
      total: bundle.applied.length,
    },
    applied: bundle.applied.map(ref),
    activated,
  };
}

export function formatSkillsPrompt(bundle: SkillsBundle): string {
  if (bundle.applied.length === 0) return "";
  const lines = [SKILLS_PREAMBLE, "", "Available skills:"];
  for (const s of bundle.applied) {
    lines.push(`- ${s.name} (${s.layer}): ${s.description}`);
  }
  lines.push("", "Call tool skill with { name } to load the full instructions.");
  let out = lines.join("\n");
  if (out.length > SKILLS_PROMPT_MAX_CHARS) {
    out = out.slice(0, SKILLS_PROMPT_MAX_CHARS) + "\n…[truncated]";
  }
  return out;
}
