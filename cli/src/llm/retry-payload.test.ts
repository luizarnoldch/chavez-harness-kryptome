import { describe, expect, test } from "bun:test";
import {
  retryContainsTools,
  retryPayloadFromMessages,
} from "./retry-payload";
import type { ChatRow } from "./turn-select";

function row(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
): ChatRow {
  return { id: crypto.randomUUID(), role, content, metadata: metadata ?? null };
}

describe("retryPayloadFromMessages", () => {
  test("copies prompt, mentions and attachments — not tools", () => {
    const messages = [
      row("user", "fix @src/a.ts", {
        streamId: "s1",
        mentions: ["src/a.ts"],
        attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "SNAP" }],
        checkpoint: {
          kind: "git",
          streamId: "s1",
          headSha: "a",
          commitSha: "c",
          treeSha: "t",
          branch: "main",
          paths: ["src/a.ts"],
          commitsCreated: [],
          hadBash: false,
          appliedMutations: true,
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      }),
      row("tool", "wrote a.ts", {
        streamId: "s1",
        toolCallId: "t1",
        toolName: "Write",
      }),
      row("assistant", "done", { streamId: "s1" }),
    ];
    const r = retryPayloadFromMessages(messages);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.prompt).toBe("fix @src/a.ts");
    expect(r.payload.mentions).toEqual(["src/a.ts"]);
    expect(r.payload.attachments).toEqual([
      { path: "src/a.ts", kind: "text", hydratedText: "SNAP" },
    ]);
    expect(r.payload.retryOfStreamId).toBe("s1");
    expect(retryContainsTools(r.payload)).toBe(false);
  });
});
