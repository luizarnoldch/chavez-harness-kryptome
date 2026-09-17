import { describe, expect, test } from "bun:test";
import {
  NO_LOGIN_PROMPT,
  NO_SECRET_PROMPT,
  TUI_NO_TTY,
} from "./constants";
import { CiCliError } from "./errors";
import {
  assertCanLoginInteractive,
  assertCanOpenTui,
  assertCanPromptSecret,
} from "./guards";

describe("assertCanOpenTui", () => {
  test("CI=true lanza TUI_NO_TTY aunque stdin/stdout sean TTY", () => {
    expect(() =>
      assertCanOpenTui({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toThrow(new CiCliError(TUI_NO_TTY, 1));
  });

  test("stdin.isTTY false lanza TUI_NO_TTY", () => {
    expect(() =>
      assertCanOpenTui({}, { isTTY: false }, { isTTY: true }),
    ).toThrow(new CiCliError(TUI_NO_TTY, 1));
  });

  test("TTY interactivo no lanza", () => {
    expect(() =>
      assertCanOpenTui({}, { isTTY: true }, { isTTY: true }),
    ).not.toThrow();
  });
});

describe("assertCanPromptSecret", () => {
  test("CI=true lanza NO_SECRET_PROMPT", () => {
    expect(() =>
      assertCanPromptSecret({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toThrow(new CiCliError(NO_SECRET_PROMPT, 1));
  });
});

describe("assertCanLoginInteractive", () => {
  test("CHAVEZ_CI=1 lanza NO_LOGIN_PROMPT", () => {
    expect(() =>
      assertCanLoginInteractive({ CHAVEZ_CI: "1" }, { isTTY: true }),
    ).toThrow(new CiCliError(NO_LOGIN_PROMPT, 1));
  });
});

describe("mensajes exactos", () => {
  test("assertCanOpenTui mensaje exacto", () => {
    try {
      assertCanOpenTui({ CI: "true" }, { isTTY: true }, { isTTY: true });
    } catch (err) {
      expect(err).toBeInstanceOf(CiCliError);
      expect((err as CiCliError).message).toBe(TUI_NO_TTY);
    }
  });

  test("assertCanPromptSecret mensaje exacto", () => {
    try {
      assertCanPromptSecret({ CI: "true" }, { isTTY: true }, { isTTY: true });
    } catch (err) {
      expect(err).toBeInstanceOf(CiCliError);
      expect((err as CiCliError).message).toBe(NO_SECRET_PROMPT);
    }
  });

  test("assertCanLoginInteractive mensaje exacto", () => {
    try {
      assertCanLoginInteractive({ CHAVEZ_CI: "1" }, { isTTY: true });
    } catch (err) {
      expect(err).toBeInstanceOf(CiCliError);
      expect((err as CiCliError).message).toBe(NO_LOGIN_PROMPT);
    }
  });
});
