import { describe, expect, test } from "bun:test";
import {
  QUEUE_ENQUEUED_LABEL,
  QUEUE_KIND,
  QUEUE_PROMOTED_LABEL,
  QUEUE_STATUS_QUEUED,
  classifyQueueNotify,
  formatWebQueueHint,
  isQueuedMessage,
} from "./queue";

describe("formatWebQueueHint", () => {
  test("hint position 2", () => {
    expect(formatWebQueueHint(2)).toBe("Encolado · posición 2");
  });
});

describe("isQueuedMessage", () => {
  test("true for queued_turn + queued", () => {
    expect(
      isQueuedMessage({ kind: QUEUE_KIND, queueStatus: QUEUE_STATUS_QUEUED }),
    ).toBe(true);
  });

  test("false for other kinds or cancelled", () => {
    expect(isQueuedMessage({ kind: QUEUE_KIND, queueStatus: "cancelled" })).toBe(
      false,
    );
    expect(isQueuedMessage({ kind: "tool" })).toBe(false);
    expect(isQueuedMessage(null)).toBe(false);
  });
});

describe("classifyQueueNotify", () => {
  test("enqueued returns kind (UI decides toast)", () => {
    const r = classifyQueueNotify(
      "agent.queue.updated",
      { reason: "enqueued" },
      "active",
    );
    expect(r).toEqual({
      kind: "queue_enqueued",
      title: QUEUE_ENQUEUED_LABEL,
    });
  });

  test("promoted other chat → kind + chatId", () => {
    const r = classifyQueueNotify(
      "agent.queue.updated",
      { reason: "promoted", running: { chatId: "other" } },
      "active",
    );
    expect(r).toEqual({
      kind: "queue_promoted",
      title: QUEUE_PROMOTED_LABEL,
      chatId: "other",
    });
  });

  test("promoted active chat → null (no toast)", () => {
    const r = classifyQueueNotify(
      "agent.queue.updated",
      { reason: "promoted", running: { chatId: "active" } },
      "active",
    );
    expect(r).toBeNull();
  });

  test("non-queue type → null", () => {
    expect(
      classifyQueueNotify("chat.stream.delta", { reason: "enqueued" }, null),
    ).toBeNull();
  });
});
