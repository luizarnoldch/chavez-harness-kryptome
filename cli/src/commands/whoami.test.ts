import { describe, expect, test } from "bun:test";
import { formatWhoamiUsage } from "./whoami";
import { NO_USAGE_TEXT } from "../llm/usage-codec";

test("empty recent is sin datos", () => {
  expect(formatWhoamiUsage([])).toContain(NO_USAGE_TEXT);
  expect(formatWhoamiUsage(undefined)).toContain(NO_USAGE_TEXT);
});

test("prints display without keys", () => {
  const text = formatWhoamiUsage([
    {
      chatId: "abcd1234zzzz",
      provider: "claude",
      display: "in 12 · out 4 · $0.0012",
    },
  ]);
  expect(text).toContain("abcd1234");
  expect(text).toContain("in 12");
  expect(text).not.toContain("sk-ant");
  expect(text.toLowerCase()).not.toContain("effort");
});

test("refuses to format a leaked key", () => {
  expect(() =>
    formatWhoamiUsage([
      { chatId: "x", display: "in 1 sk-ant-api03-LEAK" },
    ]),
  ).toThrow();
});
