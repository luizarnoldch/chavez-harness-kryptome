import { describe, expect, test } from "bun:test";
import {
  ATTACH_CONTEXT_PREAMBLE,
  historyFromChatMessages,
  MAX_HISTORY_CHARS,
  promptWithHistory,
  TOOL_CONTEXT_PREAMBLE,
} from "./history";
import { SLASH_RESULT_KIND } from "./slash";

describe("historyFromChatMessages", () => {
  test("tool rows become system context and are not re-run", () => {
    const hist = historyFromChatMessages(
      [
        { role: "user", content: "run ls" },
        { role: "assistant", content: "ok" },
        {
          role: "tool",
          content: "noise",
          metadata: { toolName: "Bash", status: "done", output: "a.ts" },
        },
        { role: "user", content: "what did it print?" },
      ],
      "what did it print?",
    );
    const sys = hist.find((m) => m.role === "system");
    expect(sys).toBeTruthy();
    expect(sys!.content).toMatch(/Historical tool result \(do not re-run/);
    expect(sys!.content).toContain(TOOL_CONTEXT_PREAMBLE);
    expect(hist.some((m) => (m as { role: string }).role === "tool")).toBe(false);
    expect(JSON.stringify(hist)).not.toContain('"type":"tool_use"');
  });

  test("current user matching currentPrompt is dropped", () => {
    const hist = historyFromChatMessages(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "follow-up" },
      ],
      "follow-up",
    );
    expect(hist.map((m) => m.content)).toEqual(["hello", "hi"]);
  });

  test("historical attachments are inlined without reading disk", () => {
    const hist = historyFromChatMessages(
      [
        {
          role: "user",
          content: "explica @src/auth.ts",
          metadata: {
            attachments: [
              {
                path: "src/auth.ts",
                kind: "text",
                status: "ok",
                hydratedText: "export const TOKEN = 'SNAP-1';",
              },
            ],
          },
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "¿cuál era el token del attach?" },
      ],
      "¿cuál era el token del attach?",
    );
    expect(hist[0]!.content).toMatch(/SNAP-1/);
    expect(hist[0]!.content).toContain(ATTACH_CONTEXT_PREAMBLE);
    expect(hist[0]!.content).toMatch(/do not re-read disk/);
  });

  test("promptWithHistory concatenates prior + current without tool_use", () => {
    const hist = historyFromChatMessages(
      [
        { role: "user", content: "secret token is ZEBRA-42" },
        { role: "assistant", content: "ok noted" },
        { role: "tool", content: "noise" },
        { role: "user", content: "what was the token?" },
      ],
      "what was the token?",
    );
    const composed = promptWithHistory("what was the token?", hist);
    expect(composed).toMatch(/ZEBRA-42/);
    expect(composed).toMatch(/Current user message:\nwhat was the token\?/);
    expect(composed).not.toContain('"type":"tool_use"');
  });

  test("MAX_HISTORY_CHARS keeps the most recent", () => {
    const old = "O".repeat(MAX_HISTORY_CHARS);
    const hist = historyFromChatMessages(
      [
        { role: "user", content: old },
        { role: "assistant", content: "recent-keep" },
        { role: "user", content: "now" },
      ],
      "now",
    );
    expect(hist.some((m) => m.content.includes("recent-keep"))).toBe(true);
    expect(hist[hist.length - 1]!.content).toBe("recent-keep");
  });

  test("drops slash_result system rows so the LLM does not see /help", () => {
    const history = historyFromChatMessages(
      [
        { role: "user", content: "hola" },
        {
          role: "system",
          content: "Unknown command. Try /help",
          metadata: { kind: SLASH_RESULT_KIND, command: "unknown", ok: false },
        },
        { role: "assistant", content: "hola!" },
      ],
      "next",
    );
    expect(history.map((m) => m.content).join(" ")).not.toContain("/help");
    expect(history.some((m) => m.content === "hola")).toBe(true);
  });
});

describe("historyFromChatMessages compact", () => {
  test("after marker, old tools and old attaches are not in the prompt; current attach is", () => {
    const hist = historyFromChatMessages(
      [
        {
          id: "1",
          role: "user",
          content: "old",
          metadata: {
            attachments: [{ path: "old.ts", kind: "text", hydratedText: "OLD_BODY" }],
          },
        },
        {
          id: "2",
          role: "tool",
          content: "MEGAGREP".repeat(2000),
          metadata: { toolName: "grep" },
        },
        { id: "3", role: "assistant", content: "did grep" },
        {
          id: "c",
          role: "system",
          content: "contexto compactado",
          metadata: {
            kind: "compact_marker",
            summary: "User asked to search. Grep already ran.",
            compactedUntilMessageId: "3",
            lastDiff: "src/a.ts +3 −1",
            lastPlan: "1. apply patch",
          },
        },
        {
          id: "4",
          role: "user",
          content: "usa @src/a.ts",
          metadata: {
            attachments: [
              { path: "src/a.ts", kind: "text", hydratedText: "CURRENT_FULL" },
            ],
          },
        },
      ],
      "next",
    );
    const blob = hist.map((h) => h.content).join("\n");
    expect(blob).toMatch(/User asked to search/);
    expect(blob).toMatch(/src\/a\.ts \+3/);
    expect(blob).toMatch(/1\. apply patch/);
    expect(blob).toMatch(/CURRENT_FULL/);
    expect(blob).not.toMatch(/OLD_BODY/);
    expect(blob).not.toMatch(/MEGAGREPMEGAGREP/);
  });

  test("current prompt is not duplicated", () => {
    const hist = historyFromChatMessages(
      [
        { id: "1", role: "user", content: "hola" },
        { id: "2", role: "assistant", content: "ok" },
        { id: "3", role: "user", content: "ahora" },
      ],
      "ahora",
    );
    expect(hist.map((h) => h.content)).not.toContain("ahora");
    expect(promptWithHistory("ahora", hist)).toMatch(/Current user message:\nahora/);
  });

  test("usage metadata is not copied into LLM history content", () => {
    const history = historyFromChatMessages(
      [
        { role: "user", content: "hola" },
        {
          role: "assistant",
          content: "respuesta",
          metadata: {
            kind: "turn_usage",
            provider: "claude",
            modelId: "claude-sonnet-4-6",
            usage: { usage: { input_tokens: 99 }, apiKey: "sk-ant-SHOULD-NOT-APPEAR" },
          },
        },
      ],
      "next",
    );
    const dumped = JSON.stringify(history);
    expect(dumped).toContain("respuesta");
    expect(dumped).not.toContain("sk-ant");
    expect(dumped).not.toContain("input_tokens");
  });
});
