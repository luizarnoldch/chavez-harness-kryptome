import { describe, expect, test } from "bun:test";
import {
  QUEUE_FULL_ERROR,
  QUEUE_KIND,
  QUEUE_MAX_LENGTH,
  QUEUE_STATUS_CANCELLED,
  QUEUE_STATUS_DISPATCHED,
  QUEUE_STATUS_QUEUED,
} from "./constants";
import {
  TurnQueue,
  isQueuedHistoryRow,
  promptPreview,
  type QueueItem,
} from "./model";

function item(queueId: string, prompt = "p"): QueueItem {
  return {
    queueId,
    chatId: "c1",
    workspaceId: "ws1",
    prompt,
    createdAt: "2026-01-01T00:00:00.000Z",
    skipUserAppend: true,
  };
}

describe("TurnQueue", () => {
  test("enqueue two items → positions 1 and 2", () => {
    const q = new TurnQueue("ws1");
    expect(q.enqueue(item("a")).position).toBe(1);
    expect(q.enqueue(item("b")).position).toBe(2);
    expect(q.snapshot("enqueued").items[1]!.position).toBe(2);
  });

  test("cancel first promotes former #2 to #1; unknown id → null", () => {
    const q = new TurnQueue("ws1");
    q.enqueue(item("a"));
    q.enqueue(item("b"));
    expect(q.cancel("a")?.queueId).toBe("a");
    expect(q.snapshot("cancelled").items[0]!.position).toBe(1);
    expect(q.snapshot("cancelled").items[0]!.queueId).toBe("b");
    expect(q.cancel("missing")).toBeNull();
  });

  test("promote is FIFO", () => {
    const q = new TurnQueue("ws1");
    q.enqueue(item("A"));
    q.enqueue(item("B"));
    expect(q.promote()?.queueId).toBe("A");
    expect(q.peek()?.queueId).toBe("B");
    expect(q.promote()?.queueId).toBe("B");
    expect(q.promote()).toBeNull();
  });

  test("canEnqueue full at 20; ok at 19", () => {
    const q = new TurnQueue("ws1");
    for (let i = 0; i < QUEUE_MAX_LENGTH - 1; i++) {
      q.enqueue(item(`q${i}`));
    }
    expect(q.canEnqueue()).toEqual({ ok: true });
    q.enqueue(item("last"));
    expect(q.canEnqueue()).toEqual({ ok: false, error: QUEUE_FULL_ERROR });
  });
});

describe("isQueuedHistoryRow", () => {
  test("queued and cancelled true; dispatched and missing false", () => {
    expect(
      isQueuedHistoryRow({ kind: QUEUE_KIND, queueStatus: QUEUE_STATUS_QUEUED }),
    ).toBe(true);
    expect(
      isQueuedHistoryRow({
        kind: QUEUE_KIND,
        queueStatus: QUEUE_STATUS_CANCELLED,
      }),
    ).toBe(true);
    expect(
      isQueuedHistoryRow({
        kind: QUEUE_KIND,
        queueStatus: QUEUE_STATUS_DISPATCHED,
      }),
    ).toBe(false);
    expect(isQueuedHistoryRow(undefined)).toBe(false);
    expect(isQueuedHistoryRow(null)).toBe(false);
  });
});

describe("promptPreview", () => {
  test("collapses whitespace and truncates to 80", () => {
    expect(promptPreview("  hello   world  ")).toBe("hello world");
    const long = "x".repeat(100);
    const preview = promptPreview(long);
    expect(preview.length).toBe(81); // 80 chars + ellipsis
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.slice(0, 80)).toBe("x".repeat(80));
  });
});
