import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "protocol.ts"), "utf8");
const handlers = readFileSync(join(import.meta.dir, "handlers.ts"), "utf8");

describe("WS protocol has no client-supplied userId", () => {
  test("ClientMessage type has no userId/orgId", () => {
    const block = src.slice(
      src.indexOf("export type ClientMessage"),
      src.indexOf("export type ServerMessage"),
    );
    expect(block).not.toMatch(/\buserId\b/);
    expect(block).not.toMatch(/\borgId\b|\borganizationId\b|\bteamId\b/);
  });

  test("handlers use connection userId not msg.userId", () => {
    expect(handlers).not.toContain("msg.userId");
    expect(handlers).toContain("handleWsMessage(");
    expect(handlers).toMatch(/userId: string/);
  });
});
