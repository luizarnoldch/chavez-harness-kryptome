import { describe, expect, test } from "bun:test";
import {
  ATTACH_CONTEXT_PREAMBLE,
  historyFromChatMessages,
  MAX_HISTORY_CHARS,
  promptWithHistory,
  TOOL_CONTEXT_PREAMBLE,
} from "./history";

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
});
