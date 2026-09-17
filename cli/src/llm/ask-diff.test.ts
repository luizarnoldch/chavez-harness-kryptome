import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDiffCollector, toUpsertPayload } from "./turn-diff-collector";

describe("ask proposed vs applied", () => {
  test("approve path: proposed then disk change then applied", async () => {
    const cwd = realpathSync(
      mkdirSync(join(tmpdir(), `chavez-ask-${crypto.randomUUID()}`), { recursive: true })!,
    );
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const c = new TurnDiffCollector("s", cwd);
    const proposed = c.propose("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    expect(proposed?.status).toBe("proposed");
    expect(toUpsertPayload(proposed!).preview).toContain("-old");
    expect(toUpsertPayload(proposed!).preview).toContain("+new");
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("old\n");
    await c.beforeAllow("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    writeFileSync(join(cwd, "a.ts"), "new\n");
    await c.afterTool("Write", { file_path: "a.ts" }, "done");
    const applied = await c.finalize();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.status).toBe("applied");
    expect(applied[0]!.kind).toBe("modified");
  });

  test("deny path: disk unchanged and no applied", async () => {
    const cwd = realpathSync(
      mkdirSync(join(tmpdir(), `chavez-deny-${crypto.randomUUID()}`), { recursive: true })!,
    );
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const c = new TurnDiffCollector("s", cwd);
    c.propose("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    const dropped = c.dropProposed("t1");
    expect(dropped).toEqual(["a.ts"]);
    const applied = await c.finalize();
    expect(applied).toHaveLength(0);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("old\n");
  });
});
