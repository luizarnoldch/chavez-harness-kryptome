import { describe, expect, test } from "bun:test";
import { parseAskArgs } from "./parse-ask-args";

describe("parseAskArgs", () => {
  test("positional chat + multi-word prompt", () => {
    expect(parseAskArgs(["chat1", "hello", "world"])).toEqual({
      chatId: "chat1",
      prompt: "hello world",
      noQueue: false,
      waitTimeoutMs: undefined,
    });
  });

  test("--no-queue before or after chatId", () => {
    expect(parseAskArgs(["--no-queue", "chat1", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      noQueue: true,
      waitTimeoutMs: undefined,
    });
    expect(parseAskArgs(["chat1", "--no-queue", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      noQueue: true,
      waitTimeoutMs: undefined,
    });
  });

  test("--wait-timeout space and equals forms", () => {
    expect(parseAskArgs(["--wait-timeout", "1500", "chat1", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      noQueue: false,
      waitTimeoutMs: 1500,
    });
    expect(parseAskArgs(["--wait-timeout=1500", "chat1", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      noQueue: false,
      waitTimeoutMs: 1500,
    });
  });
});
