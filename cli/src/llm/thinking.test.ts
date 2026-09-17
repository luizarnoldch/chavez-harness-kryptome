import { describe, expect, test } from "bun:test";
import {
  appendThinkingDelta,
  emptyThinkingAccum,
  finalizeThinking,
  isRedactedThinkingBlock,
  markThinkingOmitted,
  textDeltaFromStreamEvent,
  thinkingDeltaFromStreamEvent,
  thinkingFromMetadata,
  thinkingTextFromBlock,
  THINKING_COLLAPSED_LABEL,
  THINKING_MAX_CHARS,
  THINKING_OMITTED_LABEL,
} from "./thinking";

describe("thinking codec", () => {
  test("block thinking vs text never mix", () => {
    expect(thinkingTextFromBlock({ type: "thinking", thinking: "plan A" })).toBe(
      "plan A",
    );
    expect(thinkingTextFromBlock({ type: "text", text: "hello" })).toBeNull();
    expect(thinkingTextFromBlock({ type: "text", thinking: "nope" })).toBeNull();
  });

  test("redacted is omitted, not assistant text", () => {
    expect(isRedactedThinkingBlock({ type: "redacted_thinking", data: "x" })).toBe(
      true,
    );
    expect(thinkingTextFromBlock({ type: "redacted_thinking", data: "x" })).toBeNull();
    const acc = emptyThinkingAccum();
    markThinkingOmitted(acc);
    const fin = finalizeThinking(acc)!;
    expect(fin.omitted).toBe(true);
    expect(fin.text).toBeUndefined();
  });

  test("stream thinking_delta vs text_delta", () => {
    expect(
      thinkingDeltaFromStreamEvent({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
    ).toBe("hmm");
    expect(
      textDeltaFromStreamEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }),
    ).toBe("hi");
    expect(
      thinkingDeltaFromStreamEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }),
    ).toBeNull();
  });

  test("finalize empty → undefined; omitted survives empty text", () => {
    expect(finalizeThinking(emptyThinkingAccum())).toBeUndefined();
    const acc = emptyThinkingAccum();
    markThinkingOmitted(acc);
    appendThinkingDelta(acc, "should be ignored");
    expect(finalizeThinking(acc)?.omitted).toBe(true);
  });

  test("reload from metadata reconstructs or omits", () => {
    expect(
      thinkingFromMetadata({
        thinking: { kind: "thinking", omitted: false, text: "why" },
      })?.text,
    ).toBe("why");
    expect(
      thinkingFromMetadata({ thinking: { omitted: true } })?.omitted,
    ).toBe(true);
    expect(thinkingFromMetadata({ streamId: "x" })).toBeNull();
    expect(thinkingFromMetadata({ thinking: { omitted: false, text: "  " } })).toBeNull();
  });

  test("cap THINKING_MAX_CHARS", () => {
    const acc = emptyThinkingAccum();
    appendThinkingDelta(acc, "a".repeat(THINKING_MAX_CHARS + 50));
    expect(acc.text.length).toBe(THINKING_MAX_CHARS);
  });

  test("labels are frozen", () => {
    expect(THINKING_COLLAPSED_LABEL).toBe("razonamiento");
    expect(THINKING_OMITTED_LABEL).toBe("razonamiento omitido");
  });
});
