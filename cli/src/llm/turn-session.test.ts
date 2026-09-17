import { describe, expect, test } from "bun:test";
import {
  beginTurnSession,
  cancelSession,
  endTurnSession,
  getTurnSession,
  onThinkingEvent,
  steerSession,
} from "./turn-session";
import { peekFollowUp, takeFollowUp, STEER_NO_TURN } from "./steer";
import { finalizeThinking } from "./thinking";
import { TURN_CANCELLED as ABORT_MSG } from "./turn-abort";

describe("TurnSession", () => {
  test("steer delivered while stream open", async () => {
    const s = beginTurnSession({
      chatId: "c1",
      streamId: "s1",
      provider: "claude",
    });
    const ack = await steerSession("c1", "no toques tests");
    expect(ack.outcome).toBe("complete_delivered");
    expect(peekFollowUp("c1")).toBeNull();
    s.promptStream.close();
    endTurnSession("c1");
  });

  test("steer after close → follow-up, not a second session", async () => {
    const s = beginTurnSession({
      chatId: "c2",
      streamId: "s2",
      provider: "claude",
    });
    s.promptStream.close();
    const ack = await steerSession("c2", "espera");
    expect(ack.outcome).toBe("revert_to_followup");
    expect(takeFollowUp("c2")?.text).toBe("espera");
    endTurnSession("c2");
  });

  test("steer without session throws STEER_NO_TURN", async () => {
    await expect(steerSession("none", "x")).rejects.toThrow(STEER_NO_TURN);
  });

  test("cancel drops follow-up and aborts", async () => {
    beginTurnSession({ chatId: "c3", streamId: "s3", provider: "claude" });
    await steerSession("c3", "late-if-closed");
    getTurnSession("c3")!.promptStream.close();
    await steerSession("c3", "queued");
    expect(peekFollowUp("c3")?.text).toBe("queued");
    expect(cancelSession("c3")).toBe(true);
    expect(peekFollowUp("c3")).toBeNull();
    expect(getTurnSession("c3")!.abort.signal.aborted).toBe(true);
    endTurnSession("c3");
  });

  test("thinking does not land in assistantText", () => {
    const s = beginTurnSession({
      chatId: "c4",
      streamId: "s4",
      provider: "claude",
    });
    onThinkingEvent(s, { kind: "thinking_delta", text: "razon" });
    onThinkingEvent(s, { kind: "stream_delta", text: "hola" });
    expect(s.assistantText).toBe("hola");
    expect(finalizeThinking(s.thinking)?.text).toBe("razon");
    endTurnSession("c4");
  });

  test("frozen strings", () => {
    expect(ABORT_MSG).toBe("Turn cancelled");
    expect(STEER_NO_TURN).toBe("No turn running");
  });
});
