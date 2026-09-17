import { describe, expect, test } from "bun:test";
import { historyFromChatMessages } from "./history";
import { retryPayloadFromMessages } from "./retry-payload";

describe("retry does not replay tools", () => {
  test("history drops tool rows; payload has no toolCallId", () => {
    const messages = [
      {
        role: "user",
        content: "edit a.ts",
        metadata: {
          streamId: "s1",
          checkpoint: {
            kind: "git",
            streamId: "s1",
            headSha: "a",
            commitSha: "c",
            treeSha: "t",
            branch: "main",
            paths: ["a.ts"],
            commitsCreated: [],
            hadBash: false,
            appliedMutations: true,
            createdAt: "2026-09-16T00:00:00.000Z",
          },
        },
      },
      {
        role: "tool",
        content: "wrote",
        metadata: { streamId: "s1", toolCallId: "t1", toolName: "Write" },
      },
      { role: "assistant", content: "done", metadata: { streamId: "s1" } },
    ];
    const hist = historyFromChatMessages(messages, "edit a.ts");
    expect(hist.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(hist)).not.toMatch(/toolCallId/);
    const retry = retryPayloadFromMessages(messages as never);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(JSON.stringify(retry.payload)).not.toMatch(/toolCallId/);
    }
  });
});
