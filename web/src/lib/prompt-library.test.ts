import { describe, expect, test } from "bun:test";
import {
  PROMPT_ASK_USAGE,
  PROMPT_BODY_ERROR,
  PROMPT_NAME_ERROR,
  PROMPT_PICKER_LIMIT,
  activePrompt,
  expandAskPrompt,
  filterPrompts,
  insertPromptAt,
  parseAskArgs,
  parseSavePromptInput,
  promptNameTaken,
  promptNotFound,
  resolveComposerTrigger,
  type SavedPrompt,
} from "./prompt-library";

function p(name: string, title = name, body = `${name} body`): SavedPrompt {
  return {
    id: name,
    name,
    title,
    body,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

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

  test("rejects bad name, empty body, oversize", () => {
    expect(() =>
      parseSavePromptInput({ name: "1bad", body: "x" }),
    ).toThrow(PROMPT_NAME_ERROR);
    expect(() =>
      parseSavePromptInput({ name: "ok", body: "  " }),
    ).toThrow(PROMPT_BODY_ERROR);
    expect(() =>
      parseSavePromptInput({ name: "Has Space", body: "x" }),
    ).toThrow(PROMPT_NAME_ERROR);
  });
});

describe("activePrompt + resolveComposerTrigger", () => {
  test("#query at end is a prompt trigger", () => {
    expect(activePrompt("please #rev")).toEqual({ start: 7, query: "rev" });
    expect(resolveComposerTrigger("please #rev")?.kind).toBe("prompt");
  });

  test("markdown header is not a trigger", () => {
    expect(activePrompt("# Título")).toBeNull();
    expect(activePrompt("# ")).toBeNull();
  });

  test("@ wins over an earlier #", () => {
    const t = resolveComposerTrigger("#rev look @src/a");
    expect(t?.kind).toBe("mention");
  });

  test("# after @ is prompt, not files", () => {
    const t = resolveComposerTrigger("@src/a.ts #rev");
    expect(t?.kind).toBe("prompt");
    expect(t?.query).toBe("rev");
  });

  test("slash at start wins over later # when cursor is on slash token", () => {
    const t = resolveComposerTrigger("/mode", 5);
    expect(t?.kind).toBe("slash");
  });
});

describe("filterPrompts", () => {
  const rows = [
    p("review", "Review PR", "look at the diff"),
    p("review-pr", "PR extra"),
    p("fix-tests", "Fix tests", "reproduce the failure"),
    ...Array.from({ length: 12 }, (_, i) => p(`other-${i}`)),
  ];

  test("refines by prefix and caps at 10", () => {
    const found = filterPrompts(rows, "rev");
    expect(found.every((x) => x.name.startsWith("review") || x.title.toLowerCase().includes("rev") || x.body.includes("rev") || x.name.includes("rev"))).toBe(true);
    expect(found.length).toBeLessThanOrEqual(PROMPT_PICKER_LIMIT);
    expect(found.map((x) => x.name)).toContain("review");
    expect(filterPrompts(rows, "").length).toBe(PROMPT_PICKER_LIMIT);
  });
});

describe("insertPromptAt mixes with @", () => {
  test("replaces #query with body and leaves room for @", () => {
    const text = "please #rev";
    const trigger = activePrompt(text)!;
    const next = insertPromptAt(text, trigger, text.length, "Review the diff");
    expect(next).toBe("please Review the diff");
    const mixed = `${next} @src/auth.ts`;
    expect(mixed).toContain("Review the diff");
    expect(mixed).toContain("@src/auth.ts");
    expect(resolveComposerTrigger(mixed)?.kind).toBe("mention");
  });
});

describe("parseAskArgs + expandAskPrompt", () => {
  test("raw ask unchanged", () => {
    expect(parseAskArgs(["chat1", "hello", "world"])).toEqual({
      chatId: "chat1",
      promptName: null,
      extra: "hello world",
    });
  });

  test("ask --prompt name plus extra @", () => {
    expect(
      parseAskArgs(["chat1", "--prompt", "review", "also", "@src/a.ts"]),
    ).toEqual({
      chatId: "chat1",
      promptName: "review",
      extra: "also @src/a.ts",
    });
    expect(
      expandAskPrompt({
        libraryBody: "Review the diff",
        extra: "also @src/a.ts",
      }),
    ).toBe("Review the diff\n\nalso @src/a.ts");
  });

  test("ask --prompt alone uses body", () => {
    expect(parseAskArgs(["chat1", "--prompt", "review"])).toEqual({
      chatId: "chat1",
      promptName: "review",
      extra: "",
    });
    expect(
      expandAskPrompt({ libraryBody: "Review the diff", extra: "" }),
    ).toBe("Review the diff");
  });

  test("missing chatId or --prompt value", () => {
    expect(() => parseAskArgs(["--prompt", "review"])).toThrow(PROMPT_ASK_USAGE);
    expect(() => parseAskArgs(["chat1", "--prompt"])).toThrow(PROMPT_ASK_USAGE);
  });
});

describe("error strings", () => {
  test("not found and taken include the name", () => {
    expect(promptNotFound("review")).toBe("Prompt not found: review");
    expect(promptNameTaken("review")).toBe("Prompt name already exists: review");
  });
});
