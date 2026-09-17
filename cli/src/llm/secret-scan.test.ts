import { describe, expect, test } from "bun:test";
import { redactByClass, stripVaultLines } from "./secret-scan";

describe("redactByClass", () => {
  test("vault is fully stars", () => {
    expect(redactByClass('{"accessToken":"abc"}', "vault")).toBe("***");
  });
  test("secret dotenv", () => {
    expect(redactByClass("AWS_SECRET_ACCESS_KEY=wxyz\n", "secret")).toContain("=***");
  });
});

describe("stripVaultLines", () => {
  test("drops config.json hits", () => {
    const out = stripVaultLines("a\n~/.chavez/config.json\nb");
    expect(out).not.toContain("config.json");
    expect(out).toContain("a");
  });
});
