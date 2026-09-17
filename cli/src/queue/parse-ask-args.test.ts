import { describe, expect, test } from "bun:test";
import { parseAskArgs } from "./parse-ask-args";

describe("parseAskArgs", () => {
  test("positional chat + multi-word prompt", () => {
    expect(parseAskArgs(["chat1", "hello", "world"])).toEqual({
      chatId: "chat1",
      prompt: "hello world",
      promptName: null,
      noQueue: false,
      waitTimeoutMs: undefined,
      mode: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  test("--no-queue before or after chatId", () => {
    expect(parseAskArgs(["--no-queue", "chat1", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      promptName: null,
      noQueue: true,
      waitTimeoutMs: undefined,
      mode: undefined,
      provider: undefined,
      model: undefined,
    });
    expect(parseAskArgs(["chat1", "--no-queue", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      promptName: null,
      noQueue: true,
      waitTimeoutMs: undefined,
      mode: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  test("--wait-timeout space and equals forms", () => {
    expect(parseAskArgs(["--wait-timeout", "1500", "chat1", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      promptName: null,
      noQueue: false,
      waitTimeoutMs: 1500,
      mode: undefined,
      provider: undefined,
      model: undefined,
    });
    expect(parseAskArgs(["--wait-timeout=1500", "chat1", "p"])).toEqual({
      chatId: "chat1",
      prompt: "p",
      promptName: null,
      noQueue: false,
      waitTimeoutMs: 1500,
      mode: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  test("strips --mode/--provider/--model", () => {
    expect(
      parseAskArgs([
        "--mode",
        "plan",
        "--provider",
        "claude",
        "--model",
        "m1",
        "chat1",
        "hi",
      ]),
    ).toEqual({
      chatId: "chat1",
      prompt: "hi",
      promptName: null,
      noQueue: false,
      waitTimeoutMs: undefined,
      mode: "plan",
      provider: "claude",
      model: "m1",
    });
  });

  test("--prompt name expands via promptName + extra text", () => {
    expect(
      parseAskArgs(["chat1", "--prompt", "review", "also", "@src/a.ts"]),
    ).toEqual({
      chatId: "chat1",
      prompt: "also @src/a.ts",
      promptName: "review",
      noQueue: false,
      waitTimeoutMs: undefined,
      mode: undefined,
      provider: undefined,
      model: undefined,
    });
  });
});
