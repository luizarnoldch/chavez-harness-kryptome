import { afterEach, describe, expect, test } from "bun:test";
import type { ChavezWsClient, WsPushMessage } from "../ws/client";
import { ASK_CI_INVALID, CI_TIMEOUT } from "./constants";
import { CiCliError } from "./errors";
import { ciExitCode, ciFailReason } from "./outcome";
import { prepareCiMode, selectRunnerMode, waitForTurn } from "./run";

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
