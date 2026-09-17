import { describe, expect, test } from "bun:test";
import { parseFrontmatter, parseRuleFile, titleFromBodyOrPath } from "./rules-parse";

describe("parseFrontmatter", () => {
  test("no fence returns whole body", () => {
    const r = parseFrontmatter("hola\n");
    expect(r.attrs).toEqual({});
    expect(r.body).toBe("hola\n");
  });

  test("extracts disallowTools list and title", () => {
    const raw = `---
title: No bash
disallowTools: [bash]
alwaysApply: true
---
No uses bash en este workspace.
`;
    const parsed = parseRuleFile(raw, "CHAVEZ.local.md");
    expect(parsed.title).toBe("No bash");
    expect(parsed.disallowTools).toEqual(["bash"]);
    expect(parsed.body).toContain("No uses bash");
    expect(parsed.truncated).toBe(false);
  });

  test("mdc globs list", () => {
    const raw = `---
globs:
  - src/**/*.ts
alwaysApply: false
---
# RPC style
use bun
`;
    const parsed = parseRuleFile(raw, ".cursor/rules/rpc.mdc");
    expect(parsed.globs).toEqual(["src/**/*.ts"]);
    expect(parsed.alwaysApply).toBe(false);
    expect(parsed.title).toBe("RPC style");
  });

  test("heading fallback when no fm title", () => {
    expect(titleFromBodyOrPath("# Hola mundo\n\nbody", "AGENTS.md")).toBe(
      "Hola mundo",
    );
  });

  test("invalid disallowTools ignored (empty, not throw)", () => {
    const parsed = parseRuleFile(
      "---\ndisallowTools: [laser]\n---\nbody\n",
      "x.md",
    );
    expect(parsed.disallowTools).toEqual([]);
  });
});
