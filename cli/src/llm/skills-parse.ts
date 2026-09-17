import {
  SKILL_BODY_MAX_CHARS,
  USER_SKILL_DESC_MAX,
  isSkillName,
  type SkillLayer,
  type SkillSource,
} from "./skills-constants";
import { parseFrontmatter } from "./rules-parse";

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  truncated: boolean;
};

export function parseSkillMd(
  raw: string,
  fallbackName: string,
  layer: SkillLayer,
  path?: string,
): SkillSource | null {
  const { attrs, body: rest } = parseFrontmatter(raw);
  const nameAttr = attrs.name != null ? String(attrs.name) : "";
  const name = isSkillName(nameAttr)
    ? nameAttr
    : isSkillName(fallbackName)
      ? fallbackName
      : null;
  if (!name) return null;
  const descRaw =
    attrs.description != null ? String(attrs.description) : name;
  const description = descRaw.slice(0, USER_SKILL_DESC_MAX);
  const truncated = rest.length > SKILL_BODY_MAX_CHARS;
  const body = rest.slice(0, SKILL_BODY_MAX_CHARS);
  const enabledStr =
    attrs.enabled != null ? String(attrs.enabled) : undefined;
  return {
    layer,
    name,
    description,
    body,
    path,
    enabled: enabledStr === "false" ? false : true,
    chars: body.length,
    truncated,
  };
}

export function userSkillToSource(row: {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}): SkillSource {
  const truncated = row.body.length > SKILL_BODY_MAX_CHARS;
  return {
    layer: "user",
    name: row.name,
    description: row.description,
    body: row.body.slice(0, SKILL_BODY_MAX_CHARS),
    enabled: row.enabled,
    chars: Math.min(row.body.length, SKILL_BODY_MAX_CHARS),
    truncated,
  };
}
