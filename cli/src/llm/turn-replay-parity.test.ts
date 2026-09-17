import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assembleTurnReplay, formatTurnReplay } from "./turn-replay";

const root = resolve(import.meta.dir, "../../..");

function body(rel: string): string {
  const txt = readFileSync(resolve(root, rel), "utf8");
  return txt.replace(/^\/\*\* keep-in-sync:.*\*\/\s*/, "");
}

test("keep-in-sync copies match", () => {
  const cli = body("cli/src/llm/turn-replay.ts");
  expect(body("api/src/llm/turn-replay.ts")).toBe(cli);
  expect(body("web/src/lib/turn-replay.ts")).toBe(cli);
});

test("CLI formatter output is the contract", () => {
  const messages = [
    {
      role: "user",
      content: "hola",
      metadata: {
        streamId: "s",
        executionMode: "plan",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
      },
    },
    {
      role: "assistant",
      content: "ok",
      metadata: { streamId: "s", modelId: "claude-sonnet-4-6" },
    },
  ];
  const a = assembleTurnReplay({ chatId: "c", messages });
  expect(a.ok).toBe(true);
  if (!a.ok) return;
  const text = formatTurnReplay(a.replay);
  expect(text).toContain("mode: plan");
  expect(text).toContain("model: claude-sonnet-4-6");
  expect(text.indexOf("## prompt")).toBeLessThan(text.indexOf("## assistant"));
  expect(text.indexOf("## assistant")).toBeLessThan(text.indexOf("## usage"));
});
