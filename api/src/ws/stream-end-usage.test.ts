import { describe, expect, test } from "bun:test";
import { prepareStreamEndMeta, shouldPersistAssistant } from "../llm/usage-persist";
import { USAGE_META_KIND } from "../llm/usage-codec";

test("persists assistant when usage exists even if content is empty", () => {
  const meta = prepareStreamEndMeta({
    kind: USAGE_META_KIND,
    provider: "claude",
    modelId: "claude-sonnet-4-6",
    usage: { usage: { input_tokens: 1 }, apiKey: "sk-ant-secret" },
  });
  expect(shouldPersistAssistant("", meta)).toBe(true);
  expect(JSON.stringify(meta)).not.toContain("sk-ant");
});

test("does not persist empty assistant without usage", () => {
  expect(shouldPersistAssistant("  ", {})).toBe(false);
});

test("persists assistant text without usage", () => {
  expect(shouldPersistAssistant("hello", {})).toBe(true);
});
