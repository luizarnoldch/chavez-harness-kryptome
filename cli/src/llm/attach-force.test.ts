import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAttach, hydrateForced } from "./attach-force";

describe("decideAttach", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-af-")));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "secretless\n");
  writeFileSync(join(cwd, ".env"), "K=live\n");
  writeFileSync(join(cwd, "src.ts"), "ok\n");

  test("normal file", () => {
    expect(decideAttach(cwd, "src.ts", "auto").attachment.status).toBe("ok");
  });

  test("junk auto warns and does not hydrate", () => {
    const d = decideAttach(cwd, "node_modules/pkg/index.js", "auto");
    expect(d.attachment.status).toBe("ignored");
    expect(d.notice).toMatch(/not hydrated/i);
    expect(d.needsAsk).toBeUndefined();
  });

  test("junk ask needs confirmation", () => {
    const d = decideAttach(cwd, "node_modules/pkg/index.js", "ask");
    expect(d.needsAsk?.path).toBe("node_modules/pkg/index.js");
  });

  test("force junk hydrates", () => {
    const a = hydrateForced(cwd, "node_modules/pkg/index.js", "junk");
    expect(a.status).toBe("ok");
    expect(a.hydratedText).toContain("secretless");
  });

  test("secret auto refuses raw", () => {
    const d = decideAttach(cwd, ".env", "auto");
    expect(d.attachment.status).toBe("secret");
    expect(d.notice).toMatch(/secret file/i);
  });
});
