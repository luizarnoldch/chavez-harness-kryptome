import { describe, expect, test } from "bun:test";
import { thinkingFromMetadata } from "./thinking";

describe("thinkingFromMetadata", () => {
  test("reconstructs omitted thinking", () => {
    expect(thinkingFromMetadata({ thinking: { omitted: true } })).toEqual({
      kind: "thinking",
      omitted: true,
    });
  });

  test("reconstructs thinking text and duration", () => {
    expect(
      thinkingFromMetadata({
        thinking: {
          kind: "thinking",
          omitted: false,
          text: "why",
          durationMs: 12,
        },
      }),
    ).toEqual({
      kind: "thinking",
      omitted: false,
      text: "why",
      durationMs: 12,
    });
  });

  test("rejects absent or empty thinking", () => {
    expect(thinkingFromMetadata({ streamId: "x" })).toBeNull();
    expect(
      thinkingFromMetadata({
        thinking: { omitted: false, text: "  " },
      }),
    ).toBeNull();
  });
});
