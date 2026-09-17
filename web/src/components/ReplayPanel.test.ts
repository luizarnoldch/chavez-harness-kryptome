import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REPLAY_SECTION_ORDER } from "../lib/turn-replay";

test("panel is a pre of canonical text, not a turn dispatcher", () => {
  const src = readFileSync(new URL("./ReplayPanel.tsx", import.meta.url), "utf8");
  expect(src).toContain("replay-text");
  expect(src).toContain("read-only");
  expect(src).not.toContain("agent.turn.request");
  expect(src).not.toContain("publishAgentTurn");
  expect(src).not.toContain("Re-run");
  expect(REPLAY_SECTION_ORDER).toEqual([
    "prompt",
    "attaches",
    "tools",
    "diffs",
    "assistant",
    "usage",
  ]);
});
