import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN_AUTH_NEEDLES } from "./lib/no-team";

const authSrc = readFileSync(join(import.meta.dir, "auth.ts"), "utf8");

describe("auth freeze: no organization plugin", () => {
  test("does not import or register organization/admin", () => {
    for (const needle of FORBIDDEN_AUTH_NEEDLES) {
      expect(authSrc).not.toContain(needle);
    }
    expect(authSrc).toContain("bearer()");
    expect(authSrc).toContain("magicLink(");
    expect(authSrc).toContain("deviceAuthorization(");
  });

  test("drizzleAdapter schema is user/session/account/verification/deviceCode only", () => {
    const start = authSrc.indexOf("schema: {");
    const end = authSrc.indexOf("}", start);
    const block = authSrc.slice(start, end);
    expect(block).toContain("user:");
    expect(block).toContain("session:");
    expect(block).toContain("deviceCode:");
    expect(block).not.toMatch(/organization|member|invitation|team/i);
  });
});
