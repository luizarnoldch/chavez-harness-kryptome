import { describe, expect, test } from "bun:test";
import { askPreflightError, deriveOnboarding } from "./status";

test("skipped still requires provider+daemon for ask", () => {
  const s = deriveOnboarding({
    persistedStatus: "skipped",
    runnableLinked: false,
    daemonBound: false,
  });
  expect(s.wizardVisible).toBe(false);
  expect(
    askPreflightError({
      runnableLinked: s.steps.providerLinked,
      daemonBound: s.steps.daemonBound,
    }),
  ).not.toBeNull();
});

test("skipped with provider+daemon allows ask", () => {
  const s = deriveOnboarding({
    persistedStatus: "skipped",
    runnableLinked: true,
    daemonBound: true,
  });
  expect(s.wizardVisible).toBe(false);
  expect(
    askPreflightError({
      runnableLinked: true,
      daemonBound: true,
    }),
  ).toBeNull();
});
