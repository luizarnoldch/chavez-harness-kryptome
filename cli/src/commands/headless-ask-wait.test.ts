import { describe, expect, test } from "bun:test";
import { onAskPush, timeoutError } from "./headless-ask-wait";
import { QUEUE_CI_TIMEOUT } from "../queue/constants";

describe("onAskPush", () => {
  test("enqueue → promoted → stream.end finishes", () => {
    let state = {
      queueId: "q1",
      chatId: "c1",
      promoted: false,
      finished: false as boolean,
      error: undefined as string | undefined,
    };
    state = onAskPush(state, {
      type: "agent.queue.updated",
      data: { reason: "promoted", changedQueueId: "q1" },
    });
    expect(state.promoted).toBe(true);
    expect(state.finished).toBe(false);
    state = onAskPush(state, {
      type: "chat.stream.end",
      data: { chatId: "c1" },
    });
    expect(state.finished).toBe(true);
    expect(state.error).toBeUndefined();
  });

  test("stream.end other chatId does NOT finish", () => {
    let state = {
      queueId: "q1",
      chatId: "c1",
      promoted: true,
      finished: false as boolean,
    };
    state = onAskPush(state, {
      type: "chat.stream.end",
      data: { chatId: "other" },
    });
    expect(state.finished).toBe(false);
  });

  test("timeoutError() is frozen string", () => {
    expect(timeoutError()).toBe(QUEUE_CI_TIMEOUT);
  });
});
