import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChavezWsClient, WsPushMessage } from "../ws/client";
import { clearWorkspaceState, writeWorkspaceState } from "../workspace";
import { ASK_CI_INVALID, CI_TIMEOUT } from "./constants";
import { CiCliError } from "./errors";
import { ciExitCode, ciFailReason } from "./outcome";

class RunCiClient {
  static requests: Array<Record<string, unknown>> = [];
  static turnResponse: {
    ok: true;
    data: Record<string, unknown>;
  } = { ok: true, data: { queued: false } };
  private handlers = new Set<(msg: WsPushMessage) => void>();
  closed = false;

  async connect(): Promise<void> {}

  async bind(): Promise<{ ok: true; data: { workspace: { id: string } } }> {
    return { ok: true, data: { workspace: { id: "workspace-1" } } };
  }

  async request(message: Record<string, unknown> & { type: string }): Promise<{
    ok: true;
    data: Record<string, unknown>;
  }> {
    RunCiClient.requests.push(message);
    if (message.type === "session.create") {
      return { ok: true, data: { session: { id: "session-1" } } };
    }
    if (message.type === "chat.create") {
      return { ok: true, data: { chat: { id: "chat-1" } } };
    }
    if (message.type === "agent.turn.request") {
      const response = RunCiClient.turnResponse;
      if (!response.data.queued) {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({
              type: "chat.stream.end",
              data: { chatId: message.chatId },
              push: true,
              eventId: crypto.randomUUID(),
            });
          }
        });
      }
      return response;
    }
    return { ok: true, data: {} };
  }

  onPush(handler: (msg: WsPushMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
  }
}

mock.module("../ws/client", () => ({ ChavezWsClient: RunCiClient }));

import {
  prepareCiMode,
  runCiTurn,
  selectRunnerMode,
  waitForTurn,
} from "./run";

class FakeClient {
  private handlers = new Set<(msg: WsPushMessage) => void>();

  onPush(handler: (msg: WsPushMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  push(type: string, data?: unknown): void {
    const msg = {
      type,
      data,
      push: true,
      eventId: crypto.randomUUID(),
    } as WsPushMessage;
    for (const handler of this.handlers) handler(msg);
  }
}

const originalEnvMode = process.env.CHAVEZ_EXECUTION_MODE;

afterEach(() => {
  RunCiClient.requests = [];
  RunCiClient.turnResponse = { ok: true, data: { queued: false } };
  if (originalEnvMode == null) delete process.env.CHAVEZ_EXECUTION_MODE;
  else process.env.CHAVEZ_EXECUTION_MODE = originalEnvMode;
});

describe("selectRunnerMode", () => {
  test("espera al daemon vivo de otro proceso", () => {
    expect(
      selectRunnerMode({ existingAlive: true, existingPid: 99, selfPid: 1 }),
    ).toBe("client-wait");
  });

  test("ejecuta in-process si no hay daemon vivo", () => {
    expect(
      selectRunnerMode({ existingAlive: false, selfPid: 1 }),
    ).toBe("in-process");
  });

  test("ejecuta in-process si el pid es propio", () => {
    expect(
      selectRunnerMode({ existingAlive: true, existingPid: 7, selfPid: 7 }),
    ).toBe("in-process");
  });
});

describe("prepareCiMode", () => {
  test("rechaza ask con exit 2", async () => {
    process.env.CHAVEZ_EXECUTION_MODE = "";
    try {
      await prepareCiMode({
        modeFlag: "ask",
        timeoutMs: 1,
        prompt: "x",
        fetchProviders: async () => ({}),
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CiCliError);
      expect((error as CiCliError).exitCode).toBe(2);
      expect((error as Error).message).toBe(ASK_CI_INVALID);
    }
  });

  test("persiste auto explícito", async () => {
    process.env.CHAVEZ_EXECUTION_MODE = "";
    const modes: string[] = [];
    expect(
      await prepareCiMode({
        modeFlag: "auto",
        timeoutMs: 1,
        prompt: "x",
        fetchProviders: async () => ({}),
        putMode: async (mode) => {
          modes.push(mode);
        },
      }),
    ).toBe("auto");
    expect(modes).toEqual(["auto"]);
  });

  test("rechaza preferencia ask sin flag", async () => {
    process.env.CHAVEZ_EXECUTION_MODE = "";
    await expect(
      prepareCiMode({
        timeoutMs: 1,
        prompt: "x",
        fetchProviders: async () => ({ activeExecutionMode: "ask" }),
      }),
    ).rejects.toMatchObject({ exitCode: 2, message: ASK_CI_INVALID });
  });
});

describe("waitForTurn", () => {
  test("verification failed produce exit 1", async () => {
    const fake = new FakeClient();
    const waiting = waitForTurn({
      client: fake as unknown as ChavezWsClient,
      chatId: "chat-1",
      timeoutMs: 100,
    });
    fake.push("chat.stream.end", {
      chatId: "chat-1",
      verification: { status: "failed" },
    });
    const outcome = await waiting;
    expect(outcome.verificationStatus).toBe("failed");
    expect(ciExitCode(outcome)).toBe(1);
  });

  test("stream end limpio produce exit 0", async () => {
    const fake = new FakeClient();
    const waiting = waitForTurn({
      client: fake as unknown as ChavezWsClient,
      chatId: "chat-1",
      timeoutMs: 100,
    });
    fake.push("chat.stream.end", { chatId: "chat-1" });
    expect(ciExitCode(await waiting)).toBe(0);
  });

  test("stream end cancelado produce exit 1", async () => {
    const fake = new FakeClient();
    const waiting = waitForTurn({
      client: fake as unknown as ChavezWsClient,
      chatId: "chat-1",
      timeoutMs: 100,
    });
    fake.push("chat.stream.end", {
      chatId: "chat-1",
      status: "cancelled",
    });
    const outcome = await waiting;
    expect(outcome.streamError).toBe("turn cancelled");
    expect(ciExitCode(outcome)).toBe(1);
  });

  test("turn ended cancelado sin stream end produce exit 1", async () => {
    const fake = new FakeClient();
    const waiting = waitForTurn({
      client: fake as unknown as ChavezWsClient,
      chatId: "chat-1",
      timeoutMs: 100,
    });
    fake.push("agent.turn.ended", {
      chatId: "chat-1",
      status: "cancelled",
    });
    const outcome = await waiting;
    expect(outcome.streamEnd).toBe(false);
    expect(ciExitCode(outcome)).toBe(1);
  });

  test("vence el timeout", async () => {
    const fake = new FakeClient();
    const outcome = await waitForTurn({
      client: fake as unknown as ChavezWsClient,
      chatId: "chat-1",
      timeoutMs: 20,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.streamError).toBeNull();
    expect(ciFailReason(outcome)).toBe(CI_TIMEOUT);
  });

  test("formatea tool start como texto, no JSON", async () => {
    const fake = new FakeClient();
    const lines: string[] = [];
    const waiting = waitForTurn({
      client: fake as unknown as ChavezWsClient,
      chatId: "chat-1",
      timeoutMs: 100,
      onLine: (line) => lines.push(line),
    });
    fake.push("chat.tool.start", {
      chatId: "chat-1",
      toolName: "bash",
      status: "running",
    });
    fake.push("chat.stream.end", { chatId: "chat-1" });
    await waiting;
    expect(lines.some((line) => line.includes("tool ·"))).toBe(true);
    expect(lines.filter((line) => line.includes('{ "type":'))).toHaveLength(0);
  });
});

describe("runCiTurn", () => {
  test("client-wait solicita el turno sin permitir cola", async () => {
    const cwd = `/tmp/chavez-ci-client-${crypto.randomUUID()}`;
    writeWorkspaceState({
      path: cwd,
      pid: process.ppid,
      openedAt: new Date().toISOString(),
    });
    try {
      const result = await runCiTurn({
        prompt: "x",
        timeoutMs: 100,
        token: "test-token",
        cwd,
        chatId: "chat-1",
        fetchProviders: async () => ({ activeExecutionMode: "auto" }),
      });
      expect(result.exitCode).toBe(0);
      expect(
        RunCiClient.requests.find(
          (request) => request.type === "agent.turn.request",
        ),
      ).toMatchObject({
        enqueue: false,
        metadata: { ci: true, source: "ci" },
      });
    } finally {
      clearWorkspaceState(cwd);
    }
  });

  test("client-wait cancela una cola inesperada y reporta busy", async () => {
    const cwd = `/tmp/chavez-ci-queued-${crypto.randomUUID()}`;
    writeWorkspaceState({
      path: cwd,
      pid: process.ppid,
      openedAt: new Date().toISOString(),
    });
    RunCiClient.turnResponse = {
      ok: true,
      data: { queued: true, queueId: "queue-1" },
    };
    try {
      const result = await runCiTurn({
        prompt: "x",
        timeoutMs: 100,
        token: "test-token",
        cwd,
        chatId: "chat-1",
        fetchProviders: async () => ({ activeExecutionMode: "auto" }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.outcome.busy).toBe(true);
      expect(RunCiClient.requests).toContainEqual({
        type: "agent.queue.cancel",
        queueId: "queue-1",
      });
    } finally {
      clearWorkspaceState(cwd);
    }
  });

  test(
    "aborta un publish in-process bloqueado al vencer el timeout",
    async () => {
      let aborted = false;
      const result = await runCiTurn({
        prompt: "x",
        timeoutMs: 20,
        token: "test-token",
        cwd: `/tmp/chavez-ci-timeout-${crypto.randomUUID()}`,
        fetchProviders: async () => ({ activeExecutionMode: "auto" }),
        publish: async ({ abortController, signal }) =>
          new Promise<string>((_resolve, reject) => {
            const publishSignal = abortController?.signal ?? signal;
            publishSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("publish aborted"));
              },
              { once: true },
            );
          }),
      });

      expect(aborted).toBe(true);
      expect(result.outcome.timedOut).toBe(true);
      expect(ciFailReason(result.outcome)).toBe(CI_TIMEOUT);
    },
    500,
  );
});
