import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpFromDisk } from "./mcp-load";

describe("mcp-load", () => {
  test("cwd with valid .mcp.json → 1 server", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-load-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { docs: { command: "npx", args: ["-y", "foo"] } },
      }),
    );
    const r = loadMcpFromDisk(dir, { localFile: join(dir, "no-local.json") });
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]!.name).toBe("docs");
  });

  test("NOT_JSON → errors length 1, servers 0, no throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-load-bad-"));
    writeFileSync(join(dir, ".mcp.json"), "NOT_JSON");
    const r = loadMcpFromDisk(dir, { localFile: join(dir, "no-local.json") });
    expect(r.servers).toHaveLength(0);
    expect(r.errors.length).toBe(1);
  });

  test("merge distinct names from .mcp.json and .cursor/mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-load-merge-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "a" } } }),
    );
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(
      join(dir, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { b: { command: "b" } } }),
    );
    const r = loadMcpFromDisk(dir, { localFile: join(dir, "no-local.json") });
    expect(r.servers.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  test("local file overrides same name", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-load-local-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "project" } } }),
    );
    const localFile = join(dir, "local-mcp.json");
    writeFileSync(
      localFile,
      JSON.stringify({ mcpServers: { docs: { command: "local" } } }),
    );
    const r = loadMcpFromDisk(dir, { localFile });
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]!.config.command).toBe("local");
    expect(r.servers[0]!.layer).toBe("local");
  });
});
