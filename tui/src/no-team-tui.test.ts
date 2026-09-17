import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");

describe("TUI has no team surface", () => {
  test("no invite/org copy or keys", () => {
    expect(app).not.toMatch(/invitar|invite teammate|team workspace|miembros del workspace/i);
    expect(app).not.toContain('ch === "I"');
    expect(app).not.toContain("organizationId");
  });
});
