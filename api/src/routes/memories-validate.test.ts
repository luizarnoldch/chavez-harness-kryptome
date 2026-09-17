import { describe, expect, test } from "bun:test";
import {
  MEMORY_FACT_ERROR,
  USER_MEMORIES_CAP_ERROR,
  USER_MEMORIES_MAX,
  parseSaveMemoryInput,
} from "../llm/memory-constants";

describe("memories validate (pure)", () => {
  test("cap strings and default title", () => {
    expect(USER_MEMORIES_MAX).toBe(50);
    expect(USER_MEMORIES_CAP_ERROR).toBe("Maximum 50 user memories");
    expect(() => parseSaveMemoryInput({ fact: "" })).toThrow(MEMORY_FACT_ERROR);
    const ok = parseSaveMemoryInput({
      fact: "use bun for tests",
      workspaceId: "ws1",
    });
    expect(ok.title).toBe("use bun for tests");
    expect(ok.scope).toBe("workspace");
  });
});
