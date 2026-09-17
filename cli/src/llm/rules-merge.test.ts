import { describe, expect, test } from "bun:test";
import {
  assembleBundle,
  denyIfRuleDisallowed,
  formatRulesPrompt,
  mergeDisallowedTools,
  rulesMetadata,
  rulesWatchLine,
  type RuleSource,
} from "./rules-merge";
import { RULES_PREAMBLE } from "./rules-constants";

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

describe("mergeDisallowedTools", () => {
  test("local allow undoes user disallow (explicit conflict)", () => {
    const user = [rule("user", "u", { disallowTools: ["bash"] })];
    const local = [rule("local", "l", { allowTools: ["bash"] })];
    expect(mergeDisallowedTools(user, [], local)).toEqual([]);
  });

  test("local disallow wins over user allow", () => {
    const user = [rule("user", "u", { allowTools: ["bash"] })];
    const local = [rule("local", "l", { disallowTools: ["bash"] })];
    expect(mergeDisallowedTools(user, [], local)).toEqual(["bash"]);
  });

  test("project disallow stays if local silent", () => {
    const project = [rule("project", "p", { disallowTools: ["write"] })];
    expect(mergeDisallowedTools([], project, [])).toEqual(["write"]);
  });
});

describe("assembleBundle", () => {
  test("userRulesEnabled false drops user layer", () => {
    const b = assembleBundle({
      user: [rule("user", "español", { body: "responde en español" })],
      project: [rule("project", "AGENTS.md", { path: "AGENTS.md" })],
      local: [],
      userRulesEnabled: false,
    });
    expect(b.user).toHaveLength(0);
    expect(b.project).toHaveLength(1);
  });

  test("disabled rule dropped", () => {
    const b = assembleBundle({
      user: [rule("user", "off", { enabled: false })],
      project: [],
      local: [],
      userRulesEnabled: true,
    });
    expect(b.user).toHaveLength(0);
  });

  test("verifyCommand local overrides project", () => {
    const b = assembleBundle({
      user: [],
      project: [
        rule("project", "AGENTS", { verifyCommand: "npm test", body: "" }),
      ],
      local: [
        rule("local", "local verify", { verifyCommand: "bun test", body: "" }),
      ],
      userRulesEnabled: true,
    });
    expect(b.verifyCommand).toBe("bun test");
  });

  test("verify-only rule kept by enabledOnly", () => {
    const b = assembleBundle({
      user: [],
      project: [],
      local: [
        rule("local", "verify only", {
          body: "",
          verifyCommand: "bun test",
        }),
      ],
      userRulesEnabled: true,
    });
    expect(b.local).toHaveLength(1);
    expect(b.verifyCommand).toBe("bun test");
  });
});

describe("formatRulesPrompt", () => {
  test("undefined when nothing", () => {
    expect(
      formatRulesPrompt(
        assembleBundle({
          user: [],
          project: [],
          local: [],
          userRulesEnabled: true,
        }),
      ),
    ).toBeUndefined();
  });

  test("includes all three layers and preamble", () => {
    const text = formatRulesPrompt(
      assembleBundle({
        user: [rule("user", "español", { body: "responde en español" })],
        project: [rule("project", "AGENTS.md", { path: "AGENTS.md", body: "use bun" })],
        local: [
          rule("local", "No bash", {
            path: "CHAVEZ.local.md",
            body: "no uses bash",
            disallowTools: ["bash"],
          }),
        ],
        userRulesEnabled: true,
      }),
    );
    expect(text).toContain(RULES_PREAMBLE);
    expect(text).toContain("responde en español");
    expect(text).toContain("use bun");
    expect(text).toContain("no uses bash");
    expect(text).toContain("disallowed tools = bash");
  });

  test("includes verify line when bundle has verifyCommand", () => {
    const text = formatRulesPrompt(
      assembleBundle({
        user: [],
        project: [
          rule("project", "AGENTS", {
            body: "use bun",
            verifyCommand: "bun test",
          }),
        ],
        local: [],
        userRulesEnabled: true,
      }),
    );
    expect(text).toContain(
      "Workspace verification command (use this exact command after edits; do not invent another): `bun test`",
    );
  });
});

describe("denyIfRuleDisallowed", () => {
  test("auto-equivalent: bash denied by local", () => {
    const b = assembleBundle({
      user: [],
      project: [],
      local: [
        rule("local", "No bash", { disallowTools: ["bash"] }),
      ],
      userRulesEnabled: true,
    });
    const d = denyIfRuleDisallowed(b, "bash");
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toContain("No bash");
    expect(d?.message).toContain("bash");
    expect(denyIfRuleDisallowed(b, "read")).toBeNull();
  });
});

describe("rulesMetadata", () => {
  test("titles without bodies", () => {
    const b = assembleBundle({
      user: [rule("user", "español", { body: "x".repeat(5000) })],
      project: [],
      local: [],
      userRulesEnabled: true,
    });
    const meta = rulesMetadata(b);
    expect(meta.counts).toEqual({
      user: 1,
      project: 0,
      local: 0,
      total: 1,
    });
    expect(meta.applied[0]).not.toHaveProperty("body");
    expect(meta.applied[0]!.title).toBe("español");
    expect(rulesWatchLine(meta)).toBe(
      "rules: 1 (user=1 project=0 local=0)",
    );
  });
});
