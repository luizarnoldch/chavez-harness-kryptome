import { describe, expect, test } from "bun:test";
import { formatOnboardingHint } from "./print";
import { HINT_LOGIN_HEADER } from "./status";

const pending = {
  status: "pending" as const,
  wizardVisible: true,
  steps: {
    providerLinked: false,
    daemonBound: false,
    firstTurn: false,
  },
  nextCommand: "Siguiente paso: chavez provider link claude",
  cursorLinkedOnly: false,
};

test("pending prints three steps and header", () => {
  const text = formatOnboardingHint(pending);
  expect(text.startsWith(HINT_LOGIN_HEADER)).toBe(true);
  expect(text).toContain("[ ] Vincular provider (Claude)");
  expect(text).toContain("chavez provider link claude");
  expect(text).toContain("chavez tui");
  expect(text).toContain("chavez headless workspace open");
  expect(text).toContain("chavez headless chat ask");
});

test("completed/skipped prints nothing", () => {
  expect(
    formatOnboardingHint({
      ...pending,
      status: "completed",
      wizardVisible: false,
      nextCommand: null,
    }),
  ).toBe("");
  expect(
    formatOnboardingHint({
      ...pending,
      status: "skipped",
      wizardVisible: false,
    }),
  ).toBe("");
});

test("cursor-only adds the runnable hint", () => {
  const text = formatOnboardingHint({ ...pending, cursorLinkedOnly: true });
  expect(text).toContain("Cursor está vinculado pero no ejecuta turns");
});
