import { describe, expect, test } from "bun:test";
import { assembleChatExport, CHAT_NOT_FOUND } from "./export-share";

const SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAA";

describe("export-load contracts", () => {
  test("assembleChatExport used by handler redacts secrets", () => {
    const { markdown, document } = assembleChatExport({
      title: "t",
      messages: [
        {
          role: "user",
          content: `hi ${SECRET}`,
          createdAt: "2026-09-16T10:00:00.000Z",
        },
      ],
    });
    expect(markdown).not.toContain(SECRET);
    expect(JSON.stringify(document)).not.toContain(SECRET);
  });

  test("loadExportDiffs without DB returns empty via assemble path when diffs omitted", () => {
    const { document, markdown } = assembleChatExport({
      title: "t",
      messages: [{ role: "user", content: "x", createdAt: "2026-09-16T10:00:00.000Z" }],
    });
    expect(document.diffs).toEqual([]);
    expect(markdown).not.toContain("## diffs");
  });

  test("foreign chat is not distinguished from missing (same error string)", () => {
    expect(CHAT_NOT_FOUND).toBe("Chat not found");
  });
});
