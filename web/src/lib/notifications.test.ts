import { describe, expect, test } from "bun:test";
import {
  classifyNotificationEvent,
  emptyNotificationState,
  hasApproval,
  hasDaemonDown,
  isNeverNotifyType,
  markChatRead,
  reduceNotification,
  shouldShowWebChatBanner,
  shouldShowWebToast,
} from "./notifications";

const ctx = { surface: "web" as const, activeChatId: null };

test("delta never notifies", () => {
  expect(isNeverNotifyType("chat.stream.delta")).toBe(true);
  expect(
    classifyNotificationEvent(
      { type: "chat.stream.delta", data: { chatId: "c1", delta: "x" } },
      ctx,
    ).op,
  ).toBe("ignore");
});

const storeCtx = { surface: "tui" as const, activeChatId: "active", now: 1_000 };

function push(state: ReturnType<typeof emptyNotificationState>, type: string, data: unknown) {
  return reduceNotification(state, { type, data }, storeCtx).state;
}

test("100 deltas do not grow the store", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.stream.start", { chatId: "c1", streamId: "s1" });
  for (let i = 0; i < 100; i++) {
    s = push(s, "chat.stream.delta", { chatId: "c1", streamId: "s1", delta: "x" });
  }
  s = push(s, "chat.stream.end", { chatId: "c1", streamId: "s1" });
  expect(s.items).toHaveLength(1);
  expect(s.items[0].kind).toBe("turn_done");
});

test("approval stays until resolved or result", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t1",
    metadata: { status: "awaiting_approval", toolName: "Bash" },
  });
  expect(hasApproval(s, "c1")).toBe(true);
  s = markChatRead(s, "c1");
  expect(hasApproval(s, "c1")).toBe(true);
  s = push(s, "chat.tool.resolved", {
    chatId: "c1",
    toolCallId: "t1",
    outcome: "timeout",
  });
  expect(hasApproval(s, "c1")).toBe(false);
});

test("daemon down then reconnect clears", () => {
  let s = emptyNotificationState();
  s = push(s, "daemon.presence", { bound: false, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(true);
  s = push(s, "daemon.presence", { bound: true, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(false);
});

test("Web toast skipped on the open chat; banner shown instead", () => {
  const done = { kind: "turn_done" as const, chatId: "c1", sticky: false };
  expect(shouldShowWebToast(done, "c1")).toBe(false);
  expect(shouldShowWebToast(done, null)).toBe(true);
  expect(shouldShowWebChatBanner(done, "c1")).toBe(true);
});
