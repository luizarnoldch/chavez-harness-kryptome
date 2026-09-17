import { describe, expect, test } from "bun:test";
import { annotationsFromUnknown, mcpGateClass } from "./mcp-classify";

describe("mcp-classify", () => {
  test("{ readOnly: true } → read", () => {
    expect(mcpGateClass(annotationsFromUnknown({ readOnly: true }))).toBe(
      "read",
    );
  });

  test("{ readOnlyHint: true, destructiveHint: false } → read", () => {
    expect(
      mcpGateClass(
        annotationsFromUnknown({
          readOnlyHint: true,
          destructiveHint: false,
        }),
      ),
    ).toBe("read");
  });

  test("{} → write", () => {
    expect(mcpGateClass(annotationsFromUnknown({}))).toBe("write");
  });

  test("{ destructive: true } → write", () => {
    expect(mcpGateClass(annotationsFromUnknown({ destructive: true }))).toBe(
      "write",
    );
  });
});
