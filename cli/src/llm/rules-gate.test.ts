import { describe, expect, test } from "bun:test";
import { assembleBundle, denyIfRuleDisallowed, type RuleSource } from "./rules-merge";
import { canonicalToolName } from "./tool-names";
import { decideCanUseTool } from "./can-use-tool";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function rule(
  layer: RuleSource["layer"],
  title: string,
  extra: Partial<RuleSource> = {},
): RuleSource {
  return {
    layer,
    title,
    body: extra.body ?? `${title} body`,
    enabled: extra.enabled ?? true,
    disallowTools: extra.disallowTools ?? [],
    allowTools: extra.allowTools ?? [],
    chars: (extra.body ?? `${title} body`).length,
    truncated: false,
    ...extra,
  };
}

describe("denyIfRuleDisallowed + canonical names", () => {
  test("Bash maps to bash and is denied", () => {
    const b = assembleBundle({
      user: [],
      project: [],
      local: [rule("local", "No bash", { disallowTools: ["bash"] })],
      userRulesEnabled: true,
    });
    const d = denyIfRuleDisallowed(b, canonicalToolName("Bash"));
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toMatch(/disallowed/);
    expect(denyIfRuleDisallowed(b, canonicalToolName("Read"))).toBeNull();
  });
});

describe("decideCanUseTool rules vs auto", () => {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-rules-gate-"));
  writeFileSync(join(cwd, "in.txt"), "ok");

  test("auto + local bash-disallow denies Bash", async () => {
    const bundle = assembleBundle({
      user: [],
      project: [],
      local: [rule("local", "No bash", { disallowTools: ["bash"] })],
      userRulesEnabled: true,
    });
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      rulesBundle: bundle,
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message).toMatch(/disallowed/);
    }
  });
});
