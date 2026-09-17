import { describe, expect, test } from "bun:test";
import { parseSkillMd } from "./skills-parse";

describe("skills-parse", () => {
  test("frontmatter name: pdf + body → name pdf", () => {
    const s = parseSkillMd(
      "---\nname: pdf\ndescription: PDF tools\n---\nDo PDF stuff.\n",
      "other",
      "project",
    );
    expect(s?.name).toBe("pdf");
    expect(s?.body).toContain("Do PDF stuff");
  });

  test("invalid name PDF Tool + fallback pdf → pdf", () => {
    const s = parseSkillMd(
      "---\nname: PDF Tool\ndescription: x\n---\nBody\n",
      "pdf",
      "project",
    );
    expect(s?.name).toBe("pdf");
  });

  test("body > 32000 → truncated true", () => {
    const body = "x".repeat(32_001);
    const s = parseSkillMd(
      `---\nname: big\ndescription: big\n---\n${body}`,
      "big",
      "user",
    );
    expect(s?.truncated).toBe(true);
    expect(s?.body.length).toBe(32_000);
  });

  test("enabled: false → enabled false", () => {
    const s = parseSkillMd(
      "---\nname: off\ndescription: d\nenabled: false\n---\nBody\n",
      "off",
      "local",
    );
    expect(s?.enabled).toBe(false);
  });
});
