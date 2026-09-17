import { beforeEach, describe, expect, test } from "bun:test";
import {
  getQueue,
  promoteAndDispatchPlan,
  drainPlan,
  resetQueuesForTests,
} from "./turn-queue";
import type { QueueItem } from "./queue-model";

function item(queueId: string): QueueItem {
  return {
    queueId,
    chatId: "c1",
    workspaceId: "ws1",
    prompt: "p",
    createdAt: "2026-01-01T00:00:00.000Z",
    skipUserAppend: true,
  };
}

describe("getQueue", () => {
  beforeEach(() => {
    resetQueuesForTests();
  });

  test("same key reuses instance", () => {
    const a = getQueue("u1", "ws1");
    const b = getQueue("u1", "ws1");
    expect(a).toBe(b);
  });

  test("different keys are isolated", () => {
    const a = getQueue("u1", "ws1");
    const b = getQueue("u1", "ws2");
    const c = getQueue("u2", "ws1");
    a.enqueue(item("only-a"));
    expect(b.length).toBe(0);
    expect(c.length).toBe(0);
    expect(a.length).toBe(1);
  });

  test("resetQueuesForTests clears registry", () => {
    const a = getQueue("u1", "ws1");
    a.enqueue(item("x"));
    resetQueuesForTests();
    const b = getQueue("u1", "ws1");
    expect(b).not.toBe(a);
    expect(b.length).toBe(0);
  });
});

describe("promoteAndDispatchPlan", () => {
  beforeEach(() => {
    resetQueuesForTests();
  });

  test("busy → enqueue", () => {
    const queue = getQueue("u1", "ws1");
    expect(
      promoteAndDispatchPlan({
        queue,
        busy: true,
        hasDaemon: true,
        enqueue: true,
      }),
    ).toEqual({ action: "enqueue" });
  });

  test("idle → dispatch", () => {
    const queue = getQueue("u1", "ws1");
    expect(
      promoteAndDispatchPlan({
        queue,
        busy: false,
        hasDaemon: true,
      }),
    ).toEqual({ action: "dispatch" });
  });

  test("ended → promote", () => {
    const queue = getQueue("u1", "ws1");
    queue.enqueue(item("a"));
    queue.enqueue(item("b"));
    const plan = drainPlan({ queue, busy: false, hasDaemon: true });
    expect(plan).toEqual({ action: "promote", item: expect.objectContaining({ queueId: "a" }) });
    expect(queue.peek()?.queueId).toBe("b");
  });

  test("cancel → skip that id on promote", () => {
    const queue = getQueue("u1", "ws1");
    queue.enqueue(item("a"));
    queue.enqueue(item("b"));
    queue.cancel("a");
    const plan = drainPlan({ queue, busy: false, hasDaemon: true });
    expect(plan).toEqual({
      action: "promote",
      item: expect.objectContaining({ queueId: "b" }),
    });
  });

  test("no daemon → no promote", () => {
    const queue = getQueue("u1", "ws1");
    queue.enqueue(item("a"));
    expect(drainPlan({ queue, busy: false, hasDaemon: false })).toEqual({
      action: "none",
      reason: "no_daemon",
    });
    expect(queue.length).toBe(1);
  });
});
