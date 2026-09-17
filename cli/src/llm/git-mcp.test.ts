import { describe, expect, test } from "bun:test";
import { GITHUB_UNLINKED } from "./git-constants";
import { createGitMcpServer } from "./git-mcp";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function handler(
  server: ReturnType<typeof createGitMcpServer>,
  name: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  const instance = server.instance as unknown as {
    _registeredTools: Record<
      string,
      { handler: (args: Record<string, unknown>) => Promise<ToolResult> }
    >;
  };
  return instance._registeredTools[name]!.handler;
}

describe("createGitMcpServer", () => {
  test("does not throw", () => {
    const server = createGitMcpServer({
      cwd: process.cwd(),
      mode: "ask",
      getGitHubToken: async () => null,
    });
    expect(server).toBeTruthy();
  });

  test("registers eight git tools", () => {
    const server = createGitMcpServer({
      cwd: process.cwd(),
      mode: "ask",
      getGitHubToken: async () => null,
    });
    const instance = server.instance as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    expect(Object.keys(instance._registeredTools)).toContain("git_pr_get");
    expect(Object.keys(instance._registeredTools)).toContain("git_pr_review");
    expect(Object.keys(instance._registeredTools)).toHaveLength(8);
  });

  test("git_pr_review returns html_url and never exposes token", async () => {
    const token = "github_pat_SUPER_SECRET";
    const server = createGitMcpServer({
      cwd: process.cwd(),
      mode: "ask",
      getGitHubToken: async () => token,
      fetchImpl: (async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/demo/pull/7#pullrequestreview-9",
            id: 9,
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const result = await handler(server, "git_pr_review")({
      url: "https://github.com/acme/demo/pull/7",
      body: "LGTM",
    });
    const text = result.content[0]!.text;
    expect(text).toContain(
      "https://github.com/acme/demo/pull/7#pullrequestreview-9",
    );
    expect(text).not.toContain(token);
    expect(result.isError).toBe(false);
  });

  test("git_pr_get returns a review brief with PR patches", async () => {
    const server = createGitMcpServer({
      cwd: process.cwd(),
      mode: "plan",
      getGitHubToken: async () => "github_pat_SECRET",
      fetchImpl: (async (url: Parameters<typeof fetch>[0]) => {
        if (String(url).endsWith("/files?per_page=100")) {
          return new Response(
            JSON.stringify([
              {
                filename: "src/a.ts",
                status: "modified",
                patch: "@@ -1 +1 @@\n-old\n+new",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            title: "Improve parser",
            body: "",
            head: { ref: "feat/parser" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const result = await handler(server, "git_pr_get")({
      owner: "acme",
      repo: "demo",
      number: 7,
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBe(false);
    expect(text).toContain("Improve parser");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("+new");
    expect(text).not.toContain("github_pat_SECRET");
  });

  test("git_pr_review without token returns GITHUB_UNLINKED", async () => {
    const server = createGitMcpServer({
      cwd: process.cwd(),
      mode: "ask",
      getGitHubToken: async () => null,
    });
    const result = await handler(server, "git_pr_review")({
      url: "https://github.com/acme/demo/pull/7",
      body: "LGTM",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(GITHUB_UNLINKED);
  });
});
