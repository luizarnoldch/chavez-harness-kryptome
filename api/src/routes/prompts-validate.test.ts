import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPTS_CAP_ERROR,
  parseSavePromptInput,
  promptNameTaken,
} from "../llm/prompt-library";

test("route source never fires a turn", () => {
  const src = readFileSync(join(import.meta.dir, "prompts.ts"), "utf8");
  expect(src).not.toContain("agent.turn");
  expect(src).toContain("prompt.changed");
  expect(src).toContain("PROMPTS_MAX");
});

test("cap and taken strings frozen", () => {
  expect(PROMPTS_CAP_ERROR).toBe("Maximum 50 saved prompts");
  expect(promptNameTaken("x")).toBe("Prompt name already exists: x");
  expect(() => parseSavePromptInput({ name: "x", body: "" })).toThrow();
});
