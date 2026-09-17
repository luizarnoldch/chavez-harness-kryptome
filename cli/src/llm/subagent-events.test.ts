import { describe, expect, test } from "bun:test";
import {
  eventsFromSdkTaskMessage,
  subagentStartFromToolUse,
} from "./subagent-events";

describe("subagent-events", () => {
  test("task_started → subagent_start with agentType", () => {
    const evs = eventsFromSdkTaskMessage({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "tu1",
      subagent_type: "Explore",
      description: "look around",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      kind: "subagent_start",
      subagentId: "t1",
      agentType: "Explore",
    });
  });

  test("task_notification completed → subagent_end done", () => {
    const evs = eventsFromSdkTaskMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "ok",
    });
    expect(evs[0]).toMatchObject({
      kind: "subagent_end",
      status: "done",
      summary: "ok",
    });
  });

  test("task_notification failed → error", () => {
    const evs = eventsFromSdkTaskMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "failed",
      summary: "boom",
    });
    expect(evs[0]).toMatchObject({ kind: "subagent_end", status: "error" });
  });

  test("tool_use Task → start", () => {
    const ev = subagentStartFromToolUse({
      id: "x",
      name: "Task",
      input: { description: "go", subagent_type: "general" },
    });
    expect(ev?.kind).toBe("subagent_start");
  });

  test("tool_use Read → null", () => {
    expect(subagentStartFromToolUse({ name: "Read" })).toBeNull();
  });

  test("unknown message → []", () => {
    expect(eventsFromSdkTaskMessage({ type: "assistant" })).toEqual([]);
  });
});
