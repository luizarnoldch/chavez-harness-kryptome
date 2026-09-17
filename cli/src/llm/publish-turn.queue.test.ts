import { describe, expect, mock, test } from "bun:test";

mock.module("../api-client", () => ({
  apiFetch: async (path: string) => {
    if (path === "/providers") {
      return {
        activeProvider: "claude",
        activeModel: "claude-sonnet-4-6",
        activeExecutionMode: "ask",
        providers: {
          claude: { linked: true, runnable: true },
          cursor: { linked: false },
        },
      };
    }
    if (path === "/skills") return { skills: [] };
    if (path === "/providers/claude/credentials") {
      return { authKind: "api_key", secret: "test-secret" };
    }
    return {};
  },
}));

mock.module("./claude-runner", () => ({
  runClaudeTurn: async (input: {
    ci?: boolean;
    onEvent?: (ev: { kind: string; text?: string }) => Promise<void> | void;
  }) => {
    (globalThis as { __publishTurnCi?: boolean }).__publishTurnCi = input.ci;
    if ((globalThis as { __publishTurnThrow?: boolean }).__publishTurnThrow) {
      throw new Error("llm boom");
    }
    await input.onEvent?.({ kind: "stream_delta", text: "hi" });
    return "hi";
  },
}));

mock.module("./cursor-runner", () => ({
  runCursorTurn: async () => "",
}));

mock.module("./git-checkpoint", () => ({
  createTurnCheckpoint: async (_cwd: string, streamId: string) => ({
    streamId,
    kind: "none",
  }),
  finalizeCheckpoint: async (_cwd: string, checkpoint: unknown) => checkpoint,
}));

mock.module("./skills-load", () => ({
  loadSkillsFromDisk: () => ({
    user: [],
    project: [],
    local: [],
    applied: [],
    errors: [],
    collisions: [],
  }),
}));

import { emitTurnBookends } from "../queue/bookends";
import { publishAgentTurn } from "./publish-turn";
import type { ChavezWsClient } from "../ws/client";

function fakeClient(calls: Array<Record<string, unknown>>) {
  return {
    request: async (msg: Record<string, unknown>) => {
      calls.push(msg);
      if (msg.type === "chat.get") {
        return { ok: true, data: { messages: [] } };
      }
      return { ok: true, data: {} };
    },
  } as unknown as ChavezWsClient;
}

describe("emitTurnBookends", () => {
  test("start emits agent.turn.started with streamId and queueId", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(calls);
    await emitTurnBookends(client, {
      chatId: "c1",
      streamId: "s1",
      queueId: "q1",
      phase: "start",
      metadata: { executionMode: "ask" },
    });
    expect(calls).toEqual([
      {
        type: "agent.turn.started",
        chatId: "c1",
        streamId: "s1",
        queueId: "q1",
        metadata: { executionMode: "ask" },
      },
    ]);
  });

  test("end emits agent.turn.ended with status and queueId", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(calls);
    await emitTurnBookends(client, {
      chatId: "c1",
      streamId: "s1",
      queueId: "q1",
      phase: "end",
      status: "cancelled",
    });
    expect(calls).toEqual([
      {
        type: "agent.turn.ended",
        chatId: "c1",
        streamId: "s1",
        status: "cancelled",
        queueId: "q1",
      },
    ]);
  });

  test("client.request throw does not propagate", async () => {
    const client = {
      request: async () => {
        throw new Error("down");
      },
    } as unknown as ChavezWsClient;
    await emitTurnBookends(client, {
      chatId: "c1",
      streamId: "s1",
      phase: "start",
    });
  });
});

describe("publishAgentTurn queue bookends", () => {
  test("CI environment is forwarded to runClaudeTurn", async () => {
    const previousCi = process.env.CI;
    process.env.CI = "true";
    try {
      await publishAgentTurn({
        client: fakeClient([]),
        chatId: "c-ci",
        prompt: "hello",
        cwd: process.cwd(),
        token: "t",
        skipUserAppend: true,
        userSkills: [],
      });
      expect(
        (globalThis as { __publishTurnCi?: boolean }).__publishTurnCi,
      ).toBe(true);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  test("skipUserAppend:true → no chat.append; started before stream; ended on success", async () => {
    (globalThis as { __publishTurnThrow?: boolean }).__publishTurnThrow = false;
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(calls);
    await publishAgentTurn({
      client,
      chatId: "c1",
      prompt: "hello",
      cwd: process.cwd(),
      token: "t",
      skipUserAppend: true,
      queueId: "q-skip",
      userSkills: [],
    });
    const types = calls.map((c) => String(c.type));
    expect(types.includes("chat.append")).toBe(false);
    const started = types.indexOf("agent.turn.started");
    const streamStart = types.indexOf("chat.stream.start");
    const ended = types.indexOf("agent.turn.ended");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(streamStart).toBeGreaterThan(started);
    expect(ended).toBeGreaterThan(streamStart);
    const startMsg = calls.find((c) => c.type === "agent.turn.started");
    expect(startMsg?.queueId).toBe("q-skip");
    expect(typeof startMsg?.streamId).toBe("string");
    const endMsg = calls.find((c) => c.type === "agent.turn.ended");
    expect(endMsg?.queueId).toBe("q-skip");
    expect(endMsg?.status).toBe("finished");
  });

  test("skipUserAppend:false → chat.append present", async () => {
    (globalThis as { __publishTurnThrow?: boolean }).__publishTurnThrow = false;
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(calls);
    await publishAgentTurn({
      client,
      chatId: "c2",
      prompt: "hello",
      cwd: process.cwd(),
      token: "t",
      skipUserAppend: false,
      userSkills: [],
    });
    expect(calls.some((c) => c.type === "chat.append")).toBe(true);
  });

  test("agent.turn.ended emitted when LLM throws", async () => {
    (globalThis as { __publishTurnThrow?: boolean }).__publishTurnThrow = true;
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient(calls);
    await expect(
      publishAgentTurn({
        client,
        chatId: "c3",
        prompt: "boom",
        cwd: process.cwd(),
        token: "t",
        skipUserAppend: true,
        queueId: "q-err",
        userSkills: [],
      }),
    ).rejects.toThrow("llm boom");
    const types = calls.map((c) => String(c.type));
    expect(types.includes("agent.turn.started")).toBe(true);
    expect(types.includes("agent.turn.ended")).toBe(true);
    const endMsg = calls.find((c) => c.type === "agent.turn.ended");
    expect(endMsg?.queueId).toBe("q-err");
    (globalThis as { __publishTurnThrow?: boolean }).__publishTurnThrow = false;
  });
});
