import { describe, expect, test } from "bun:test";
import {
  createSubagentBudget,
  trySpawnSubagent,
} from "./subagent-budget";
import {
  subagentBudgetExceeded,
  subagentDepthExceeded,
} from "./subagent-constants";

describe("subagent-budget", () => {
  test("8 spawns depth 1 ok; 9th budget exceeded", () => {
    let b = createSubagentBudget();
    for (let i = 0; i < 8; i++) {
      const r = trySpawnSubagent(b, 1);
      expect(r.ok).toBe(true);
      if (r.ok) b = r.next;
    }
    const ninth = trySpawnSubagent(b, 1);
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) {
      expect(ninth.message).toBe(subagentBudgetExceeded(8));
      expect(ninth.message).toBe(
        "Subagent budget exceeded (max 8 per turn)",
      );
    }
  });

  test("depth 3 → depth exceeded", () => {
    const r = trySpawnSubagent(createSubagentBudget(), 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(subagentDepthExceeded(2));
    }
  });

  test("depth 2 with spawned 0 → ok", () => {
    const r = trySpawnSubagent(createSubagentBudget(), 2);
    expect(r.ok).toBe(true);
  });
});
