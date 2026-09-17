import { describe, expect, test } from "bun:test";
import { TOAST_TTL_MS } from "./constants";
import {
  emptyNotificationState,
  hasApproval,
  hasDaemonDown,
  markChatRead,
  pruneExpired,
  reduceNotification,
  unreadCountForChat,
} from "./store";

const ctx = { surface: "tui" as const, activeChatId: "active", now: 1_000 };

function push(state: ReturnType<typeof emptyNotificationState>, type: string, data: unknown) {
  return reduceNotification(state, { type, data }, ctx).state;
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

test("start then end collapses to one turn_done", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.stream.start", { chatId: "c1", streamId: "s1" });
  s = push(s, "chat.stream.end", { chatId: "c1", streamId: "s1" });
  expect(s.items.map((i) => i.kind)).toEqual(["turn_done"]);
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

test("two asks are independent", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t1",
    metadata: { status: "awaiting_approval", toolName: "Write" },
  });
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t2",
    metadata: { status: "awaiting_approval", toolName: "Bash" },
  });
  expect(unreadCountForChat(s, "c1")).toBe(2);
  s = push(s, "chat.tool.resolved", { chatId: "c1", toolCallId: "t1" });
  expect(hasApproval(s, "c1")).toBe(true);
  expect(s.items).toHaveLength(1);
});

test("daemon down then reconnect clears", () => {
  let s = emptyNotificationState();
  s = push(s, "daemon.presence", { bound: false, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(true);
  s = push(s, "daemon.presence", { bound: true, workspaceId: "w1" });
  expect(hasDaemonDown(s)).toBe(false);
});

test("opening a chat marks turn notices read, keeps ask", () => {
  let s = emptyNotificationState();
  s = push(s, "chat.stream.end", { chatId: "c1", streamId: "s1" });
  s = push(s, "chat.tool.update", {
    chatId: "c1",
    toolCallId: "t1",
    metadata: { status: "awaiting_approval", toolName: "Write" },
  });
  s = markChatRead(s, "c1");
  expect(s.items.some((i) => i.kind === "turn_done")).toBe(false);
  expect(hasApproval(s, "c1")).toBe(true);
});

test("non-sticky prune after TTL; sticky survives", () => {
  let s = emptyNotificationState();
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "c1", streamId: "s1" } },
    { ...ctx, now: 0 },
  ).state;
  s = reduceNotification(
    s,
    {
      type: "chat.tool.update",
      data: {
        chatId: "c1",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", toolName: "Write" },
      },
    },
    { ...ctx, now: 0 },
  ).state;
  const pruned = pruneExpired(s, TOAST_TTL_MS + 1);
  expect(pruned.items.map((i) => i.kind)).toEqual(["approval"]);
});
