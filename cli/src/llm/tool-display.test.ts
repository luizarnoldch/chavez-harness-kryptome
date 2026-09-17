import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_MAX_CHARS,
  redactSecrets,
  sanitizeToolInput,
  stringifyToolOutput,
  summarizeToolInput,
  toolHeadline,
  truncateToolText,
} from "./tool-display";

describe("truncateToolText", () => {
  test("leaves short text", () => {
    expect(truncateToolText("hi")).toBe("hi");
  });

  test("marks huge text", () => {
    const big = "x".repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const out = truncateToolText(big);
    expect(out.startsWith("x".repeat(TOOL_OUTPUT_MAX_CHARS))).toBe(true);
    expect(out).toContain("[truncated: showing");
    expect(out).toContain(`${TOOL_OUTPUT_MAX_CHARS + 50}`);
    expect(out.length).toBeLessThan(big.length);
  });
});

describe("sanitizeToolInput", () => {
  test("redacts secret keys and token patterns", () => {
    const s = sanitizeToolInput({
      file_path: "/repo/a.ts",
      api_key: "sk-ant-secretvalue",
      command: "curl -H ghp_abc1234567890 files",
    }) as Record<string, unknown>;
    expect(s.api_key).toBe("***");
    expect(s.file_path).toBe("/repo/a.ts");
    expect(String(s.command)).not.toContain("ghp_");
    expect(String(s.command)).toContain("***");
  });
});

describe("summarizeToolInput", () => {
  test("read path + range", () => {
    expect(
      summarizeToolInput("Read", { file_path: "src/auth.ts", offset: 10, limit: 40 }),
    ).toBe("src/auth.ts offset=10 limit=40");
  });

  test("grep query", () => {
    expect(summarizeToolInput("Grep", { pattern: "device code", path: "src" })).toBe(
      "device code in src",
    );
  });

  test("bash command redacted", () => {
    expect(summarizeToolInput("Bash", { command: "echo sk-ant-abc" })).toBe(
      "echo ***",
    );
  });

  test("fetch shows url", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com/a" })).toBe(
      "https://example.com/a",
    );
  });

  test("git tools", () => {
    expect(summarizeToolInput("git_status", {})).toBe("status");
    expect(summarizeToolInput("git_diff", { paths: ["a.ts"] })).toBe(
      "diff HEAD a.ts",
    );
    expect(
      summarizeToolInput("git_commit", {
        message: "feat: hello world this is a reasonably long commit message",
        paths: ["a.ts", "b.ts"],
      }),
    ).toContain("2 paths");
    expect(summarizeToolInput("git_push", { remote: "origin", branch: "feat" })).toBe(
      "push origin feat",
    );
    expect(summarizeToolInput("git_pr", { title: "Open PR" })).toBe("PR Open PR");
    expect(summarizeToolInput("git_pr_get", { number: 7 })).toBe("pr #7");
    expect(
      summarizeToolInput("git_pr_review", {
        number: 7,
        event: "APPROVE",
        body: "LGTM",
        token: "github_pat_SECRET",
      }),
    ).toBe("review APPROVE pr #7 LGTM");
    expect(summarizeToolInput("git_branch", { name: "feat-x" })).toBe(
      "branch feat-x",
    );
  });

  test("git_pr token is redacted", () => {
    const s = sanitizeToolInput({
      title: "x",
      token: "ghp_SECRETO",
      github_token: "ghp_SECRETO",
      pat: "ghp_SECRETO",
    }) as Record<string, unknown>;
    expect(s.token).toBe("***");
    expect(s.github_token).toBe("***");
    expect(s.pat).toBe("***");
    expect(JSON.stringify(s)).not.toContain("ghp_SECRETO");
  });

  test("git_pr_review summary never contains PAT", () => {
    const summary = summarizeToolInput("git_pr_review", {
      url: "https://github.com/acme/demo/pull/7",
      body: "Use github_pat_SECRET nowhere",
      pat: "github_pat_SECRET",
    });
    expect(summary).toContain("review COMMENT pr https://github.com/acme/demo/pull/7");
    expect(summary).not.toContain("github_pat_SECRET");
  });

  test("edit shows path not full file", () => {
    const s = summarizeToolInput("Edit", {
      file_path: "src/a.ts",
      old_string: "function X() {}",
      new_string: "function Y() {}",
    });
    expect(s.startsWith("src/a.ts")).toBe(true);
    expect(s).not.toContain("function X");
  });
});

describe("stringifyToolOutput", () => {
  test("truncates", () => {
    const out = stringifyToolOutput("y".repeat(TOOL_OUTPUT_MAX_CHARS + 1));
    expect(out).toContain("[truncated:");
  });
});

describe("toolHeadline", () => {
  test("running read", () => {
    expect(toolHeadline("Read", "running", { file_path: "README.md" })).toBe(
      "tool · read · running  README.md",
    );
  });
});

describe("redactSecrets", () => {
  test("does not eat normal text", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});
