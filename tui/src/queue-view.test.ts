import { describe, expect, test } from "bun:test";
import { QUEUE_POSITION_PREFIX } from "../../cli/src/queue/constants";
import type { QueueSnapshot } from "../../cli/src/queue/model";
import {
  formatQueueBadge,
  lastQueuedIdForChat,
} from "./queue-view";

function snap(
  items: QueueSnapshot["items"],
  reason: QueueSnapshot["reason"] = "enqueued",
): QueueSnapshot {
  return {
    workspaceId: "ws",
    running: null,
    items,
    reason,
  };
}

describe("formatQueueBadge", () => {
  test("item of active chat → queued #2", () => {
    const s = snap([
      {
        queueId: "q1",
        chatId: "other",
        position: 1,
        promptPreview: "a",
        createdAt: "t",
      },
      {
        queueId: "q2",
        chatId: "active",
        position: 2,
        promptPreview: "b",
        createdAt: "t",
      },
    ]);
    expect(formatQueueBadge(s, "active")).toBe("queued #2");
  });

  test("other chat with global queue length → QUEUE_POSITION_PREFIX", () => {
    const s = snap([
      {
        queueId: "q1",
        chatId: "other",
        position: 1,
        promptPreview: "a",
        createdAt: "t",
      },
    ]);
    expect(formatQueueBadge(s, "active")).toBe(`${QUEUE_POSITION_PREFIX}1`);
  });

  test("empty → null", () => {
    expect(formatQueueBadge(snap([]), "active")).toBeNull();
    expect(formatQueueBadge(null, "active")).toBeNull();
    expect(formatQueueBadge(snap([]), null)).toBeNull();
  });
});

describe("lastQueuedIdForChat", () => {
  test("takes last for chat", () => {
    const s = snap([
      {
        queueId: "first",
        chatId: "c1",
        position: 1,
        promptPreview: "a",
        createdAt: "t",
      },
      {
        queueId: "mid",
        chatId: "c2",
        position: 2,
        promptPreview: "b",
        createdAt: "t",
      },
      {
        queueId: "last",
        chatId: "c1",
        position: 3,
        promptPreview: "c",
        createdAt: "t",
      },
    ]);
    expect(lastQueuedIdForChat(s, "c1")).toBe("last");
    expect(lastQueuedIdForChat(s, "c2")).toBe("mid");
    expect(lastQueuedIdForChat(s, "none")).toBeNull();
  });
});
