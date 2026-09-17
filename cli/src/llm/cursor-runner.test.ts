import { describe, expect, test } from "bun:test";
import type { AgentTurnEvent } from "./agent-events";
import {
  CURSOR_AUTH_ERROR,
  classifyCursorError,
} from "./cursor-errors";
import { emitCursorEvent } from "./cursor-events";
import { runCursorTurn, type CreateCursorAgent } from "./cursor-runner";

describe("emitCursorEvent", () => {
  test("shell running → tool_start canonical bash", async () => {
    const events: AgentTurnEvent[] = [];
    await emitCursorEvent(
      {
        type: "tool_call",
        name: "shell",
        status: "running",
        call_id: "t1",
        args: { command: "ls" },
      },
      (ev) => {
        events.push(ev);
      },
    );
    expect(events).toEqual([
      {
        kind: "tool_start",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "ls" },
      },
    ]);
  });

  test("shell completed → tool_result done", async () => {
    const events: AgentTurnEvent[] = [];
    await emitCursorEvent(
      {
        type: "tool_call",
        name: "shell",
        status: "completed",
        call_id: "t1",
        result: { exitCode: 0 },
      },
      (ev) => {
        events.push(ev);
      },
    );
    expect(events[0]).toMatchObject({
      kind: "tool_result",
      toolCallId: "t1",
      toolName: "bash",
      status: "done",
    });
    expect((events[0] as { output: string }).output).toContain("exitCode");
  });

  test("assistant text → stream_delta", async () => {
    const events: AgentTurnEvent[] = [];
    await emitCursorEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      (ev) => {
        events.push(ev);
      },
    );
    expect(events).toEqual([{ kind: "stream_delta", text: "hello" }]);
  });
});

describe("classifyCursorError", () => {
  test("AuthenticationError becomes CURSOR_AUTH_ERROR without leaking a key", () => {
    const err = Object.assign(new Error("Invalid API key"), {
      name: "AuthenticationError",
    });
    const classified = classifyCursorError(err, "composer-2.5");
    expect(classified.message).toBe(CURSOR_AUTH_ERROR);
    expect(classified.message).not.toContain("key");
    expect(classified.message.toLowerCase()).not.toContain("sk-");
  });

  test("ConfigurationError names the model and discovered catalog", () => {
    const err = Object.assign(new Error("Bad model name"), {
      name: "ConfigurationError",
    });
    const classified = classifyCursorError(err, "nope-model");
    expect(classified.message).toContain("nope-model");
    expect(classified.message).toContain("discovered catalog");
  });
});

describe("runCursorTurn Agent.create contract", () => {
  test("never passes cloud and uses local.cwd", async () => {
    const creates: unknown[] = [];
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
      creates.push(opts);
      return fakeAgent;
    };
    const text = await runCursorTurn({
      prompt: "hi",
      model: "composer-2.5",
      auth: { authKind: "api_key", secret: "secret-key" },
      cwd: "/tmp/ws",
      createAgent,
    });
    expect(text).toBe("ok");
    expect(creates).toHaveLength(1);
    expect(creates[0]).not.toHaveProperty("cloud");
    expect(
      (creates[0] as { local: { cwd: string } }).local.cwd,
    ).toBe("/tmp/ws");
  });

  test("emits usage from wait() when present", async () => {
    const events: AgentTurnEvent[] = [];
    const fakeAgent = {
      send: async () => ({
        stream: async function* () {},
        wait: async () => ({
          status: "finished",
          result: "ok",
          usage: { inputTokens: 3, outputTokens: 1 },
        }),
        cancel: async () => {},
      }),
      close: () => {},
      [Symbol.asyncDispose]: async () => {},
    };
    const text = await runCursorTurn({
      prompt: "hi",
      model: "composer-2.5",
      auth: { authKind: "api_key", secret: "secret-key" },
      cwd: "/tmp/ws",
      createAgent: async () => fakeAgent,
      onEvent: async (ev) => {
        events.push(ev);
      },
    });
    expect(text).toBe("ok");
    expect(events.some((e) => e.kind === "usage" && e.provider === "cursor")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "result")).toBe(true);
  });

  test("missing usage still returns result text", async () => {
    const events: AgentTurnEvent[] = [];
    const fakeAgent = {
      send: async () => ({
        stream: async function* () {},
        wait: async () => ({ status: "finished", result: "ok" }),
        cancel: async () => {},
      }),
      close: () => {},
      [Symbol.asyncDispose]: async () => {},
    };
    const text = await runCursorTurn({
      prompt: "hi",
      model: "composer-2.5",
      auth: { authKind: "api_key", secret: "secret-key" },
      cwd: "/tmp/ws",
      createAgent: async () => fakeAgent,
      onEvent: async (ev) => {
        events.push(ev);
      },
    });
    expect(text).toBe("ok");
    expect(events.some((e) => e.kind === "usage")).toBe(false);
    expect(events.some((e) => e.kind === "result")).toBe(true);
  });
});
