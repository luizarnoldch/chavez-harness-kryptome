import { describe, expect, test } from "bun:test";
import { createGitMcpServer } from "./git-mcp";

describe("createGitMcpServer", () => {
  test("does not throw", () => {
    const server = createGitMcpServer({
      cwd: process.cwd(),
      mode: "ask",
      getGitHubToken: async () => null,
    });
    expect(server).toBeTruthy();
  });
});
