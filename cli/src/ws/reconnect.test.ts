import { describe, expect, test } from "bun:test";
import { reconnectDelayMs, reconnectDelayWithJitter } from "./reconnect";

describe("reconnectDelayMs", () => {
  test("exponential backoff capped at 8000", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(3)).toBe(4000);
    expect(reconnectDelayMs(4)).toBe(8000);
    expect(reconnectDelayMs(5)).toBe(8000);
  });
});

describe("reconnectDelayWithJitter", () => {
  test("rand=0 equals base; rand=1 adds 249", () => {
    expect(reconnectDelayWithJitter(0, 0)).toBe(500);
    expect(reconnectDelayWithJitter(0, 1)).toBe(500 + 249);
  });
});
