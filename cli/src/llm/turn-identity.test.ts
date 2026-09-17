import { describe, expect, test } from "bun:test";
import { turnUserMetadata, turnToolMetadata } from "./turn-identity";

describe("turn-identity", () => {
  test("turnUserMetadata always includes streamId", () => {
    const meta = turnUserMetadata({ streamId: "s1" });
    expect(meta.streamId).toBe("s1");
    expect(meta.executionMode).toBeUndefined();
  });

  test("does not invent executionMode ask when null/undefined", () => {
    const meta = turnUserMetadata({
      streamId: "s1",
      executionMode: null,
      provider: "claude",
      modelId: "claude-sonnet-4-6",
    });
    expect(meta.executionMode).toBeUndefined();
    expect(meta.provider).toBe("claude");
    expect(meta.modelId).toBe("claude-sonnet-4-6");
  });

  test("merges attachments from extra", () => {
    const meta = turnUserMetadata(
      { streamId: "s1", executionMode: "auto" },
      { attachments: [{ path: "a.ts" }], mentions: ["a.ts"] },
    );
    expect(meta.attachments).toEqual([{ path: "a.ts" }]);
    expect(meta.mentions).toEqual(["a.ts"]);
    expect(meta.streamId).toBe("s1");
    expect(meta.executionMode).toBe("auto");
  });

  test("turnToolMetadata stamps streamId", () => {
    expect(
      turnToolMetadata({ streamId: "s1" }, { input: { command: "ls" }, sdkName: "Bash" }),
    ).toEqual({
      input: { command: "ls" },
      sdkName: "Bash",
      streamId: "s1",
    });
  });
});
