import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHARE_READONLY_BANNER =
  "Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault.";

describe("web share page is not a team workspace", () => {
  test("no org/invite pages", () => {
    const pages = join(import.meta.dir, "../pages");
    for (const rel of [
      "orgs.astro",
      "teams.astro",
      "invite.astro",
      "members.astro",
      "organizations.astro",
    ]) {
      expect(existsSync(join(pages, rel))).toBe(false);
    }
  });

  test("share viewer has no ask and no vault if present", () => {
    const p = join(import.meta.dir, "../pages/s/[token].astro");
    if (!existsSync(p)) return;
    const src = readFileSync(p, "utf8");
    expect(src).toContain(SHARE_READONLY_BANNER);
    expect(src).not.toContain("agent.turn.request");
    expect(src).not.toContain("/providers/");
  });
});
