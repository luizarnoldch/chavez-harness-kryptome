import { describe, expect, test } from "bun:test";
import {
  applyOnboardingAction,
  askPreflightError,
  deriveOnboarding,
  isOnboardingAction,
  NO_DAEMON_ERROR,
  NO_PROVIDER_ASK,
  NEXT_DAEMON,
  NEXT_PROVIDER,
  parseOnboardingStatus,
  wizardVisible,
  workspaceEmptyKind,
} from "./onboarding";

describe("parseOnboardingStatus", () => {
  test("null/empty → pending", () => {
    expect(parseOnboardingStatus(null)).toBe("pending");
    expect(parseOnboardingStatus(undefined)).toBe("pending");
    expect(parseOnboardingStatus("")).toBe("pending");
  });
  test("accepts the three statuses", () => {
    expect(parseOnboardingStatus("pending")).toBe("pending");
    expect(parseOnboardingStatus("skipped")).toBe("skipped");
    expect(parseOnboardingStatus("completed")).toBe("completed");
  });
  test("typo → pending, does not throw", () => {
    expect(parseOnboardingStatus("yolo")).toBe("pending");
  });
});

describe("deriveOnboarding", () => {
  test("new account: all steps open, wizard visible", () => {
    const s = deriveOnboarding({
      persistedStatus: null,
      runnableLinked: false,
      daemonBound: false,
    });
    expect(s.status).toBe("pending");
    expect(s.wizardVisible).toBe(true);
    expect(s.steps).toEqual({
      providerLinked: false,
      daemonBound: false,
      firstTurn: false,
    });
    expect(s.nextStep).toBe("provider");
    expect(s.nextCommand).toBe(NEXT_PROVIDER);
  });

  test("provider linked, no daemon → next daemon", () => {
    const s = deriveOnboarding({
      persistedStatus: "pending",
      runnableLinked: true,
      daemonBound: false,
    });
    expect(s.nextStep).toBe("daemon");
    expect(s.nextCommand).toBe(NEXT_DAEMON);
    expect(s.wizardVisible).toBe(true);
  });

  test("provider + daemon, no turn → next chat", () => {
    const s = deriveOnboarding({
      persistedStatus: "pending",
      runnableLinked: true,
      daemonBound: true,
    });
    expect(s.nextStep).toBe("chat");
    expect(s.steps.firstTurn).toBe(false);
  });

  test("completed hides wizard and clears nextStep", () => {
    const s = deriveOnboarding({
      persistedStatus: "completed",
      runnableLinked: true,
      daemonBound: true,
    });
    expect(s.wizardVisible).toBe(false);
    expect(s.nextStep).toBe(null);
    expect(s.steps.firstTurn).toBe(true);
  });

  test("skipped hides wizard but does not fake steps", () => {
    const s = deriveOnboarding({
      persistedStatus: "skipped",
      runnableLinked: false,
      daemonBound: false,
    });
    expect(s.wizardVisible).toBe(false);
    expect(s.steps.providerLinked).toBe(false);
    expect(s.nextStep).toBe("provider");
  });

  test("cursor linked only is not providerLinked", () => {
    const s = deriveOnboarding({
      persistedStatus: "pending",
      runnableLinked: false,
      daemonBound: false,
      cursorLinkedOnly: true,
    });
    expect(s.steps.providerLinked).toBe(false);
    expect(s.cursorLinkedOnly).toBe(true);
    expect(s.nextStep).toBe("provider");
  });
});

describe("askPreflightError", () => {
  test("no provider wins over no daemon", () => {
    expect(
      askPreflightError({ runnableLinked: false, daemonBound: false }),
    ).toBe(NO_PROVIDER_ASK);
  });
  test("no daemon uses the canonical string", () => {
    expect(
      askPreflightError({ runnableLinked: true, daemonBound: false }),
    ).toBe(NO_DAEMON_ERROR);
  });
  test("ready → null", () => {
    expect(
      askPreflightError({ runnableLinked: true, daemonBound: true }),
    ).toBe(null);
  });
});

describe("applyOnboardingAction", () => {
  test("skip from pending", () => {
    expect(applyOnboardingAction("pending", "skip")).toBe("skipped");
  });
  test("complete wins over skip", () => {
    expect(applyOnboardingAction("skipped", "complete")).toBe("completed");
    expect(applyOnboardingAction("completed", "skip")).toBe("completed");
  });
  test("isOnboardingAction rejects other verbs", () => {
    expect(isOnboardingAction("skip")).toBe(true);
    expect(isOnboardingAction("dismiss")).toBe(false);
  });
});

describe("workspaceEmptyKind", () => {
  test("zero workspaces without daemon is copy, not a fake workspace", () => {
    expect(workspaceEmptyKind({ daemonBound: false, workspaceCount: 0 })).toBe(
      "copy",
    );
  });
  test("rows without daemon are sin_runner", () => {
    expect(workspaceEmptyKind({ daemonBound: false, workspaceCount: 2 })).toBe(
      "sin_runner",
    );
  });
  test("daemon bound is ready", () => {
    expect(workspaceEmptyKind({ daemonBound: true, workspaceCount: 0 })).toBe(
      "ready",
    );
  });
});

describe("wizardVisible", () => {
  test("only pending", () => {
    expect(wizardVisible("pending")).toBe(true);
    expect(wizardVisible("skipped")).toBe(false);
    expect(wizardVisible("completed")).toBe(false);
  });
});
