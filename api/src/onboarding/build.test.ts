import { describe, expect, test } from "bun:test";
import { deriveOnboarding } from "./status";

test("build shape matches public snapshot", () => {
  const snap = deriveOnboarding({
    persistedStatus: "pending",
    runnableLinked: true,
    daemonBound: true,
  });
  expect(snap.nextStep).toBe("chat");
  expect(snap.wizardVisible).toBe(true);
});
