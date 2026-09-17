import { expect, test } from "bun:test";
import { classifyNotificationEvent } from "./classify";
import { emptyNotificationState, reduceNotification } from "./store";

test("watch may print deltas; the notice store still ignores them", () => {
  const ctx = { surface: "web" as const, activeChatId: null, now: 1 };
  let s = emptyNotificationState();
  const events = [
    { type: "chat.stream.start", data: { chatId: "c", streamId: "s" } },
    ...Array.from({ length: 50 }, () => ({
      type: "chat.stream.delta",
      data: { chatId: "c", streamId: "s", delta: "tok" },
    })),
    { type: "chat.stream.end", data: { chatId: "c", streamId: "s" } },
  ];
  const printed = events.map((e) => JSON.stringify({ type: e.type, data: e.data }));
  expect(printed).toHaveLength(52);
  for (const e of events) {
    expect(classifyNotificationEvent(e, ctx).op === "ignore").toBe(
      e.type === "chat.stream.delta",
    );
    s = reduceNotification(s, e, ctx).state;
  }
  expect(s.items).toHaveLength(1);
  expect(s.items[0].kind).toBe("turn_done");
});
