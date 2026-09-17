import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("headless daemon never auto-approves", () => {
  test("daemon.ts has no resolveApproval approve of its own", () => {
    const src = readFileSync(
      join(import.meta.dir, "../ws/daemon.ts"),
      "utf8",
    );
    expect(src).toContain("handleToolResolutionPush");
    expect(src).not.toMatch(/resolveApproval\([^)]*["']approve["']/);
    expect(src).not.toMatch(/onAskPermission[\s\S]*return ["']approve["']/);
  });

  test("workspaceOpen ignores stdin so the daemon cannot type y", () => {
    const src = readFileSync(
      join(import.meta.dir, "../commands/headless.ts"),
      "utf8",
    );
    expect(src).toContain('stdin: "ignore"');
  });
});
