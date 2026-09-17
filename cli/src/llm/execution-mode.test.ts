import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXECUTION_MODE,
  INVALID_MODE_ERROR,
  cycleExecutionMode,
  isExecutionMode,
  parseExecutionMode,
  sdkPermissionModeFor,
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

describe("cycleExecutionMode", () => {
  test("ask → auto → plan → ask", () => {
    expect(cycleExecutionMode("ask")).toBe("auto");
    expect(cycleExecutionMode("auto")).toBe("plan");
    expect(cycleExecutionMode("plan")).toBe("ask");
    expect(cycleExecutionMode("ask", -1)).toBe("plan");
  });
});

describe("sdkPermissionModeFor", () => {
  test("always default so canUseTool + sandbox run", () => {
    expect(sdkPermissionModeFor("plan")).toBe("default");
    expect(sdkPermissionModeFor("auto")).toBe("default");
    expect(sdkPermissionModeFor("ask")).toBe("default");
  });
});
