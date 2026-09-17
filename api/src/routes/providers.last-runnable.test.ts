import { describe, expect, test } from "bun:test";
import { patchLastRunnable } from "../llm/plan-artifact";

describe("patchLastRunnable", () => {
  test("ask snapshots lastRunnable", () => {
    expect(patchLastRunnable({ activeExecutionMode: "ask" }).lastRunnableExecutionMode).toBe("ask");
  });
  test("auto snapshots lastRunnable", () => {
    expect(patchLastRunnable({ activeExecutionMode: "auto" }).lastRunnableExecutionMode).toBe("auto");
  });
  test("plan does not overwrite lastRunnable", () => {
    const p = patchLastRunnable({ activeExecutionMode: "plan" });
    expect(p.lastRunnableExecutionMode).toBeUndefined();
    expect(p.activeExecutionMode).toBe("plan");
  });
});
