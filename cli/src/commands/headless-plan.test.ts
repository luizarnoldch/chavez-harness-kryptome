import { describe, expect, test } from "bun:test";
import { parsePlanArgv, PLAN_ARGV_USAGE } from "./plan-argv";

describe("parsePlanArgv", () => {
  test("list requires chatId", () => {
    expect(() => parsePlanArgv(["list"])).toThrow(PLAN_ARGV_USAGE);
    expect(parsePlanArgv(["list", "chat-1"])).toEqual({
      sub: "list",
      chatId: "chat-1",
      artifactId: undefined,
      stdin: false,
    });
  });

  test("apply accepts optional artifactId", () => {
    expect(parsePlanArgv(["apply", "chat-1"])).toEqual({
      sub: "apply",
      chatId: "chat-1",
      artifactId: undefined,
      stdin: false,
    });
    expect(parsePlanArgv(["apply", "chat-1", "art-9"])).toEqual({
      sub: "apply",
      chatId: "chat-1",
      artifactId: "art-9",
      stdin: false,
    });
  });

  test("frozen usage string", () => {
    expect(PLAN_ARGV_USAGE).toBe(
      "Uso: chavez headless chat plan <list|get|update|current|apply> <chatId> …",
    );
  });
});
