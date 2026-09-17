import { describe, expect, test } from "bun:test";
import {
  mergeAssistantMetadata,
  shouldPersistCancelledAssistant,
} from "./thinking-meta";
import {
  STEER_EMPTY,
  STEER_MAX_CHARS,
  STEER_NO_TURN,
  STEER_TOO_LONG,
} from "./errors";
import { completeSteerResult, waitSteerResult } from "./pending";
import { ok, RESERVED_STREAM_TYPES } from "./protocol";

describe("thinking assistant metadata", () => {
  test("persists a cancelled assistant with empty content", () => {
    expect(
      shouldPersistCancelledAssistant({
        content: "",
        status: "cancelled",
      }),
    ).toBe(true);
  });

  test("does not persist a finished assistant without content or thinking", () => {
    expect(
      shouldPersistCancelledAssistant({
        content: "   ",
        status: "finished",
      }),
    ).toBe(false);
  });

  test("persists omitted thinking without assistant content", () => {
    expect(
      shouldPersistCancelledAssistant({
        metadata: { thinking: { omitted: true } },
      }),
    ).toBe(true);
  });

  test("defaults assistant stream status to finished", () => {
    expect(
      mergeAssistantMetadata({
        streamId: "stream-1",
        metadata: { thinking: { text: "reasoning" } },
      }),
    ).toEqual({
      streamId: "stream-1",
      status: "finished",
      thinking: { text: "reasoning" },
    });
  });
});

describe("steer protocol", () => {
  test("exports the shared steer validation contract", () => {
    expect(STEER_EMPTY).toBe("steer text is required");
    expect(STEER_NO_TURN).toBe("No turn running");
    expect(STEER_TOO_LONG).toBe("steer text exceeds 4000 characters");
    expect(STEER_MAX_CHARS).toBe(4000);
  });

  test("reserves thinking stream event types", () => {
    expect(RESERVED_STREAM_TYPES).toContain("chat.thinking.delta");
    expect(RESERVED_STREAM_TYPES).toContain("chat.thinking.end");
  });

  test("completes a pending steer response by request id", async () => {
    const waiting = waitSteerResult("steer-1", 50);
    const reply = ok("agent.turn.steer", "steer-1", { outcome: "accepted" });

    expect(completeSteerResult("steer-1", reply)).toBe(true);
    await expect(waiting).resolves.toEqual(reply);
    expect(completeSteerResult("steer-1", reply)).toBe(false);
  });

  test("times out a pending steer response", async () => {
    await expect(waitSteerResult("steer-timeout", 1)).resolves.toEqual({
      type: "agent.turn.steer",
      id: "steer-timeout",
      ok: false,
      error: "Steer timed out",
    });
  });
});
