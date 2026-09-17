import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const src = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

describe("plan WS handlers", () => {
  test("apply does not commit", () => {
    expect(src).toContain("chat.plan.apply");
    expect(src).toContain("gitCommit: false");
    expect(src).not.toContain("runGit");
    expect(src).not.toContain("git commit");
    expect(src).not.toContain("git-exec");
  });

  test("stream.end promotes plan_artifact", () => {
    expect(src).toContain("PLAN_CREATED_EVENT");
    expect(src).toContain("persistPromote");
  });
});
