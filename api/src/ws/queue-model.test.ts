import { describe, expect, test } from "bun:test";
import {
  NO_DAEMON_ERROR,
  QUEUE_CI_BUSY,
  QUEUE_FULL_ERROR,
  QUEUE_KIND,
  QUEUE_MAX_LENGTH,
  QUEUE_STATUS_CANCELLED,
  QUEUE_STATUS_QUEUED,
} from "./queue-constants";
import {
  admitTurn,
  TurnQueue,
  type QueueItem,
} from "./queue-model";
import { hydrateFromMessages } from "./turn-queue";

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

describe("admitTurn", () => {
  test("no daemon → reject NO_DAEMON_ERROR", () => {
    expect(
      admitTurn({
        hasDaemon: false,
        busy: false,
        queueLength: 0,
        enqueue: true,
      }),
    ).toEqual({ action: "reject", error: NO_DAEMON_ERROR });
  });

  test("daemon idle → dispatch even when enqueue false", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: false,
        queueLength: 0,
        enqueue: false,
      }),
    ).toEqual({ action: "dispatch" });
  });

  test("busy + enqueue true + length 0 → enqueue", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: true,
        queueLength: 0,
        enqueue: true,
      }),
    ).toEqual({ action: "enqueue" });
  });

  test("busy + enqueue false → reject QUEUE_CI_BUSY", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: true,
        queueLength: 0,
        enqueue: false,
      }),
    ).toEqual({ action: "reject", error: QUEUE_CI_BUSY });
  });

  test("busy + length 20 → QUEUE_FULL_ERROR", () => {
    expect(
      admitTurn({
        hasDaemon: true,
        busy: true,
        queueLength: 20,
        enqueue: true,
      }),
    ).toEqual({ action: "reject", error: QUEUE_FULL_ERROR });
  });
});

describe("hydrateFromMessages", () => {
  test("2 queued, 1 cancelled ignored, chronological order", () => {
    const items = hydrateFromMessages(
      [
        {
          id: "later",
          chatId: "c1",
          content: "second",
          metadata: {
            kind: QUEUE_KIND,
            queueStatus: QUEUE_STATUS_QUEUED,
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "cancelled",
          chatId: "c1",
          content: "nope",
          metadata: {
            kind: QUEUE_KIND,
            queueStatus: QUEUE_STATUS_CANCELLED,
          },
          createdAt: "2026-01-01T00:00:01.500Z",
        },
        {
          id: "earlier",
          chatId: "c1",
          content: "first",
          metadata: {
            kind: QUEUE_KIND,
            queueStatus: QUEUE_STATUS_QUEUED,
            executionMode: "ask",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      "ws1",
    );
    expect(items.map((i) => i.queueId)).toEqual(["earlier", "later"]);
    expect(items[0]!.skipUserAppend).toBe(true);
    expect(items[0]!.executionMode).toBe("ask");
    expect(items[0]!.workspaceId).toBe("ws1");
  });
});

describe("TurnQueue FIFO", () => {
  test("enqueue / cancel / promote / full", () => {
    const q = new TurnQueue("ws1");
    expect(q.enqueue(item("a")).position).toBe(1);
    expect(q.enqueue(item("b")).position).toBe(2);
    expect(q.cancel("a")?.queueId).toBe("a");
    expect(q.promote()?.queueId).toBe("b");
    expect(q.promote()).toBeNull();

    for (let i = 0; i < QUEUE_MAX_LENGTH - 1; i++) {
      q.enqueue(item(`q${i}`));
    }
    expect(q.canEnqueue()).toEqual({ ok: true });
    q.enqueue(item("last"));
    expect(q.canEnqueue()).toEqual({ ok: false, error: QUEUE_FULL_ERROR });
  });
});
