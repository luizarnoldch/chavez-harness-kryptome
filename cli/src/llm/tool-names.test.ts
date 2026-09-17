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

  test("git MCP names canonicalise", () => {
    expect(canonicalToolName("mcp__chavez-git__git_commit")).toBe("git_commit");
    expect(canonicalToolName("git_status")).toBe("git_status");
    expect(canonicalToolName("mcp__chavez-git__git_pr")).toBe("git_pr");
    expect(canonicalToolName("mcp__chavez-git__git_pr_get")).toBe("git_pr_get");
    expect(canonicalToolName("mcp__chavez-git__git_pr_review")).toBe(
      "git_pr_review",
    );
  });

  test("memory MCP names canonicalise", () => {
    expect(canonicalToolName("memory_save")).toBe("memory_save");
    expect(canonicalToolName("mcp__chavez-memory__memory_list")).toBe(
      "memory_list",
    );
    expect(canonicalToolName("mcp__chavez-memory__memory_forget")).toBe(
      "memory_forget",
    );
  });

  test("fetch names canonicalise", () => {
    expect(canonicalToolName("WebFetch")).toBe("fetch");
    expect(canonicalToolName("mcp__chavez-web__fetch")).toBe("fetch");
    expect(canonicalToolName("web_fetch")).toBe("fetch");
  });
});

describe("toolClass", () => {
  test("reads vs writes", () => {
    expect(toolClass("Read")).toBe("read");
    expect(toolClass("Grep")).toBe("read");
    expect(toolClass("Write")).toBe("write");
    expect(toolClass("Bash")).toBe("write");
    expect(toolClass("TodoWrite")).toBe("other");
    expect(toolClass("git_status")).toBe("read");
    expect(toolClass("mcp__chavez-git__git_commit")).toBe("write");
    expect(toolClass("mcp__chavez-git__git_pr_get")).toBe("read");
    expect(toolClass("mcp__chavez-git__git_pr_review")).toBe("write");
    expect(toolClass("memory_save")).toBe("other");
    expect(toolClass("mcp__chavez-memory__memory_forget")).toBe("other");
    expect(toolClass("WebFetch")).toBe("other");
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
