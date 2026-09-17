import { describe, expect, test } from "bun:test";
import {
  classifyBashKind,
  extractExplicitTestCommand,
  isMutatingVerify,
  promptAsksForTests,
} from "./verify-classify";

describe("classifyBashKind", () => {
  test("npm test is verify", () => {
    expect(classifyBashKind("npm test")).toBe("verify");
    expect(classifyBashKind("bun test src/foo.test.ts")).toBe("verify");
    expect(classifyBashKind("cargo test --lib")).toBe("verify");
  });

  test("eslint is lint", () => {
    expect(classifyBashKind("npx eslint src")).toBe("lint");
    expect(classifyBashKind("tsc --noEmit")).toBe("lint");
    expect(classifyBashKind("ruff check .")).toBe("lint");
  });

  test("plain bash stays bash", () => {
    expect(classifyBashKind("ls -la")).toBe("bash");
    expect(classifyBashKind("echo hello")).toBe("bash");
  });

  test("does not treat env-prefixed echo as verify", () => {
    expect(classifyBashKind("FOO=1 echo npm test")).toBe("bash");
  });
});

describe("isMutatingVerify", () => {
  test("coverage and snapshots", () => {
    expect(isMutatingVerify("npm test -- --coverage")).toBe(true);
    expect(isMutatingVerify("npx jest --updateSnapshot")).toBe(true);
    expect(isMutatingVerify("npx vitest -u")).toBe(true);
    expect(isMutatingVerify("bun test")).toBe(false);
    expect(isMutatingVerify("ls -u")).toBe(false);
  });
});

describe("promptAsksForTests", () => {
  test("spanish and english", () => {
    expect(promptAsksForTests("cambia X y corre los tests")).toBe(true);
    expect(promptAsksForTests("run the tests after editing")).toBe(true);
    expect(promptAsksForTests("explica el archivo")).toBe(false);
  });
});

describe("extractExplicitTestCommand", () => {
  test("user typed the command", () => {
    expect(extractExplicitTestCommand("cambia X y corre npm test")).toBe(
      "npm test",
    );
  });

  test("no command in prompt", () => {
    expect(extractExplicitTestCommand("corre los tests")).toBeNull();
  });
});
