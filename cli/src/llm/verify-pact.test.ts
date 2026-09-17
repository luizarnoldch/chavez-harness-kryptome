import { describe, expect, test } from "bun:test";
import {
  extractVerifyCommandFromText,
  pactCommandFromRules,
} from "./verify-pact";

describe("extractVerifyCommandFromText", () => {
  test("frontmatter verify", () => {
    const raw = `---
verify: bun test
---
# AGENTS
`;
    expect(extractVerifyCommandFromText(raw)).toBe("bun test");
  });

  test("body Verification line", () => {
    expect(
      extractVerifyCommandFromText("# Rules\n\nVerification: npm test\n"),
    ).toBe("npm test");
  });

  test("empty → null, never npm test by default", () => {
    expect(extractVerifyCommandFromText("# hello\n\nBe kind.\n")).toBeNull();
  });

  test("AGENTS.md with verify: npm test is the pact", () => {
    expect(
      extractVerifyCommandFromText(`---
verify: npm test
---
# AGENTS
`),
    ).toBe("npm test");
  });

  test("no invent when AGENTS has no verify", () => {
    expect(extractVerifyCommandFromText("# AGENTS\n\nUse bun.\n")).toBeNull();
  });
});

describe("pactCommandFromRules", () => {
  test("local overrides project", () => {
    expect(
      pactCommandFromRules([
        { layer: "project", body: "Verification: npm test" },
        { layer: "local", body: "verify: bun test" },
      ]),
    ).toBe("bun test");
  });

  test("no rules → null (do not invent)", () => {
    expect(pactCommandFromRules([])).toBeNull();
    expect(
      pactCommandFromRules([{ layer: "project", body: "no tests here" }]),
    ).toBeNull();
  });

  test("disabled skipped", () => {
    expect(
      pactCommandFromRules([
        { layer: "user", body: "verify: npm test", enabled: false },
      ]),
    ).toBeNull();
  });
});
