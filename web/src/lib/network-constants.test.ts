import { describe, expect, test } from "bun:test";
import { bannerNeedsNetwork, NETWORK_REQUEST_LABEL } from "./network-constants";

describe("network constants", () => {
  test("label is pide red", () => {
    expect(NETWORK_REQUEST_LABEL).toBe("pide red");
  });

  test("bannerNeedsNetwork true", () => {
    expect(bannerNeedsNetwork({ needsNetwork: true })).toBe(true);
  });

  test("bannerNeedsNetwork false without flag", () => {
    expect(bannerNeedsNetwork({ status: "awaiting_approval" })).toBe(false);
  });
});
