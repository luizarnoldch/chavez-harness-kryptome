export const USER_SKILLS_MAX = 50;
export const USER_SKILL_NAME_MAX = 64;
export const USER_SKILL_DESC_MAX = 200;
export const USER_SKILL_BODY_MAX = 32_000;

export const USER_SKILLS_CAP_ERROR = "Maximum 50 user skills";
export const USER_SKILL_NAME_ERROR =
  "name must be 1–64 chars, kebab-case [a-z0-9-]+";
export const USER_SKILL_DESC_ERROR = "description must be 1–200 characters";
export const USER_SKILL_BODY_ERROR = "body must be 1–32000 characters";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSkillName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 1 &&
    v.length <= USER_SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(v)
  );
}

export type ValidateUserSkillInput = {
  name?: unknown;
  description?: unknown;
  body?: unknown;
  enabled?: unknown;
  existingCount?: number;
};

export type ValidateUserSkillResult =
  | { ok: true; name: string; description: string; body: string; enabled: boolean }
  | { ok: false; error: string };

export function validateUserSkill(
  input: ValidateUserSkillInput,
): ValidateUserSkillResult {
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const body = String(input.body ?? "");
  const enabled = input.enabled !== false;
  if (!isSkillName(name)) return { ok: false, error: USER_SKILL_NAME_ERROR };
  if (!description || description.length > USER_SKILL_DESC_MAX) {
    return { ok: false, error: USER_SKILL_DESC_ERROR };
  }
  if (!body || body.length > USER_SKILL_BODY_MAX) {
    return { ok: false, error: USER_SKILL_BODY_ERROR };
  }
  if (
    typeof input.existingCount === "number" &&
    input.existingCount >= USER_SKILLS_MAX
  ) {
    return { ok: false, error: USER_SKILLS_CAP_ERROR };
  }
  return { ok: true, name, description, body, enabled };
}
