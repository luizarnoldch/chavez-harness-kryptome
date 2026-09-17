import { describe, expect, test } from "bun:test";
import { emitClaudeResultUsage, type AgentTurnEvent } from "./claude-runner";

test("emits usage from a Claude result message", async () => {
  const events: AgentTurnEvent[] = [];
  await emitClaudeResultUsage(
    {
      type: "result",
      subtype: "success",
      result: "hi",
      total_cost_usd: 0.01,
      usage: { input_tokens: 8, output_tokens: 2 },
    },
    async (ev) => {
      events.push(ev);
    },
  );
  expect(events[0]).toMatchObject({ kind: "usage", provider: "claude" });
  if (events[0]!.kind !== "usage") throw new Error("expected usage");
  expect((events[0].raw.usage as { input_tokens: number }).input_tokens).toBe(8);
});

test("missing usage emits nothing and does not throw", async () => {
  const events: AgentTurnEvent[] = [];
  await emitClaudeResultUsage(
    { type: "result", subtype: "success", result: "hi" },
    async (ev) => {
      events.push(ev);
    },
  );
  expect(events).toEqual([]);
});
