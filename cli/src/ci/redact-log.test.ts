import { describe, expect, test } from "bun:test";
import { REDACT_REPLACEMENT, collectCiSecrets, redactCiLog } from "./redact-log";

describe("redactCiLog", () => {
  test("redacta sk-ant-*", () => {
    const out = redactCiLog("sk-ant-api03-aaaa");
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain(REDACT_REPLACEMENT);
  });

  test("redacta Bearer tokens", () => {
    const out = redactCiLog("Authorization: Bearer abcdefghijklmnop");
    expect(out).not.toContain("abcdefghijklmnop");
  });

  test("redacta ghp_*", () => {
    const out = redactCiLog("token ghp_secretsecretsecret");
    expect(out).not.toContain("ghp_");
  });

  test("deja texto inocuo intacto", () => {
    expect(redactCiLog("hello src/auth.ts")).toBe("hello src/auth.ts");
  });

  test("redacta extras explícitos", () => {
    const secret = "tok_12345678";
    const out = redactCiLog(`leak ${secret}`, [secret]);
    expect(out).not.toContain(secret);
  });

  test("collectCiSecrets + redactCiLog borran env tokens", () => {
    const secret = "tok_12345678";
    const extras = collectCiSecrets({ CHAVEZ_ACCESS_TOKEN: secret });
    expect(extras).toContain(secret);
    const out = redactCiLog(`token ${secret}`, extras);
    expect(out).not.toContain(secret);
  });

  test("redacta ciphertext/oauth_token en extras", () => {
    const oauth = "a".repeat(40);
    const out = redactCiLog(`oauth_token=${oauth}`, [oauth]);
    expect(out).not.toContain(oauth);
  });
});
