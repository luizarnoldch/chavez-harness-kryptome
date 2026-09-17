import { describe, expect, test } from "bun:test";
import {
  abortAllTurns,
  abortTurn,
  beginTurnAbort,
  endTurnAbort,
} from "./turn-abort";

describe("turn-abort", () => {
  test("beginTurnAbort + abortTurn marks signal aborted", () => {
    const ac = beginTurnAbort("chat-1");
    expect(ac.signal.aborted).toBe(false);
    expect(abortTurn("chat-1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    endTurnAbort("chat-1");
  });

  test("abortAllTurns aborts two chats", () => {
    const a = beginTurnAbort("chat-a");
    const b = beginTurnAbort("chat-b");
    const ids = abortAllTurns();
    expect(ids.sort()).toEqual(["chat-a", "chat-b"]);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    endTurnAbort("chat-a");
    endTurnAbort("chat-b");
  });

  test("endTurnAbort + abortTurn returns false", () => {
    beginTurnAbort("chat-3");
    endTurnAbort("chat-3");
    expect(abortTurn("chat-3")).toBe(false);
  });
});
