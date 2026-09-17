import { describe, expect, test } from "bun:test";
import { formatSkillsPrompt, mergeSkillLayers } from "./skills-merge";
import { SKILLS_PREAMBLE, type SkillSource } from "./skills-constants";

function skill(
  partial: Partial<SkillSource> & Pick<SkillSource, "name" | "layer">,
): SkillSource {
  return {
    description: partial.description ?? partial.name,
    body: partial.body ?? "body",
    enabled: partial.enabled ?? true,
    chars: partial.chars ?? 4,
    truncated: partial.truncated ?? false,
    path: partial.path,
    name: partial.name,
    layer: partial.layer,
  };
}

describe("skills-merge", () => {
  test("same name user+project → applied is project", () => {
    const b = mergeSkillLayers({
      user: [skill({ name: "pdf", layer: "user" })],
      project: [skill({ name: "pdf", layer: "project", body: "proj" })],
      local: [],
    });
    expect(b.applied).toHaveLength(1);
    expect(b.applied[0]!.layer).toBe("project");
  });

  test("same name in three layers → applied is local", () => {
    const b = mergeSkillLayers({
      user: [skill({ name: "pdf", layer: "user" })],
      project: [skill({ name: "pdf", layer: "project" })],
      local: [skill({ name: "pdf", layer: "local" })],
    });
    expect(b.applied[0]!.layer).toBe("local");
  });

  test("enabled: false user does not appear if project lacks it", () => {
    const b = mergeSkillLayers({
      user: [skill({ name: "pdf", layer: "user", enabled: false })],
      project: [],
      local: [],
    });
    expect(b.applied).toEqual([]);
    expect(b.user).toEqual([]);
  });

  test("formatSkillsPrompt includes preamble and names; empty → \"\"", () => {
    expect(
      formatSkillsPrompt(mergeSkillLayers({ user: [], project: [], local: [] })),
    ).toBe("");
    const prompt = formatSkillsPrompt(
      mergeSkillLayers({
        user: [],
        project: [skill({ name: "pdf", layer: "project" })],
        local: [],
      }),
    );
    expect(prompt).toContain(SKILLS_PREAMBLE);
    expect(prompt).toContain("pdf");
  });
});
