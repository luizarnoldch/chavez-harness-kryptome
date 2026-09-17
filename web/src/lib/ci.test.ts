import { describe, expect, test } from "bun:test";
import { CI_HUB_HINT } from "./ci";

describe("CI_HUB_HINT", () => {
  test("includes chavez ci --mode auto", () => {
    expect(CI_HUB_HINT).toContain("chavez ci --mode auto");
  });

  test("includes Sin GitHub Action", () => {
    expect(CI_HUB_HINT).toContain("Sin GitHub Action");
  });

  test("does not mention GitHub Action.yml or .github", () => {
    expect(CI_HUB_HINT).not.toContain("GitHub Action.yml");
    expect(CI_HUB_HINT).not.toContain(".github");
  });
});
