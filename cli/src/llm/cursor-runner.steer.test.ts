import { describe, expect, test } from "bun:test";
import type { AgentTurnEvent } from "./agent-events";
import { runCursorTurn, type CreateCursorAgent } from "./cursor-runner";
import { TURN_CANCELLED } from "./turn-abort";

function fakeAgent(run: {
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{ status: string; result?: string | null }>;
  cancel: () => Promise<void>;
  steer?: (text: string) => Promise<"complete_delivered" | "revert_to_followup">;
}) {
  return {
    send: async () => run,
    close: () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

function baseInput(createAgent: CreateCursorAgent) {
  return {
    prompt: "hi",
    model: "composer-2.5",
    auth: { authKind: "api_key" as const, secret: "secret-key" },
    cwd: "/tmp/ws",
    createAgent,
  };
}

describe("runCursorTurn steer/cancel handle", () => {
  test("emits thinking separately and exposes Cursor steer", async () => {
    const events: AgentTurnEvent[] = [];
    const steered: string[] = [];
    let ready:
      | {
          cancel: () => Promise<void>;
          steer?: (
            text: string,
          ) => Promise<"complete_delivered" | "revert_to_followup">;
        }
      | undefined;
    const run = {
      stream: async function* () {
        yield { type: "thinking", text: "reasoning" };
      },
      wait: async () => ({ status: "finished", result: "answer" }),
      cancel: async () => {},
      steer: async (text: string) => {
        steered.push(text);
        return "complete_delivered" as const;
      },
    };

    const result = await runCursorTurn({
      ...baseInput(async () => fakeAgent(run)),
      onEvent: (event) => {
        events.push(event);
      },
      onRunReady: (handle) => {
        ready = handle;
      },
    });

    expect(result).toBe("answer");
    expect(events).toContainEqual({ kind: "thinking_delta", text: "reasoning" });
    expect(
      events.some(
        (event) =>
          event.kind === "stream_delta" &&
          "text" in event &&
          event.text === "reasoning",
      ),
    ).toBe(false);
    expect(await ready?.steer?.("redirect")).toBe("complete_delivered");
    expect(steered).toEqual(["redirect"]);
  });

  test("leaves steer undefined when the SDK run cannot steer", async () => {
    let ready:
      | {
          cancel: () => Promise<void>;
          steer?: (
            text: string,
          ) => Promise<"complete_delivered" | "revert_to_followup">;
        }
      | undefined;
    const run = {
      stream: async function* () {},
      wait: async () => ({ status: "finished", result: "answer" }),
      cancel: async () => {},
    };

    await runCursorTurn({
      ...baseInput(async () => fakeAgent(run)),
      onRunReady: (handle) => {
        ready = handle;
      },
    });

    expect(ready).toBeDefined();
    expect(ready?.steer).toBeUndefined();
  });

  test("cancelled wait throws the shared TURN_CANCELLED message", async () => {
    const run = {
      stream: async function* () {},
      wait: async () => ({ status: "cancelled" }),
      cancel: async () => {},
    };

    await expect(
      runCursorTurn(baseInput(async () => fakeAgent(run))),
    ).rejects.toThrow(TURN_CANCELLED);
  });
});
