import { describe, expect, test } from "bun:test";
import { canonicalToolName, isToolStatus, toolClass } from "./tool-names";

describe("canonicalToolName", () => {
  test("maps SDK names", () => {
    expect(canonicalToolName("Read")).toBe("read");
    expect(canonicalToolName("Write")).toBe("write");
    expect(canonicalToolName("Edit")).toBe("edit");
    expect(canonicalToolName("NotebookEdit")).toBe("edit");
    expect(canonicalToolName("Grep")).toBe("grep");
    expect(canonicalToolName("Glob")).toBe("glob");
    expect(canonicalToolName("LS")).toBe("glob");
    expect(canonicalToolName("Bash")).toBe("bash");
  });

  test("unknown tools keep lowercase", () => {
    expect(canonicalToolName("TodoWrite")).toBe("todowrite");
  });
});

describe("toolClass", () => {
  test("reads vs writes", () => {
    expect(toolClass("Read")).toBe("read");
    expect(toolClass("Grep")).toBe("read");
    expect(toolClass("Write")).toBe("write");
    expect(toolClass("Bash")).toBe("write");
    expect(toolClass("TodoWrite")).toBe("other");
  });
});

describe("isToolStatus", () => {
  test("four statuses", () => {
    expect(isToolStatus("running")).toBe(true);
    expect(isToolStatus("awaiting_approval")).toBe(true);
    expect(isToolStatus("done")).toBe(true);
    expect(isToolStatus("error")).toBe(true);
    expect(isToolStatus("queued")).toBe(false);
  });
});
