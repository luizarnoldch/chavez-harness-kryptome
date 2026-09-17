import { describe, expect, test } from "bun:test";
import {
  assembleChatExport,
  parseExportDocument,
  messagesForImport,
  importedChatTitle,
  shareViewFromExport,
  parseExportFormat,
  documentHasForbidden,
  EXPORT_FORMAT_ID,
  IMPORT_TITLE_PREFIX,
  SHARE_READONLY_BANNER,
  TOOL_SUMMARY_MAX_CHARS,
  DROP_ATTACH_KEYS,
} from "./export-share";

const SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAA";
const GHP = "ghp_secrettokenvalue";

function fixture() {
  return [
    {
      id: "u1",
      role: "user",
      content: `arregla @src/a.ts ${SECRET}`,
      createdAt: "2026-09-16T10:00:00.000Z",
      metadata: {
        streamId: "s1",
        attachments: [
          {
            path: "src/a.ts",
            kind: "text",
            status: "ok",
            hydratedText: `export const x = 1\nANTHROPIC_API_KEY=${SECRET}`,
          },
          { path: "logo.png", kind: "image", status: "ok", imageBase64: "AAAA" },
        ],
      },
    },
    {
      id: "t1",
      role: "tool",
      content: "ok",
      createdAt: "2026-09-16T10:00:01.000Z",
      metadata: {
        streamId: "s1",
        toolCallId: "tc1",
        toolName: "Bash",
        status: "done",
        input: { command: `cat .env && echo ${GHP}` },
        output: `${"x".repeat(TOOL_SUMMARY_MAX_CHARS + 80)}\n${GHP}`,
      },
    },
    {
      id: "a1",
      role: "assistant",
      content: `listo. token=${SECRET}`,
      createdAt: "2026-09-16T10:00:02.000Z",
      metadata: {
        streamId: "s1",
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4, total_cost_usd: 0.0012 },
      },
    },
  ];
}

describe("assembleChatExport", () => {
  test("markdown has user/assistant and tool/diff summaries; attaches are paths", () => {
    const { markdown, document } = assembleChatExport({
      title: "Fix auth",
      messages: fixture(),
      diffs: [
        {
          path: "src/a.ts",
          kind: "modified",
          status: "applied",
          additions: 3,
          deletions: 1,
          body: "THIS BODY MUST NOT APPEAR",
          preview: "--- a\n+++ b",
        },
      ],
    });
    expect(markdown.startsWith("# Fix auth")).toBe(true);
    expect(markdown).toContain("## user");
    expect(markdown).toContain("## assistant");
    expect(markdown).toContain("## tools");
    expect(markdown).toContain("tool · bash · done");
    expect(markdown).toContain("## diffs");
    expect(markdown).toContain("src/a.ts  modified  +3 −1");
    expect(markdown).toContain("@ src/a.ts  text  ok");
    expect(markdown).toContain("@ logo.png  image  ok");
    expect(markdown).not.toContain("imageBase64");
    expect(markdown).not.toContain("AAAA");
    expect(markdown).not.toContain("hydratedText");
    expect(markdown).not.toContain("THIS BODY MUST NOT APPEAR");
    expect(markdown).not.toContain(SECRET);
    expect(markdown).not.toContain(GHP);
    expect(document.format).toBe(EXPORT_FORMAT_ID);
    expect(document.chat).toEqual({ title: "Fix auth" });
    expect((document.chat as { userId?: string }).userId).toBeUndefined();
    expect(document.usage).toEqual([
      {
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 4, total_cost_usd: 0.0012 },
      },
    ]);
    const img = (document.messages[0]!.metadata as { attachments: Array<Record<string, unknown>> })
      .attachments[1]!;
    for (const k of DROP_ATTACH_KEYS) expect(img[k]).toBeUndefined();
    expect(documentHasForbidden(document, SECRET)).toBe(false);
    expect(documentHasForbidden(document, "imageBase64")).toBe(false);
  });

  test("JSON keeps raw usage per provider and does not flatten schemas", () => {
    const mixed = fixture();
    mixed.push({
      id: "a2",
      role: "assistant",
      content: "cursor turn",
      createdAt: "2026-09-16T10:00:03.000Z",
      metadata: {
        kind: "turn_usage",
        provider: "cursor",
        modelId: "composer",
        usage: { inputTokens: 20, outputTokens: 8, optimize_for: "cost" },
      },
    });
    const { document, markdown } = assembleChatExport({
      title: "mix",
      messages: mixed,
    });
    expect(document.usage).toHaveLength(2);
    expect(document.usage[0]!.usage).toHaveProperty("input_tokens", 12);
    expect(document.usage[1]!.usage).toHaveProperty("inputTokens", 20);
    expect(document.usage[1]!.usage).toHaveProperty("optimize_for", "cost");
    expect(JSON.stringify(document.usage[1])).not.toContain("effort");
    expect(markdown).not.toContain("input_tokens");
  });

  test("parse + import copies history and does not look like a tool rerun", () => {
    const { document } = assembleChatExport({
      title: "Fix auth",
      messages: fixture(),
    });
    const parsed = parseExportDocument(document);
    expect(parsed).not.toBeNull();
    const rows = messagesForImport(parsed!);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.role).toBe("tool");
    expect(rows[1]!.metadata).toMatchObject({ imported: true, status: "done" });
    expect(importedChatTitle("Fix auth")).toBe(`${IMPORT_TITLE_PREFIX}Fix auth`);
    expect(typeof rows[1]!.metadata).toBe("object");
  });

  test("share view has banner and no vault fields", () => {
    const view = shareViewFromExport(
      "Fix auth",
      "2026-09-16T10:00:00.000Z",
      fixture(),
    );
    expect(view.banner).toBe(SHARE_READONLY_BANNER);
    expect(JSON.stringify(view)).not.toContain("ciphertext");
    expect(JSON.stringify(view)).not.toContain("userId");
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test("parseExportFormat", () => {
    expect(parseExportFormat("md")).toBe("md");
    expect(parseExportFormat("markdown")).toBe("md");
    expect(parseExportFormat("json")).toBe("json");
    expect(parseExportFormat("xml")).toBeNull();
  });

  test("invalid document is rejected", () => {
    expect(parseExportDocument({ format: "nope", version: 1, chat: { title: "x" }, messages: [] })).toBeNull();
    expect(parseExportDocument({ hello: true })).toBeNull();
  });
});
