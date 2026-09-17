import { describe, expect, test } from "bun:test";
import {
  QUEUE_DONE_LABEL,
  QUEUE_ENQUEUED_LABEL,
  QUEUE_PROMOTED_LABEL,
} from "./constants";
import { classifyQueueEvent } from "./notify";

describe("classifyQueueEvent", () => {
  test("delta → null", () => {
    expect(
      classifyQueueEvent("chat.stream.delta", { chatId: "c1", delta: "x" }, null),
    ).toBeNull();
    expect(
      classifyQueueEvent(
        "chat.thinking.delta",
        { chatId: "c1", delta: "…" },
        null,
      ),
    ).toBeNull();
  });

  test("promoted other chat → QUEUE_PROMOTED_LABEL", () => {
    const r = classifyQueueEvent(
      "agent.queue.updated",
      { reason: "promoted", running: { chatId: "other" } },
      "active",
    );
    expect(r).toEqual({
      title: QUEUE_PROMOTED_LABEL,
      sticky: false,
      chatId: "other",
    });
  });

  test("promoted active chat → null", () => {
    expect(
      classifyQueueEvent(
        "agent.queue.updated",
        { reason: "promoted", running: { chatId: "active" } },
        "active",
      ),
    ).toBeNull();
  });

  test("stream.end other chat → QUEUE_DONE_LABEL", () => {
    const r = classifyQueueEvent(
      "chat.stream.end",
      { chatId: "other", streamId: "s1" },
      "active",
    );
    expect(r).toEqual({
      title: QUEUE_DONE_LABEL,
      sticky: false,
      chatId: "other",
    });
  });

  test("enqueued → label", () => {
    const r = classifyQueueEvent(
      "agent.queue.updated",
      { reason: "enqueued" },
      null,
    );
    expect(r).toEqual({ title: QUEUE_ENQUEUED_LABEL, sticky: false });
  });
});
