import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const headlessSrc = readFileSync(
  join(import.meta.dir, "commands/headless.ts"),
  "utf8",
);
const whoamiSrc = readFileSync(
  join(import.meta.dir, "commands/whoami.ts"),
  "utf8",
);

describe("CLI has no team product", () => {
  test("no org/team/invite commands", () => {
    for (const cmd of ["org", "team", "invite", "members", "organization"]) {
      expect(indexSrc).not.toContain(`case "${cmd}"`);
      expect(indexSrc).not.toContain(`chavez ${cmd}`);
    }
    expect(indexSrc).toContain("chavez login");
    expect(indexSrc).toContain("chavez whoami");
  });

  test("headless has no member router", () => {
    expect(headlessSrc).not.toMatch(/case ["']org["']|case ["']invite["']/);
  });

  test("whoami is a single user", () => {
    expect(whoamiSrc).toContain("me.user.email");
    expect(whoamiSrc).not.toMatch(/organization|orgId|memberRole/);
  });
});
