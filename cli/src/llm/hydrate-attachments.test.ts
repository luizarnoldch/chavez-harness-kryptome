import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockingAttachError,
  hydrateOne,
  persistableAttachment,
  TEXT_ATTACH_MAX_BYTES,
} from "./hydrate-attachments";

describe("hydrateOne", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-hy-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "auth.ts"), "export const x = 1;\n");
  writeFileSync(join(cwd, "big.txt"), "a".repeat(TEXT_ATTACH_MAX_BYTES + 50));
  mkdirSync(join(cwd, "lots"));
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(cwd, "lots", `f${i}.txt`), "x");
  }
  writeFileSync(
    join(cwd, "shot.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  writeFileSync(join(cwd, "blob.bin"), Buffer.from("hello\0world"));

  test("text", () => {
    const a = hydrateOne(cwd, "src/auth.ts");
    expect(a.kind).toBe("text");
    expect(a.status).toBe("ok");
    expect(a.hydratedText).toContain("export const x");
  });

  test("truncates large text", () => {
    const a = hydrateOne(cwd, "big.txt");
    expect(a.truncated).toBe(true);
    expect(a.hydratedText).toContain("[truncated:");
  });

  test("directory lists at most 10", () => {
    const a = hydrateOne(cwd, "lots");
    expect(a.kind).toBe("directory");
    expect(a.listing?.length).toBe(10);
    expect(a.hydratedText).toContain("10 of 15");
  });

  test("image is not utf8", () => {
    const a = hydrateOne(cwd, "shot.png");
    expect(a.kind).toBe("image");
    expect(a.imageBase64).toBeTruthy();
    expect("imageBase64" in persistableAttachment(a)).toBe(false);
  });

  test("binary never inlined as utf8", () => {
    const a = hydrateOne(cwd, "blob.bin");
    expect(a.kind).toBe("binary");
    expect(a.hydratedText).toContain("not UTF-8");
    expect(a.hydratedText).not.toContain("\0");
  });

  test("forbidden escape", () => {
    expect(hydrateOne(cwd, "../outside.txt").status).toBe("forbidden");
  });

  test("missing", () => {
    expect(hydrateOne(cwd, "no-existe.ts").status).toBe("missing");
  });

  test("blockingAttachError", () => {
    expect(blockingAttachError([hydrateOne(cwd, "src/auth.ts")])).toBeNull();
    expect(blockingAttachError([hydrateOne(cwd, "no-existe.ts")])).toMatch(
      /not found/i,
    );
    expect(blockingAttachError([hydrateOne(cwd, "../../.ssh/id_rsa")])).toMatch(
      /outside workspace/i,
    );
  });
});

describe("hydrateOne ignore", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-hyig-")));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  mkdirSync(join(cwd, ".chavez"), { recursive: true });
  writeFileSync(join(cwd, ".chavez", "config.json"), '{"accessToken":"abc"}\n');

  test("hand-typed .env is secret, not raw", () => {
    const a = hydrateOne(cwd, ".env");
    expect(a.status).toBe("secret");
    expect(a.hydratedText ?? "").not.toContain("SECRET=1");
  });

  test("force secret hydrates redacted", () => {
    writeFileSync(join(cwd, ".env"), "SECRET=super\n");
    const a = hydrateOne(cwd, ".env", { force: true, redactSecret: true });
    expect(a.status).toBe("ok");
    expect(a.hydratedText ?? "").toContain("SECRET=***");
    expect(a.hydratedText ?? "").not.toContain("super");
  });

  test("ignored junk without force", () => {
    const a = hydrateOne(cwd, "node_modules/pkg/index.js");
    expect(a.status).toBe("ignored");
    expect(a.hydratedText).toBeUndefined();
  });

  test("force junk hydrates", () => {
    const a = hydrateOne(cwd, "node_modules/pkg/index.js", { force: true });
    expect(a.status).toBe("ok");
    expect(a.hydratedText ?? "").toContain("x");
  });

  test("vault blocks the turn", () => {
    const a = hydrateOne(cwd, ".chavez/config.json");
    expect(a.status).toBe("vault");
    expect(blockingAttachError([a])).toMatch(/vault/i);
    expect(blockingAttachError([hydrateOne(cwd, ".env")])).toBeNull();
  });
});
