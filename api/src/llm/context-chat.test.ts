import { describe, expect, test } from "bun:test";
import { contextForMessages } from "./context-chat";

describe("contextForMessages", () => {
  test("short messages are ok", () => {
    const u = contextForMessages(
      [
        { id: "1", role: "user", content: "hola" },
        { id: "2", role: "assistant", content: "ok" },
      ],
      "claude",
      "claude-sonnet-4-6",
    );
    expect(u.level).toBe("ok");
    expect(u.modelId).toBe("claude-sonnet-4-6");
    expect(u.providerId).toBe("claude");
  });

  test("a 200k-char tool is stubbed to 400 and does not go critical", () => {
    const u = contextForMessages(
      [
        { id: "1", role: "user", content: "grep" },
        { id: "2", role: "tool", content: "z".repeat(200_000) },
        { id: "3", role: "assistant", content: "done" },
      ],
      "claude",
      "claude-sonnet-4-6",
    );
    expect(u.level).toBe("ok");
    expect(u.usedTokens).toBeLessThan(500);
  });
});
