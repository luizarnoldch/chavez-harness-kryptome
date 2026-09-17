import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS_NOT_LINKED } from "../lib/no-team";
import { credentialsMissingJson } from "./vault-ownership";

const providersSrc = readFileSync(
  join(import.meta.dir, "providers.ts"),
  "utf8",
);

describe("vault is per session user", () => {
  test("missing credentials body", () => {
    expect(credentialsMissingJson()).toEqual({
      error: CREDENTIALS_NOT_LINKED,
    });
  });

  test("providers route does not take a foreign userId", () => {
    expect(providersSrc).toContain("loadOwnedCredential");
    expect(providersSrc).not.toMatch(
      /loadOwnedCredential\(\s*(body|msg|c\.req)\./,
    );
    expect(providersSrc).toContain("session.user.id");
  });
});
