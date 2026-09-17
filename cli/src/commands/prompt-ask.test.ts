import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expandAskPrompt,
  parseAskArgs,
} from "../llm/prompt-library";

test("prompt.ts CRUD never requests a turn", () => {
  const src = readFileSync(join(import.meta.dir, "prompt.ts"), "utf8");
  expect(src).not.toContain("agent.turn");
  expect(src).toContain('"/prompts"');
});

test("ask --prompt expansion is body then extra including @", () => {
  const parsed = parseAskArgs([
    "chat-1",
    "--prompt",
    "review",
    "focus",
    "@src/auth.ts",
  ]);
  expect(parsed.promptName).toBe("review");
  const prompt = expandAskPrompt({
    libraryBody: "Review the PR",
    extra: parsed.extra,
  });
  expect(prompt).toBe("Review the PR\n\nfocus @src/auth.ts");
  expect(prompt).toContain("@src/auth.ts");
});
