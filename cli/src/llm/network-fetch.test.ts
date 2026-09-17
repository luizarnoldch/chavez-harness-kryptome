import { describe, expect, test } from "bun:test";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_PLAN } from "./network-constants";
import { gateWebFetch, shouldSpawnFetch } from "./network-fetch";

describe("gateWebFetch", () => {
  test("auto denies internet fetch", () => {
    const g = gateWebFetch("auto", "https://example.com");
    expect(g.action).toBe("deny");
    expect(g.message).toBe(NETWORK_DENIED_AUTO);
    expect(shouldSpawnFetch(g)).toBe(false);
  });

  test("ask requires approval", () => {
    const g = gateWebFetch("ask", "https://example.com");
    expect(g.action).toBe("ask");
    expect(g.network).toBe(true);
    expect(shouldSpawnFetch(g)).toBe(false);
  });

  test("plan denies", () => {
    const g = gateWebFetch("plan", "https://example.com");
    expect(g.message).toBe(NETWORK_DENIED_PLAN);
    expect(shouldSpawnFetch(g)).toBe(false);
  });
});
