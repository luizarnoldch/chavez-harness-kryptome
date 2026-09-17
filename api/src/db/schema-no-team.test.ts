import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_PG_TABLES,
  FORBIDDEN_COLUMN_NAMES,
  FORBIDDEN_TABLE_NAMES,
  assertNoForbiddenTables,
  extractBlock,
  pgTableNames,
} from "../lib/no-team";

const schemaSrc = readFileSync(
  join(import.meta.dir, "schema.ts"),
  "utf8",
);

describe("schema freeze: no org", () => {
  test("no forbidden pgTable names", () => {
    expect(assertNoForbiddenTables(schemaSrc)).toEqual([]);
    for (const name of FORBIDDEN_TABLE_NAMES) {
      expect(schemaSrc).not.toMatch(
        new RegExp(`pgTable\\(\\s*["']${name}["']`),
      );
    }
  });

  test("every pgTable is in the allowlist (siblings may add share/diffs)", () => {
    for (const name of pgTableNames(schemaSrc)) {
      expect(ALLOWED_PG_TABLES as readonly string[]).toContain(name);
    }
  });

  test("user/session/workspaces have no org columns or product role", () => {
    const user = extractBlock(schemaSrc, "user");
    const session = extractBlock(schemaSrc, "session");
    const workspaces = extractBlock(schemaSrc, "workspaces");
    for (const block of [user, session, workspaces]) {
      for (const col of FORBIDDEN_COLUMN_NAMES) {
        expect(block).not.toContain(col);
      }
    }
    expect(user).not.toMatch(/\brole\b/);
    expect(session).not.toMatch(/activeOrganizationId|organizationId/);
    expect(workspaces).not.toMatch(/\bmembers\b|\brole\b/);
  });

  test("chat_messages.role is the only role column and is a message role", () => {
    const messages = extractBlock(schemaSrc, "chatMessages");
    expect(messages).toMatch(/role: text\("role"\)/);
    expect(messages).toMatch(/user \| assistant \| system \| tool/);
  });

  test("vault and workspaces are keyed by userId not org", () => {
    expect(schemaSrc).toContain("provider_credentials_user_provider_uidx");
    expect(schemaSrc).toContain("workspaces_user_path_uidx");
    const creds = extractBlock(schemaSrc, "providerCredentials");
    expect(creds).toMatch(/userId: text\("user_id"\)/);
    expect(creds).not.toMatch(/org/i);
  });
});
