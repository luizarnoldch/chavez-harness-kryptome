import { describe, expect, test } from "bun:test";
import { generateShareToken, isShareTokenShape } from "./share-token";
import { SHARE_TOKEN_BYTES } from "./export-share";

describe("generateShareToken", () => {
  test("url-safe, unique, long enough", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
    expect(isShareTokenShape(a)).toBe(true);
    expect(a).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(a, "base64url");
    expect(decoded.byteLength).toBe(SHARE_TOKEN_BYTES);
  });
});
