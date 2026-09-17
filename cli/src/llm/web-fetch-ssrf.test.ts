import { describe, expect, test } from "bun:test";
import {
  SSRF_DENIED_API,
  SSRF_DENIED_METADATA,
  SSRF_DENIED_SCHEME,
} from "./web-fetch-constants";
import { assertFetchUrlSafe } from "./web-fetch-ssrf";

const api = "http://localhost:25001";

describe("assertFetchUrlSafe", () => {
  test("rejects file and ftp", async () => {
    expect((await assertFetchUrlSafe("file:///etc/passwd", { apiUrl: api })).ok).toBe(false);
    const ftp = await assertFetchUrlSafe("ftp://example.com/a", { apiUrl: api });
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.message).toBe(SSRF_DENIED_SCHEME);
  });

  test("rejects credentials in URL", async () => {
    const r = await assertFetchUrlSafe("https://user:pass@example.com/", {
      apiUrl: api,
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects cloud metadata IP", async () => {
    const r = await assertFetchUrlSafe("http://169.254.169.254/latest/meta-data", {
      apiUrl: api,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_METADATA);
  });

  test("rejects metadata hostname even if it resolves public", async () => {
    const r = await assertFetchUrlSafe("http://metadata.google.internal/", {
      apiUrl: api,
      lookup: async () => ["8.8.8.8"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_METADATA);
  });

  test("rejects DNS that resolves to link-local", async () => {
    const r = await assertFetchUrlSafe("http://evil.example/", {
      apiUrl: api,
      lookup: async () => ["169.254.169.254"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_METADATA);
  });

  test("rejects Chavez API localhost origin", async () => {
    const r = await assertFetchUrlSafe("http://localhost:25001/providers", {
      apiUrl: api,
      lookup: async () => ["127.0.0.1"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_API);
  });

  test("rejects 127.0.0.1 on the API port", async () => {
    const r = await assertFetchUrlSafe("http://127.0.0.1:25001/vault", {
      apiUrl: api,
      lookup: async (h) => (h === "localhost" ? ["127.0.0.1"] : [h]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe(SSRF_DENIED_API);
  });

  test("allows loopback on another port (local docs)", async () => {
    const r = await assertFetchUrlSafe("http://127.0.0.1:3000/docs", {
      apiUrl: api,
      lookup: async (h) => [h === "localhost" ? "127.0.0.1" : h],
    });
    expect(r.ok).toBe(true);
  });

  test("allows public https", async () => {
    const r = await assertFetchUrlSafe("https://example.com/readme", {
      apiUrl: api,
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(true);
  });
});
