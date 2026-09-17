import { describe, expect, test } from "bun:test";
import {
  deliveredAck,
  dropFollowUp,
  followupAck,
  peekFollowUp,
  queueFollowUp,
  takeFollowUp,
  validateSteerText,
  STEER_EMPTY,
  STEER_MAX_CHARS,
  STEER_NO_TURN,
  STEER_TOO_LONG,
  STEER_UNSUPPORTED,
} from "./steer";

describe("steer", () => {
  test("empty / too long throw frozen strings", () => {
    expect(() => validateSteerText("  ")).toThrow(STEER_EMPTY);
    expect(() => validateSteerText("x".repeat(STEER_MAX_CHARS + 1))).toThrow(
      STEER_TOO_LONG,
    );
    expect(validateSteerText(" no toques tests ")).toBe("no toques tests");
  });

  test("follow-up queue is per chat and take is destructive", () => {
    queueFollowUp("c1", "a");
    queueFollowUp("c1", "b");
    expect(peekFollowUp("c1")?.text).toBe("b");
    expect(takeFollowUp("c1")?.text).toBe("b");
    expect(takeFollowUp("c1")).toBeNull();
    dropFollowUp("missing");
  });

  test("outcomes", () => {
    expect(deliveredAck("x").outcome).toBe("complete_delivered");
    expect(followupAck("x").outcome).toBe("revert_to_followup");
    expect(followupAck("x").reason).toBe(STEER_UNSUPPORTED);
    expect(STEER_NO_TURN).toBe("No turn running");
  });
});
