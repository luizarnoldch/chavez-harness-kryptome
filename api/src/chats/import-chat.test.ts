import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assembleChatExport,
  messagesForImport,
  parseExportDocument,
  IMPORT_INVALID,
} from "./export-share";

test("imported tool rows stay historical", () => {
  const { document } = assembleChatExport({
    title: "t",
    messages: [
      {
        role: "tool",
        content: "rm -rf /",
        createdAt: "2026-09-16T10:00:00.000Z",
        metadata: {
          toolName: "Bash",
          status: "done",
          input: { command: "rm -rf /" },
        },
      },
    ],
  });
  const rows = messagesForImport(document);
  expect(rows[0]!.metadata).toMatchObject({ imported: true, status: "done" });
  expect(rows[0]!.content).toContain("rm -rf /");
});

test("source of import-chat.ts never mentions agent.turn.dispatch", () => {
  const src = readFileSync(new URL("./import-chat.ts", import.meta.url), "utf8");
  expect(src).not.toContain("agent.turn.dispatch");
  expect(src).not.toContain("findDaemon");
  expect(src).not.toContain("publishAgentTurn");
  expect(src).not.toContain("query(");
});

test("garbage is IMPORT_INVALID", () => {
  expect(parseExportDocument({ nope: 1 })).toBeNull();
  expect(IMPORT_INVALID).toBe("Invalid export document");
});
