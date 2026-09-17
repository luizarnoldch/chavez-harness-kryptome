import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const layout = readFileSync(
  join(import.meta.dir, "layouts/BaseLayout.astro"),
  "utf8",
);
const hooks = readFileSync(join(import.meta.dir, "lib/hooks.ts"), "utf8");
const nav = readFileSync(
  join(import.meta.dir, "components/NavAuth.tsx"),
  "utf8",
);

describe("web has no team product", () => {
  test("nav has no org links", () => {
    expect(layout).toContain('href="/workspaces"');
    expect(layout).toContain('href="/providers"');
    expect(layout).not.toContain('href="/orgs"');
    expect(layout).not.toContain('href="/teams"');
    expect(layout).not.toContain('href="/invite"');
    expect(layout).not.toContain('href="/members"');
  });

  test("MeUser is a person not a member", () => {
    const block = hooks.slice(
      hooks.indexOf("export type MeUser"),
      hooks.indexOf("export type EffortLevel"),
    );
    expect(block).toContain("id: string");
    expect(block).toContain("email: string");
    expect(block).not.toMatch(/\brole\b|\borgId\b|\borganization\b/);
    expect(nav).toContain("me.data.email");
    expect(nav).not.toMatch(/org|invite/i);
  });

  test("forbidden pages absent", () => {
    const pages = join(import.meta.dir, "pages");
    expect(existsSync(join(pages, "orgs.astro"))).toBe(false);
    expect(existsSync(join(pages, "teams.astro"))).toBe(false);
    expect(existsSync(join(pages, "invite.astro"))).toBe(false);
    expect(existsSync(join(pages, "members.astro"))).toBe(false);
  });
});
