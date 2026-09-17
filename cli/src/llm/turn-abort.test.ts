import { describe, expect, test } from "bun:test";
import { abortTurn, beginTurnAbort, endTurnAbort } from "./turn-abort";

describe("turn-abort", () => {
  test("beginTurnAbort + abortTurn marks signal aborted", () => {
    const ac = beginTurnAbort("chat-1");
    expect(ac.signal.aborted).toBe(false);
    expect(abortTurn("chat-1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    endTurnAbort("chat-1");
  });

  test("second beginTurnAbort aborts the previous controller", () => {
    const first = beginTurnAbort("chat-2");
    const second = beginTurnAbort("chat-2");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    endTurnAbort("chat-2");
  });

  test("endTurnAbort + abortTurn returns false", () => {
    beginTurnAbort("chat-3");
    endTurnAbort("chat-3");
    expect(abortTurn("chat-3")).toBe(false);
  });
});
