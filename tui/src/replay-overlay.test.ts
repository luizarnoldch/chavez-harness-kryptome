import { describe, expect, test } from "bun:test";
import { replayEscapeCloses, isReplayReadOnlyKey } from "./replay-overlay";
import { readFileSync } from "node:fs";

test("escape leaves replay without implying process exit", () => {
  expect(replayEscapeCloses("replay")).toBe("chat");
  expect(replayEscapeCloses("chat")).toBe("chat");
});

test("approve/compose keys are inert in replay", () => {
  expect(isReplayReadOnlyKey("y")).toBe(true);
  expect(isReplayReadOnlyKey("L")).toBe(false);
});

test("App replay path is read-only RPC", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(src).toContain('type: "chat.replay"');
  expect(src).toContain('ch === "L"');
  expect(src).not.toMatch(/view === "replay"[\s\S]*publishAgentTurn/);
});
