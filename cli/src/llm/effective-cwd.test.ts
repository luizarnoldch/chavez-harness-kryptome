import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBindPath,
  getEffectiveCwd,
  initEffectiveCwd,
  restoreOrFallback,
  setEffectiveCwd,
} from "./effective-cwd";
import { WORKTREE_MISSING } from "./worktree-constants";

describe("effective-cwd", () => {
  test("init, set, restore without process.chdir", () => {
    const before = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "chavez-ecwd-"));
    initEffectiveCwd(dir);
    expect(getBindPath()).toBe(dir.replace(/\\/g, "/").replace(/\/+$/, "") || dir);
    expect(getEffectiveCwd()).toBe(getBindPath());

    const other = mkdtempSync(join(tmpdir(), "chavez-ecwd-other-"));
    setEffectiveCwd(other);
    expect(getEffectiveCwd()).toBe(other.replace(/\\/g, "/").replace(/\/+$/, "") || other);
    expect(getBindPath()).toBe(dir.replace(/\\/g, "/").replace(/\/+$/, "") || dir);

    const missing = join(dir, "no-such-worktree");
    const restored = restoreOrFallback(missing);
    expect(restored.cwd).toBe(getBindPath());
    expect(restored.message).toBe(WORKTREE_MISSING);
    expect(process.cwd()).toBe(before);
  });
});
