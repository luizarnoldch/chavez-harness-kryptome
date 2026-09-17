import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assembleTurnReplay,
  formatTurnReplay,
  redactReplayText,
  TOOL_OUTPUT_MAX_CHARS,
  REPLAY_TURN_RUNNING,
  REPLAY_NO_TURN,
  NO_USAGE_TEXT,
  REPLAY_SECTION_ORDER,
  DUMP_HUB_HINT,
} from "./turn-replay";

const chatId = "c1";
const sid = "s-finished";

function fixture() {
  return [
    {
      id: "u1",
      role: "user",
      content: "arregla @src/a.ts sk-ant-api03-AAAAAAAAAAAAAAAA",
      createdAt: "2026-09-16T10:00:00.000Z",
      metadata: {
        streamId: sid,
        executionMode: "auto",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        effort: "medium",
        attachments: [
          {
            path: "src/a.ts",
            kind: "text",
            status: "ok",
            hydratedText: "export const x = 1\nANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAA",
          },
          { path: "logo.png", kind: "image", status: "ok", imageBase64: "AAAA" },
        ],
      },
    },
    {
      id: "t1",
      role: "tool",
      content: "ok",
      createdAt: "2026-09-16T10:00:01.000Z",
      metadata: {
        streamId: sid,
        toolCallId: "tc1",
        toolName: "Bash",
        status: "done",
        input: { command: "cat .env && echo ghp_secrettokenvalue" },
        output: `${"x".repeat(TOOL_OUTPUT_MAX_CHARS + 80)}\nghp_secrettokenvalue`,
      },
    },
    {
      id: "a1",
      role: "assistant",
      content: "listo. token=sk-ant-api03-AAAAAAAAAAAAAAAA",
      createdAt: "2026-09-16T10:00:02.000Z",
      metadata: {
        streamId: sid,
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4, total_cost_usd: 0.0012 },
      },
    },
  ];
}

describe("assembleTurnReplay", () => {
  test("ordered sections and header include mode+model", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: fixture(),
      diffs: [
        {
          streamId: sid,
          path: "src/a.ts",
          kind: "modified",
          status: "applied",
          additions: 3,
          deletions: 1,
          preview: "--- a\n+++ b\n+export const x = 1",
        },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    const idx = (h: string) => text.indexOf(h);
    expect(idx("## prompt")).toBeGreaterThan(-1);
    expect(idx("## attaches")).toBeGreaterThan(idx("## prompt"));
    expect(idx("## tools")).toBeGreaterThan(idx("## attaches"));
    expect(idx("## diffs")).toBeGreaterThan(idx("## tools"));
    expect(idx("## assistant")).toBeGreaterThan(idx("## diffs"));
    expect(idx("## usage")).toBeGreaterThan(idx("## assistant"));
    expect(text.startsWith(`turn ${sid}`)).toBe(true);
    expect(text).toContain("mode: auto");
    expect(text).toContain("model: claude-sonnet-4-6");
    expect(text).toContain("provider: claude");
    expect(REPLAY_SECTION_ORDER.join(",")).toBe(
      "prompt,attaches,tools,diffs,assistant,usage",
    );
  });

  test("redacts keys, .env values, vault; keeps tool output truncated", () => {
    const assembled = assembleTurnReplay({ chatId, messages: fixture() });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAA");
    expect(text).not.toContain("ghp_secrettokenvalue");
    expect(text).toContain("***");
    expect(text).toContain("ANTHROPIC_API_KEY=***");
    expect(text).not.toContain("imageBase64");
    expect(text).not.toContain("AAAA");
    expect(assembled.replay.tools[0]!.output.length).toBeLessThanOrEqual(
      TOOL_OUTPUT_MAX_CHARS + 80,
    );
    expect(assembled.replay.tools[0]!.output).toContain("[truncated:");
    expect(text).toContain("tool · bash · done");
  });

  test("does not treat a bash command as something to run", () => {
    const assembled = assembleTurnReplay({ chatId, messages: fixture() });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.replay.tools[0]!.input).toEqual({
      command: "cat .env && echo ***",
    });
    expect(typeof assembled.replay.tools[0]!.input).toBe("object");
  });

  test("running turn is not replayable", () => {
    const messages = fixture();
    messages[1]!.metadata = { ...(messages[1]!.metadata as object), status: "running" };
    messages.pop();
    const assembled = assembleTurnReplay({ chatId, messages, streamId: sid });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toBe(REPLAY_TURN_RUNNING);
  });

  test("awaiting_approval is still running", () => {
    const messages = fixture().slice(0, 2);
    messages[1]!.metadata = {
      ...(messages[1]!.metadata as object),
      status: "awaiting_approval",
    };
    const assembled = assembleTurnReplay({ chatId, messages, streamId: sid });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toBe(REPLAY_TURN_RUNNING);
  });

  test("empty chat", () => {
    const assembled = assembleTurnReplay({ chatId, messages: [] });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.error).toBe(REPLAY_NO_TURN);
  });

  test("usage missing is sin datos, not an error", () => {
    const messages = fixture();
    messages[2]!.metadata = { streamId: sid };
    const assembled = assembleTurnReplay({ chatId, messages });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.replay.usageDisplay).toBe(NO_USAGE_TEXT);
    expect(formatTurnReplay(assembled.replay)).toContain("## usage\nsin datos");
  });

  test("omits empty attaches/tools/diffs sections", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: [
        {
          role: "user",
          content: "hola",
          metadata: { streamId: "s2", executionMode: "ask" },
        },
        {
          role: "assistant",
          content: "ok",
          metadata: { streamId: "s2", modelId: "claude-sonnet-4-6" },
        },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("## attaches");
    expect(text).not.toContain("## tools");
    expect(text).not.toContain("## diffs");
    expect(text).toContain("mode: ask");
  });

  test("rejected diffs are omitted; body is never copied", () => {
    const assembled = assembleTurnReplay({
      chatId,
      messages: fixture(),
      diffs: [
        { streamId: sid, path: "a.ts", kind: "modified", status: "rejected", preview: "NO" },
        { streamId: sid, path: "b.ts", kind: "created", status: "applied", additions: 1, deletions: 0, preview: "hi", body: "SECRET_BODY=1" },
      ],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.replay.diffs.map((d) => d.path)).toEqual(["b.ts"]);
    const text = formatTurnReplay(assembled.replay);
    expect(text).not.toContain("SECRET_BODY");
    expect(text).not.toContain("a.ts  modified");
    expect(text).toContain("b.ts  created");
  });

  test("redactReplayText strips .env and keys", () => {
    expect(redactReplayText("sk-ant-api03-ABCDEFGHIJKLMNOP")).toBe("***");
    expect(redactReplayText("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
    expect(redactReplayText("token=ghp_abcdefghijklmnop")).toContain("***");
  });

  test("source never spawns or calls the LLM", () => {
    const src = readFileSync(new URL("./turn-replay.ts", import.meta.url), "utf8");
    expect(src).not.toContain("Bun.spawn");
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("runClaudeTurn");
    expect(src).not.toContain("runCursorTurn");
    expect(src).not.toContain("agent.turn.dispatch");
    expect(src).not.toContain('from "@anthropic-ai/claude-agent-sdk"');
  });

  test("hub hint is text dump, not JSON schema, not GitHub Action", () => {
    expect(DUMP_HUB_HINT).toContain("chat dump");
    expect(DUMP_HUB_HINT).not.toContain(".github");
    expect(DUMP_HUB_HINT).not.toContain("JSON schema");
  });
});
