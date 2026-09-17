import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXECUTION_MODE,
  INVALID_MODE_ERROR,
  isExecutionMode,
  parseExecutionMode,
} from "./execution-mode";

describe("parseExecutionMode", () => {
  test("accepts the three modes", () => {
    expect(parseExecutionMode("plan")).toBe("plan");
    expect(parseExecutionMode("auto")).toBe("auto");
    expect(parseExecutionMode("ask")).toBe("ask");
  });

  test("null/empty defaults to ask", () => {
    expect(parseExecutionMode(null)).toBe(DEFAULT_EXECUTION_MODE);
    expect(parseExecutionMode(undefined)).toBe("ask");
    expect(parseExecutionMode("")).toBe("ask");
  });

  test("rejects yolo and does not coerce", () => {
    expect(() => parseExecutionMode("yolo")).toThrow(INVALID_MODE_ERROR);
    expect(() => parseExecutionMode("bypass")).toThrow(INVALID_MODE_ERROR);
    expect(() => parseExecutionMode("ASK")).toThrow(INVALID_MODE_ERROR);
    expect(isExecutionMode("yolo")).toBe(false);
  });
});
