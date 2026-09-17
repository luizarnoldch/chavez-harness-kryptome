import { expect, test } from "bun:test";
import { shouldShowTuiBadge } from "./classify";
import {
  emptyNotificationState,
  markChatRead,
  reduceNotification,
} from "./store";

test("TUI turn done badges only the other chat", () => {
  const ctx = { surface: "tui" as const, activeChatId: "mine", now: 1 };
  let s = emptyNotificationState();
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "other", streamId: "s1" } },
    ctx,
  ).state;
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "mine", streamId: "s2" } },
    ctx,
  ).state;
  const other = s.items.find((i) => i.chatId === "other")!;
  const mine = s.items.find((i) => i.chatId === "mine")!;
  expect(shouldShowTuiBadge(other, "mine")).toBe(true);
  expect(shouldShowTuiBadge(mine, "mine")).toBe(false);
});

test("opening the other chat clears the turn badge, not a live ask", () => {
  const ctx = { surface: "tui" as const, activeChatId: "mine", now: 1 };
  let s = emptyNotificationState();
  s = reduceNotification(
    s,
    { type: "chat.stream.end", data: { chatId: "other", streamId: "s1" } },
    ctx,
  ).state;
  s = reduceNotification(
    s,
    {
      type: "chat.tool.update",
      data: {
        chatId: "other",
        toolCallId: "t1",
        metadata: { status: "awaiting_approval", toolName: "Write" },
      },
    },
    ctx,
  ).state;
  s = markChatRead(s, "other");
  expect(s.items.some((i) => i.kind === "turn_done")).toBe(false);
  expect(s.items.some((i) => i.kind === "approval")).toBe(true);
  expect(shouldShowTuiBadge(s.items[0], "other")).toBe(true);
});
