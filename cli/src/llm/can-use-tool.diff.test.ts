import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildCanUseTool } from "./can-use-tool";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { TurnDiffCollector } from "./turn-diff-collector";

function tmp(): string {
  return realpathSync(
    mkdirSync(join(tmpdir(), `chavez-cut-${crypto.randomUUID()}`), { recursive: true })!,
  );
}

function originalsSize(c: TurnDiffCollector): number {
  return (c as unknown as { originals: Map<string, unknown> }).originals.size;
}

describe("buildCanUseTool + collector", () => {
  test("Read + auto → originals empty after beforeAllow", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "x\n");
    const collector = new TurnDiffCollector("s", cwd);
    const canUse = buildCanUseTool({ cwd, executionMode: "auto", collector });
    const r = await canUse("Read", { file_path: "a.ts" }, { signal: new AbortController().signal });
    expect(r.behavior).toBe("allow");
    expect(originalsSize(collector)).toBe(0);
  });

  test("Write + auto → originals has the path", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const collector = new TurnDiffCollector("s", cwd);
    const canUse = buildCanUseTool({ cwd, executionMode: "auto", collector });
    const r = await canUse(
      "Write",
      { file_path: "a.ts", content: "new\n" },
      { signal: new AbortController().signal, toolUseID: "t1" },
    );
    expect(r.behavior).toBe("allow");
    expect(originalsSize(collector)).toBe(1);
  });

  test("Write + plan → deny, originals empty (no snapshot)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const collector = new TurnDiffCollector("s", cwd);
    const canUse = buildCanUseTool({ cwd, executionMode: "plan", collector });
    const r = await canUse(
      "Write",
      { file_path: "a.ts", content: "new\n" },
      { signal: new AbortController().signal, toolUseID: "t1" },
    );
    expect(r).toEqual({ behavior: "deny", message: PLAN_MUTATION_DENIED });
    expect(originalsSize(collector)).toBe(0);
  });
});
