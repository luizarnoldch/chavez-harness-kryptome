import { describe, expect, test } from "bun:test";
import { createPendingMap } from "./pending";
import { ok } from "./protocol";

describe("createPendingMap", () => {
  test("times out", async () => {
    const p = createPendingMap(20);
    const msg = await p.wait("a", "fs.complete");
    expect(msg.ok).toBe(false);
    expect(msg.error || "").toMatch(/daemon bound/i);
  });

  test("complete wins over timeout", async () => {
    const p = createPendingMap(200);
    const done = p.wait("b", "fs.complete");
    expect(p.complete("b", ok("fs.complete", "b", { n: 1 }))).toBe(true);
    const msg = await done;
    expect(msg.ok).toBe(true);
    expect((msg.data as { n: number }).n).toBe(1);
  });

  test("search times out with the same no-daemon string", async () => {
    const p = createPendingMap(20);
    const msg = await p.wait("s", "fs.search");
    expect(msg.ok).toBe(false);
    expect(msg.error || "").toMatch(/daemon bound/i);
  });

  test("preview complete wins", async () => {
    const p = createPendingMap(200);
    const done = p.wait("p", "fs.preview");
    expect(p.complete("p", ok("fs.preview", "p", { kind: "text" }))).toBe(true);
    const msg = await done;
    expect(msg.ok).toBe(true);
  });
});
