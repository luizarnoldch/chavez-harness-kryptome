import { describe, expect, test } from "bun:test";
import { bannerNeedsNetwork } from "./network-constants";

describe("bannerNeedsNetwork", () => {
  test("top-level needsNetwork", () => {
    expect(bannerNeedsNetwork({ needsNetwork: true })).toBe(true);
  });

  test("prompt.needsNetwork", () => {
    expect(
      bannerNeedsNetwork({
        prompt: { kind: "bash", command: "curl x", needsNetwork: true },
      }),
    ).toBe(true);
  });

  test("bash ls without flag", () => {
    expect(
      bannerNeedsNetwork({
        prompt: { kind: "bash", command: "ls" },
      }),
    ).toBe(false);
  });
});
