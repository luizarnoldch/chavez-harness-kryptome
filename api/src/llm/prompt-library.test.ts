import { describe, expect, test } from "bun:test";
import {
  PROMPT_BODY_ERROR,
  PROMPT_NAME_ERROR,
  PROMPT_TITLE_ERROR,
  parseSavePromptInput,
} from "./prompt-library";

describe("parseSavePromptInput", () => {
  test("lowercases name and defaults title to name", () => {
    const ok = parseSavePromptInput({
      name: "Review-PR",
      body: "Review this diff",
    });
    expect(ok.name).toBe("review-pr");
    expect(ok.title).toBe("review-pr");
    expect(ok.body).toBe("Review this diff");
  });

  test("rejects bad name and empty body", () => {
    expect(() =>
      parseSavePromptInput({ name: "1bad", body: "x" }),
    ).toThrow(PROMPT_NAME_ERROR);
    expect(() =>
      parseSavePromptInput({ name: "ok", body: "  " }),
    ).toThrow(PROMPT_BODY_ERROR);
  });

  test("rejects title over 120 chars", () => {
    expect(() =>
      parseSavePromptInput({
        name: "ok",
        title: "x".repeat(121),
        body: "body",
      }),
    ).toThrow(PROMPT_TITLE_ERROR);
  });
});
