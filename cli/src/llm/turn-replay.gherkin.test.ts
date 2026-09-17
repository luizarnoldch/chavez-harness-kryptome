import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assembleTurnReplay,
  formatTurnReplay,
  TOOL_OUTPUT_MAX_CHARS,
  REPLAY_TURN_RUNNING,
} from "./turn-replay";

const sid = "gherkin-1";
const messages = [
  {
    role: "user",
    content: "mira @.env y corre ls",
    metadata: {
      streamId: sid,
      executionMode: "auto",
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      attachments: [
        {
          path: ".env",
          kind: "text",
          status: "secret",
          hydratedText: "OPENAI_API_KEY=sk-ant-api03-NOTAREALKEYVALUE",
        },
      ],
    },
  },
  {
    role: "tool",
    content: "ok",
    metadata: {
      streamId: sid,
      toolCallId: "1",
      toolName: "Bash",
      status: "done",
      input: { command: "ls" },
      output: "x".repeat(TOOL_OUTPUT_MAX_CHARS + 10),
    },
  },
  {
    role: "assistant",
    content: "hecho",
    metadata: {
      streamId: sid,
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  },
];
const diffs = [
  {
    streamId: sid,
    path: "src/a.ts",
    kind: "modified" as const,
    status: "applied",
    additions: 1,
    deletions: 0,
    preview: "+x",
  },
];

describe("Gherkin Replay", () => {
  test("Abrir replay: prompt, attaches, tools, diffs, assistant, usage, modo, modelo en orden; Web/TUI coinciden", () => {
    const assembled = assembleTurnReplay({ chatId: "c", messages, diffs });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    const order = [
      "## prompt",
      "## attaches",
      "## tools",
      "## diffs",
      "## assistant",
      "## usage",
    ];
    let last = -1;
    for (const h of order) {
      const i = text.indexOf(h);
      expect(i).toBeGreaterThan(last);
      last = i;
    }
    expect(text).toContain("mode: auto");
    expect(text).toContain("model: claude-sonnet-4-6");
    expect(text).toContain("@ .env");
    expect(text).toContain("tool · bash · done");
    expect(text).toContain("src/a.ts  modified  +1 −0");
    expect(text).toContain("## assistant");
    expect(text).toContain("turn: in 3 · out 1");
    expect(formatTurnReplay(assembled.replay)).toBe(text);
  });

  test("Redacción: no API keys ni .env values; tool output sigue truncado", () => {
    const assembled = assembleTurnReplay({ chatId: "c", messages, diffs });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("sk-ant-api03-NOTAREALKEYVALUE");
    expect(text).toContain("OPENAI_API_KEY=***");
    expect(assembled.replay.tools[0]!.output).toContain("[truncated:");
    expect(assembled.replay.tools[0]!.output.length).toBeLessThanOrEqual(
      TOOL_OUTPUT_MAX_CHARS + 80,
    );
  });

  test("No re-ejecuta: replay es lectura y no corre bash", () => {
    const src = readFileSync(new URL("./turn-replay.ts", import.meta.url), "utf8");
    expect(src).not.toContain("Bun.spawn");
    expect(src).not.toMatch(/execSync|spawnSync|child_process/);
    const running = assembleTurnReplay({
      chatId: "c",
      streamId: sid,
      messages: [
        messages[0]!,
        {
          ...messages[1]!,
          metadata: { ...(messages[1]!.metadata as object), status: "running" },
        },
      ],
    });
    expect(running.ok).toBe(false);
    if (running.ok) return;
    expect(running.error).toBe(REPLAY_TURN_RUNNING);
  });

  test("CLI dump is text (CI, plan 25), not JSON schema", () => {
    const headless = readFileSync(
      resolve(import.meta.dir, "../commands/headless.ts"),
      "utf8",
    );
    expect(headless).toContain('action === "dump"');
    expect(headless).toContain("chat.replay");
    expect(headless).toContain("process.stdout.write");
    const usage = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(usage).toContain("chat dump");
    expect(usage).not.toMatch(/dump[\s\S]*JSON schema/);
  });
});
