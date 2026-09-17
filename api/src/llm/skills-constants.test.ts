import { describe, expect, test } from "bun:test";
import {
  USER_SKILL_BODY_ERROR,
  USER_SKILL_DESC_ERROR,
  USER_SKILL_NAME_ERROR,
  USER_SKILLS_CAP_ERROR,
  isSkillName,
  validateUserSkill,
} from "./skills-constants";

describe("skills-constants", () => {
  test("reject PDF Tool, accept pdf-extract", () => {
    expect(isSkillName("PDF Tool")).toBe(false);
    expect(isSkillName("pdf-extract")).toBe(true);
  });

  test("empty description → error", () => {
    const r = validateUserSkill({
      name: "ok",
      description: "",
      body: "body",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(USER_SKILL_DESC_ERROR);
  });

  test("empty body → error", () => {
    const r = validateUserSkill({
      name: "ok",
      description: "d",
      body: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(USER_SKILL_BODY_ERROR);
  });

  test("cap 50", () => {
    const r = validateUserSkill({
      name: "ok-skill",
      description: "d",
      body: "body",
      existingCount: 50,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(USER_SKILLS_CAP_ERROR);
  });
});

describe("validateUserSkill routes helper", () => {
  test("ok-skill + desc + body → ok", () => {
    const r = validateUserSkill({
      name: "ok-skill",
      description: "desc",
      body: "body text",
    });
    expect(r.ok).toBe(true);
  });

  test("Bad Name → USER_SKILL_NAME_ERROR", () => {
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
