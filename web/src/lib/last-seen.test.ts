import { describe, expect, test } from "bun:test";
import { formatLastSeen } from "./last-seen";

describe("formatLastSeen", () => {
  test("null → nunca", () => {
    expect(formatLastSeen(null)).toBe("nunca");
  });

  test("now → ahora", () => {
    const now = Date.now();
    expect(formatLastSeen(new Date(now).toISOString(), now)).toBe("ahora");
  });

  test("3s ago", () => {
    const now = Date.now();
    expect(
      formatLastSeen(new Date(now - 3000).toISOString(), now),
    ).toBe("hace 3s");
  });

  test("2m ago", () => {
    const now = Date.now();
    expect(
      formatLastSeen(new Date(now - 120_000).toISOString(), now),
    ).toBe("hace 2m");
  });
});
