import { describe, expect, test } from "bun:test";
import { canonicalCursorToolName } from "./cursor-tools";

describe("canonicalCursorToolName", () => {
  test("maps Cursor and Claude SDK names to canonical", () => {
    expect(canonicalCursorToolName("shell")).toBe("bash");
    expect(canonicalCursorToolName("ls")).toBe("glob");
    expect(canonicalCursorToolName("Read")).toBe("read");
    expect(canonicalCursorToolName("edit")).toBe("edit");
  });
});
