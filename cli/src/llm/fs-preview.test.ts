import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_TEXT_MAX_BYTES, previewFile } from "./fs-preview";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("previewFile", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-prev-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "auth.ts"), "export const x = 1;\n");
  writeFileSync(join(cwd, "src", "logo.png"), PNG_1X1);
  writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  const big = "a".repeat(PREVIEW_TEXT_MAX_BYTES + 50);
  writeFileSync(join(cwd, "src", "big.txt"), big);
  mkdirSync(join(cwd, "src", "lots"));
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(cwd, "src", "lots", `n${i}.txt`), "x");
  }

  test("text is shown and huge text is truncated", () => {
    const t = previewFile(cwd, "src/auth.ts");
    expect(t.kind).toBe("text");
    expect(t.status).toBe("ok");
    expect(t.text).toContain("export const x");
    const b = previewFile(cwd, "src/big.txt");
    expect(b.truncated).toBe(true);
    expect(b.text || "").toContain("[truncated:");
    expect((b.text || "").length).toBeLessThan(PREVIEW_TEXT_MAX_BYTES + 80);
  });

  test("image renders as image, not utf8", () => {
    const p = previewFile(cwd, "src/logo.png");
    expect(p.kind).toBe("image");
    expect(p.status).toBe("ok");
    expect(p.imageBase64).toBeTruthy();
    expect(p.text).toBeUndefined();
    expect(p.mediaType).toMatch(/^image\//);
  });

  test("binary is not faked as text", () => {
    const p = previewFile(cwd, "src/blob.bin");
    expect(p.kind).toBe("binary");
    expect(p.text).toBeUndefined();
    expect(p.notice || "").toMatch(/Binario/);
    expect(JSON.stringify(p)).not.toContain("\u0000");
  });

  test("ignored secret is not previewed", () => {
    const p = previewFile(cwd, ".env");
    expect(p.status).toBe("ignored");
    expect(p.text).toBeUndefined();
    expect(p.imageBase64).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("SECRET=1");
  });

  test("escape is forbidden", () => {
    const p = previewFile(cwd, "../outside.txt");
    expect(p.status).toBe("forbidden");
  });

  test("directory listing is capped at 10", () => {
    const p = previewFile(cwd, "src/lots");
    expect(p.kind).toBe("directory");
    expect((p.listing || []).length).toBeLessThanOrEqual(10);
  });
});
