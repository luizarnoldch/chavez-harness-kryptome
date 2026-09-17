import { expect, test } from "bun:test";
import { emptyNotificationState, hasApproval, hasDaemonDown } from "./store";
import {
  hydrateDaemonFromConnections,
  hydrateDaemonFromPresence,
  hydrateFromMessages,
} from "./hydrate";

test("hydrate ask from awaiting_approval metadata", () => {
  const s = hydrateFromMessages(
    emptyNotificationState(),
    [
      {
        role: "tool",
        metadata: {
          status: "awaiting_approval",
          toolCallId: "t1",
          toolName: "Write",
        },
      },
    ],
    "c1",
  );
  expect(hasApproval(s, "c1")).toBe(true);
});

test("hydrate skips timed-out ask", () => {
  const s = hydrateFromMessages(
    emptyNotificationState(),
    [
      {
        role: "tool",
        metadata: {
          status: "awaiting_approval",
          toolCallId: "t1",
          toolName: "Write",
          approvalDeadline: new Date(0).toISOString(),
        },
      },
    ],
    "c1",
    Date.now(),
  );
  expect(hasApproval(s, "c1")).toBe(false);
});

test("hydrate skips Read even if marked awaiting", () => {
  const s = hydrateFromMessages(
    emptyNotificationState(),
    [
      {
        role: "tool",
        metadata: {
          status: "awaiting_approval",
          toolCallId: "t1",
          sdkName: "Read",
        },
      },
    ],
    "c1",
  );
  expect(hasApproval(s, "c1")).toBe(false);
});

test("no daemon connections → sin runner; presence bound clears", () => {
  let s = hydrateDaemonFromConnections(emptyNotificationState(), [], "w1");
  expect(hasDaemonDown(s)).toBe(true);
  s = hydrateDaemonFromConnections(
    s,
    [{ clientKind: "daemon", role: "primary", workspaceId: "w1" }],
    "w1",
  );
  expect(hasDaemonDown(s)).toBe(false);
  s = hydrateDaemonFromPresence(s, { bound: false, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(true);
  s = hydrateDaemonFromPresence(s, { bound: true, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(false);
});
