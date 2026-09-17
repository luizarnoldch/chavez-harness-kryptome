import { describe, expect, test } from "bun:test";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { PLAN_GIT_DENIED, GIT_USE_DEDICATED_TOOLS } from "./git-constants";
import { gateClass, gateMutation } from "./execution-gate";

describe("gateClass", () => {
  test("reads vs writes", () => {
    expect(gateClass("Read")).toBe("read");
    expect(gateClass("Grep")).toBe("read");
    expect(gateClass("Glob")).toBe("read");
    expect(gateClass("LS")).toBe("read");
    expect(gateClass("Write")).toBe("write");
    expect(gateClass("Edit")).toBe("write");
    expect(gateClass("NotebookEdit")).toBe("write");
    expect(gateClass("Bash")).toBe("write");
    expect(gateClass("TodoWrite")).toBe("other");
    expect(gateClass("git_status")).toBe("read");
    expect(gateClass("mcp__chavez-git__git_commit")).toBe("write");
  });
});

describe("gateMutation", () => {
  test("reads never ask, in any mode", () => {
    for (const mode of ["ask", "auto", "plan"] as const) {
      for (const name of ["Read", "Grep", "Glob", "LS"]) {
        expect(gateMutation(mode, name).decision).toBe("allow");
      }
    }
  });

  test("ask confirms write/edit/bash", () => {
    expect(gateMutation("ask", "Write").decision).toBe("ask");
    expect(gateMutation("ask", "Edit").decision).toBe("ask");
    expect(gateMutation("ask", "Bash").decision).toBe("ask");
  });

  test("auto allows write/edit/bash (sandbox is a different layer)", () => {
    expect(gateMutation("auto", "Write").decision).toBe("allow");
    expect(gateMutation("auto", "Edit").decision).toBe("allow");
    expect(gateMutation("auto", "Bash").decision).toBe("allow");
  });

  test("plan denies mutations with a stable message", () => {
    const d = gateMutation("plan", "Write");
    expect(d.decision).toBe("deny");
    expect(d.message).toBe(PLAN_MUTATION_DENIED);
    expect(gateMutation("plan", "Bash").decision).toBe("deny");
    expect(gateMutation("plan", "Edit").decision).toBe("deny");
  });

  test("git_status allowed in plan", () => {
    expect(gateMutation("plan", "git_status").decision).toBe("allow");
  });

  test("git_commit in plan is PLAN_GIT_DENIED not PLAN_MUTATION_DENIED", () => {
    const d = gateMutation("plan", "mcp__chavez-git__git_commit", {
      message: "x",
    });
    expect(d.decision).toBe("deny");
    expect(d.message).toBe(PLAN_GIT_DENIED);
    expect(d.message).not.toBe(PLAN_MUTATION_DENIED);
  });

  test("bash git is intercepted", () => {
    const d = gateMutation("auto", "Bash", { command: "git commit -m x" });
    expect(d.decision).toBe("deny");
    expect(d.message).toBe(GIT_USE_DEDICATED_TOOLS);
  });
});
