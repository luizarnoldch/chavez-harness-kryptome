import { describe, expect, test } from "bun:test";
import {
  USER_SKILL_NAME_ERROR,
  USER_SKILLS_CAP_ERROR,
  validateUserSkill,
} from "../llm/skills-constants";

describe("skills routes validation", () => {
  test("name ok-skill + desc + body → ok", () => {
    const r = validateUserSkill({
      name: "ok-skill",
      description: "A skill",
      body: "Do the thing",
    });
    expect(r.ok).toBe(true);
  });

  test("name Bad Name → USER_SKILL_NAME_ERROR", () => {
    const r = validateUserSkill({
      name: "Bad Name",
      description: "d",
      body: "b",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(USER_SKILL_NAME_ERROR);
  });

  test("51st → USER_SKILLS_CAP_ERROR", () => {
    const r = validateUserSkill({
      name: "ok-skill",
      description: "d",
      body: "b",
      existingCount: 50,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(USER_SKILLS_CAP_ERROR);
  });
});
