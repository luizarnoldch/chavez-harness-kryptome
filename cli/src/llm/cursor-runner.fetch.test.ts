import { describe, expect, test } from "bun:test";
import {
  runCursorTurn,
  type CreateCursorAgent,
} from "./cursor-runner";

describe("runCursorTurn web_fetch", () => {
  test("local.customTools.web_fetch defined; cloud undefined", async () => {
    let createOptions: {
      cloud?: unknown;
      local?: { customTools?: Record<string, unknown> };
    } | null = null;
    const fakeAgent = {
      send: async () => ({
        stream: async function* () {},
        wait: async () => ({ status: "finished", result: "ok" }),
        cancel: async () => {},
      }),
      close: () => {},
      [Symbol.asyncDispose]: async () => {},
    };
    const createAgent: CreateCursorAgent = async (opts) => {
      createOptions = opts as typeof createOptions;
      return fakeAgent;
    };
    await runCursorTurn({
      prompt: "hi",
      model: "composer-2.5",
      auth: { authKind: "api_key", secret: "secret-key" },
      cwd: "/tmp/ws",
      executionMode: "ask",
      createAgent,
    });
    expect(createOptions?.cloud).toBeUndefined();
    expect(createOptions?.local?.customTools).toHaveProperty("web_fetch");
  });
});
