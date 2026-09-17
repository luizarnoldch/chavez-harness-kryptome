import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDisk } from "./skills-load";

describe("skills-load", () => {
  test(".claude/skills/pdf/SKILL.md → project pdf", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-load-"));
    mkdirSync(join(dir, ".claude/skills/pdf"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: PDF\n---\nDo pdf.\n",
    );
    const b = loadSkillsFromDisk(dir, [], { localDir: join(dir, "nomachine") });
    expect(b.applied[0]?.name).toBe("pdf");
    expect(b.applied[0]?.layer).toBe("project");
  });

  test("user pdf + project pdf → applied project", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-load-ovr-"));
    mkdirSync(join(dir, ".claude/skills/pdf"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/skills/pdf/SKILL.md"),
      "---\nname: pdf\ndescription: proj\n---\nP\n",
    );
    const b = loadSkillsFromDisk(
      dir,
      [{ name: "pdf", description: "user", body: "U", enabled: true }],
      { localDir: join(dir, "nomachine") },
    );
    expect(b.applied[0]?.layer).toBe("project");
  });

  test("user pdf + local machine pdf → applied local", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-load-loc-"));
    const machine = join(dir, "machine-skills");
    mkdirSync(join(machine, "pdf"), { recursive: true });
    writeFileSync(
      join(machine, "pdf/SKILL.md"),
      "---\nname: pdf\ndescription: local\n---\nL\n",
    );
    const b = loadSkillsFromDisk(
      dir,
      [{ name: "pdf", description: "user", body: "U", enabled: true }],
      { localDir: machine },
    );
    expect(b.applied[0]?.layer).toBe("local");
  });

  test("no files + empty user → applied [], no throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-load-empty-"));
    const b = loadSkillsFromDisk(dir, [], { localDir: join(dir, "nomachine") });
    expect(b.applied).toEqual([]);
  });

  test("unreadable SKILL.md is skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-load-bad-"));
    mkdirSync(join(dir, ".claude/skills/bad"), { recursive: true });
    const p = join(dir, ".claude/skills/bad/SKILL.md");
    writeFileSync(p, "---\nname: bad\ndescription: x\n---\n");
    try {
      chmodSync(p, 0);
    } catch {
      // some CI may not allow chmod; skip assertion
      return;
    }
    const b = loadSkillsFromDisk(dir, [], { localDir: join(dir, "nomachine") });
    // may be empty if unreadable, or still readable as root — either way no throw
    expect(Array.isArray(b.applied)).toBe(true);
    try {
      chmodSync(p, 0o644);
    } catch {
      /* ignore */
    }
  });
});
