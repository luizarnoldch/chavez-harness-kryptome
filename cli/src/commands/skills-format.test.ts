import { describe, expect, test } from "bun:test";
import { formatSkillsListLine } from "./skills";

describe("formatSkillsListLine", () => {
  test("formats an enabled skill", () => {
    expect(
      formatSkillsListLine({
        name: "release-notes",
        description: "Write concise release notes",
        enabled: true,
      }),
    ).toBe("on  release-notes  Write concise release notes");
  });

  test("formats a disabled skill", () => {
    expect(
      formatSkillsListLine({
        name: "release-notes",
        description: "Write concise release notes",
        enabled: false,
      }),
    ).toBe("off release-notes  Write concise release notes");
  });
});
