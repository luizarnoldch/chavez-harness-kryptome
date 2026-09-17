import { describe, expect, test } from "bun:test";
import {
  mergeMcpLayers,
  parseMcpServersObject,
} from "./mcp-parse";

describe("mcp-parse", () => {
  test(".mcp.json stdio docs server", () => {
    const r = parseMcpServersObject(
      { mcpServers: { docs: { command: "npx", args: ["-y", "foo"] } } },
      ".mcp.json",
      "project",
    );
    expect(r.errors).toEqual([]);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]!.name).toBe("docs");
    expect(r.servers[0]!.config.transport).toBe("stdio");
    expect(r.servers[0]!.config.command).toBe("npx");
  });

  test("HTTP type", () => {
    const r = parseMcpServersObject(
      {
        mcpServers: {
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      },
      ".mcp.json",
      "project",
    );
    expect(r.servers[0]!.config.transport).toBe("http");
    expect(r.servers[0]!.config.url).toBe("https://example.com/mcp");
  });

  test("mcpServers absent → 0 servers, 0 errors", () => {
    const r = parseMcpServersObject({ other: true }, ".mcp.json", "project");
    expect(r.servers).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("mcpServers: { x: 1 } → error, 0 servers, no throw", () => {
    const r = parseMcpServersObject(
      { mcpServers: { x: 1 } },
      ".mcp.json",
      "project",
    );
    expect(r.servers).toEqual([]);
    expect(r.errors.length).toBe(1);
  });

  test("chavez-git collision → alias chavez-git-project", () => {
    const r = parseMcpServersObject(
      { mcpServers: { "chavez-git": { command: "echo" } } },
      ".mcp.json",
      "project",
    );
    expect(r.collisions).toEqual([
      { name: "chavez-git", alias: "chavez-git-project" },
    ]);
    expect(r.servers[0]!.name).toBe("chavez-git-project");
  });

  test("mergeMcpLayers: local overrides same name", () => {
    const project = parseMcpServersObject(
      { mcpServers: { docs: { command: "project-cmd" } } },
      ".mcp.json",
      "project",
    );
    const local = parseMcpServersObject(
      { mcpServers: { docs: { command: "local-cmd" } } },
      "~/.chavez/workspaces/x/mcp.json",
      "local",
    );
    const merged = mergeMcpLayers(project, local);
    expect(merged.servers).toHaveLength(1);
    expect(merged.servers[0]!.config.command).toBe("local-cmd");
    expect(merged.servers[0]!.layer).toBe("local");
  });
});
