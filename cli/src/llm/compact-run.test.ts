import { describe, expect, mock, test } from "bun:test";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: async function* () {
    yield {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Grep", id: "t1", input: { pattern: "x" } }],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      result: "SUMMARY_OK: searched src/ and planned apply.",
    };
  },
}));

mock.module("./claude-runner", () => ({
  buildClaudeEnv: () => ({ ANTHROPIC_API_KEY: "x" }),
}));

import { summarizeForCompact } from "./compact-run";

const messages = [
  { id: "0a", role: "user", content: "inicio" },
  { id: "0b", role: "assistant", content: "listo" },
  { id: "1", role: "user", content: "busca foo" },
  { id: "2", role: "tool", content: "match".repeat(5000), metadata: { toolName: "grep" } },
  { id: "3", role: "assistant", content: "encontré foo" },
  { id: "4", role: "user", content: "sigue" },
  { id: "5", role: "assistant", content: "ok" },
  {
    id: "6",
    role: "user",
    content: "mira @src/a.ts",
    metadata: {
      attachments: [{ path: "src/a.ts", kind: "text", hydratedText: "CURRENT_FULL" }],
    },
  },
];

describe("summarizeForCompact", () => {
  test("LLM path returns summary and does not include current attach in source window", async () => {
    const out = await summarizeForCompact({
      messages,
      trigger: "manual",
      excludeMessageIds: ["6"],
      sidecarDiffs: [
        {
          path: "src/a.ts",
          kind: "modified",
          status: "applied",
          additions: 1,
          deletions: 0,
          preview: "+ x",
        },
      ],
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      auth: { authKind: "api_key", secret: "sk-test" },
      llmEnabled: true,
    });
    expect(out.tooShort).toBe(false);
    expect(out.summary).toMatch(/SUMMARY_OK/);
    expect(out.lastDiff).toMatch(/src\/a\.ts/);
    expect(out.compactedUntilMessageId).not.toBe("6");
  });

  test("extractive path when llm disabled — still no tool re-exec (no fs)", async () => {
    const out = await summarizeForCompact({
      messages,
      trigger: "overflow",
      excludeMessageIds: ["6"],
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      auth: null,
      llmEnabled: false,
    });
    expect(out.method).toBe("extractive");
    expect(out.summary).toMatch(/Extractive compact/);
    expect(out.summary).not.toMatch(/CURRENT_FULL/);
  });
});
