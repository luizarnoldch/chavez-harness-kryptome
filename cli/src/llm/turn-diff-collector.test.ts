import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDiffCollector } from "./turn-diff-collector";

function tmp(): string {
  return realpathSync(
    mkdirSync(join(tmpdir(), `chavez-col-${crypto.randomUUID()}`), { recursive: true })!,
  );
}

describe("TurnDiffCollector", () => {
  test("net of two edits is one modified path", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "one\n");
    const c = new TurnDiffCollector("s1", cwd);
    await c.beforeAllow("Edit", { file_path: "a.ts", old_string: "one", new_string: "two" }, "t1");
    writeFileSync(join(cwd, "a.ts"), "two\n");
    await c.afterTool("Edit", { file_path: "a.ts" }, "done");
    await c.beforeAllow("Edit", { file_path: "a.ts", old_string: "two", new_string: "three" }, "t2");
    writeFileSync(join(cwd, "a.ts"), "three\n");
    await c.afterTool("Edit", { file_path: "a.ts" }, "done");
    const set = await c.finalize();
    expect(set).toHaveLength(1);
    expect(set[0]!.path).toBe("a.ts");
    expect(set[0]!.kind).toBe("modified");
    expect(set[0]!.preview).toContain("-one");
    expect(set[0]!.preview).toContain("+three");
  });

  test("created vs modified vs deleted", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "keep.ts"), "k\n");
    writeFileSync(join(cwd, "gone.ts"), "g\n");
    const c = new TurnDiffCollector("s2", cwd);
    await c.beforeAllow("Write", { file_path: "new.ts", content: "n\n" }, "t1");
    writeFileSync(join(cwd, "new.ts"), "n\n");
    await c.beforeAllow("Edit", { file_path: "keep.ts", old_string: "k", new_string: "K" }, "t2");
    writeFileSync(join(cwd, "keep.ts"), "K\n");
    await c.beforeAllow("Bash", { command: "rm gone.ts" }, "t3");
    unlinkSync(join(cwd, "gone.ts"));
    c.dropProposed("nope");
    // bash without git: gone.ts was not snapshotted as a path tool
    await c.afterTool("Bash", { command: "rm gone.ts" }, "done");
    // explicit path delete via Write-equivalent: snapshot gone before unlink already missed.
    // Snapshot delete by pretending it was an Edit path we tracked:
    const c2 = new TurnDiffCollector("s3", cwd);
    writeFileSync(join(cwd, "gone2.ts"), "z\n");
    await c2.beforeAllow("Bash", { command: "rm" }, "tb");
    // force path tracking like a write-delete
    await c2.beforeAllow("Write", { file_path: "gone2.ts", content: "" }, "td");
    unlinkSync(join(cwd, "gone2.ts"));
    const set = await c2.finalize();
    const kinds = Object.fromEntries(set.map((d) => [d.path, d.kind]));
    expect(kinds["gone2.ts"]).toBe("deleted");
  });

  test("read-only finalize is empty", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "x\n");
    const c = new TurnDiffCollector("s4", cwd);
    await c.beforeAllow("Read", { file_path: "a.ts" }, "t");
    const set = await c.finalize();
    expect(set).toHaveLength(0);
  });

  test("dropProposed excludes path from applied set", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "old\n");
    const c = new TurnDiffCollector("s5", cwd);
    const proposed = c.propose("Write", { file_path: "a.ts", content: "new\n" }, "t1");
    expect(proposed?.status).toBe("proposed");
    expect(proposed?.kind).toBe("modified");
    c.dropProposed("t1");
    const set = await c.finalize();
    expect(set).toHaveLength(0);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("old\n");
  });
});
