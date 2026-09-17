import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_JSON_ONLY } from "../chats/export-share";

const src = readFileSync(join(import.meta.dir, "headless.ts"), "utf8");

test("export/import/share skip ensureClient", () => {
  expect(src).toContain('action === "export" || action === "import" || action === "share"');
  expect(src).toContain("chatPortability");
  expect(src).toContain("EXPORT_USAGE");
  expect(src).toContain("IMPORT_JSON_ONLY");
  const intercept = src.indexOf(
    'if (group === "chat" && (action === "export" || action === "import" || action === "share")',
  );
  const ensure = src.indexOf("const client = await ensureClient();", intercept);
  expect(intercept).toBeGreaterThan(-1);
  expect(ensure).toBeGreaterThan(intercept);
});

test("portability path does not dispatch turns", () => {
  const start = src.indexOf("async function chatPortability");
  const slice = src.slice(start, start + 2500);
  expect(slice).not.toContain("agent.turn.request");
  expect(slice).not.toContain("ensureClient");
  expect(IMPORT_JSON_ONLY).toContain("chavez.chat.export");
});
