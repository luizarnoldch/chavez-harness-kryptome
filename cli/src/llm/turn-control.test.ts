import { describe, expect, test } from "bun:test";
import { beginTurn, cancelTurn, endTurn, isTurnActive } from "./turn-control";

describe("turn-control", () => {
  test("begin + cancel current chat", () => {
    const signal = beginTurn("a");
    expect(isTurnActive("a")).toBe(true);
    expect(cancelTurn("a")).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  test("cancel of a different chat is a no-op", () => {
    beginTurn("a");
    expect(cancelTurn("b")).toBe(false);
    expect(isTurnActive("a")).toBe(true);
    endTurn("a");
    expect(isTurnActive()).toBe(false);
    expect(cancelTurn("a")).toBe(false);
  });

  test("endTurn clears so a new turn can start", () => {
    beginTurn("a");
    endTurn("a");
    expect(isTurnActive("a")).toBe(false);
    const signal = beginTurn("b");
    expect(signal.aborted).toBe(false);
    expect(isTurnActive("b")).toBe(true);
    endTurn("b");
  });
});
