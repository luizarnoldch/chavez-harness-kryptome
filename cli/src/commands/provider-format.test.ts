import { describe, expect, test } from "bun:test";
import { assertNoSecret, formatProviderList } from "./provider-format";

const SECRET = "key_super_secret_do_not_print";

describe("formatProviderList", () => {
  test("shows linked runnable cursor with 2 models and no secret", () => {
    const out = formatProviderList({
      activeProvider: "cursor",
      activeModel: "composer-2.5",
      activeEffort: null,
      activeParams: [{ id: "optimize_for", value: "balanced" }],
      providers: {
        claude: { linked: false },
        cursor: {
          linked: true,
          authKind: "api_key",
          runnable: true,
          models: [{ id: "composer-2.5" }, { id: "auto-smart" }],
        },
      },
    });
    expect(out).toContain("Active: cursor / composer-2.5");
    expect(out).toContain("params=optimize_for=balanced");
    expect(out).toContain("- cursor: linked (api_key) runnable models=2");
    expect(out).toContain("- claude: not linked");
    assertNoSecret(out, SECRET);
    expect(out.includes(SECRET)).toBe(false);
  });

  test("shows catalogError and not-runnable when discovery failed", () => {
    const out = formatProviderList({
      activeProvider: "cursor",
      activeModel: null,
      providers: {
        cursor: {
          linked: true,
          authKind: "api_key",
          runnable: false,
          catalogError: "Invalid API key",
          models: [],
        },
      },
    });
    expect(out).toContain("not-runnable");
    expect(out).toContain("catalogError=Invalid API key");
    expect(out).toContain("models=0");
    assertNoSecret(out, SECRET);
  });

  test("assertNoSecret throws when the key is present", () => {
    expect(() => assertNoSecret(`linked ${SECRET}`, SECRET)).toThrow(
      "secret leaked",
    );
  });
});
