import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactDiffForCwd } from "./secret-diff";

describe("redactDiffForCwd", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-diff-")));
  writeFileSync(join(cwd, ".env"), "K=1\n");

  test("redacts dotenv values in a unified diff", () => {
    const diff = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-K=oldsecret",
      "+K=newsecret",
    ].join("\n");
    const out = redactDiffForCwd(cwd, diff);
    expect(out).not.toContain("oldsecret");
    expect(out).not.toContain("newsecret");
    expect(out).toContain("K=***");
  });
});
