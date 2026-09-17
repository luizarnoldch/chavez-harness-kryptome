import { describe, expect, test } from "bun:test";
import {
  isNonInteractive,
  isSecretPromptForbidden,
  isTuiForbidden,
} from "./detect";

describe("isNonInteractive", () => {
  test("CI=true → true aunque stdout.isTTY === true", () => {
    expect(isNonInteractive({ CI: "true" }, { isTTY: true })).toBe(true);
  });

  test("CI=1 → true", () => {
    expect(isNonInteractive({ CI: "1" }, { isTTY: true })).toBe(true);
  });

  test("CHAVEZ_CI=1 → true", () => {
    expect(isNonInteractive({ CHAVEZ_CI: "1" }, { isTTY: true })).toBe(true);
  });

  test("env vacío + stdout.isTTY === false → true", () => {
    expect(isNonInteractive({}, { isTTY: false })).toBe(true);
  });

  test("env vacío + stdout.isTTY === true → false", () => {
    expect(isNonInteractive({}, { isTTY: true })).toBe(false);
  });
});

describe("isTuiForbidden", () => {
  test("stdin.isTTY === false aunque stdout sea TTY → true", () => {
    expect(
      isTuiForbidden({}, { isTTY: false }, { isTTY: true }),
    ).toBe(true);
  });
});

describe("isSecretPromptForbidden", () => {
  test("CI=true → true", () => {
    expect(
      isSecretPromptForbidden({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toBe(true);
  });
});
