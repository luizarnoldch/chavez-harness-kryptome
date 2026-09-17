import { describe, expect, test } from "bun:test";
import { formatGitApproval, gitApprovalPrompt } from "./git-approval";

describe("gitApprovalPrompt", () => {
  test("commit prompt includes message and paths", () => {
    const p = gitApprovalPrompt(
      "git_commit",
      { message: "feat: x", paths: ["src/a.ts", "src/b.ts"] },
      { branch: "feat-x" },
    );
    expect(p).toEqual({
      kind: "git_commit",
      message: "feat: x",
      paths: ["src/a.ts", "src/b.ts"],
      branch: "feat-x",
    });
    const formatted = formatGitApproval(p);
    expect(formatted).toContain("feat: x");
    expect(formatted).toContain("src/a.ts");
    expect(formatted).toContain("src/b.ts");
    expect(formatted).not.toContain("ghp_");
    expect(formatted).not.toContain("github_pat_");
  });

  test("format never includes tokens", () => {
    const p = gitApprovalPrompt("git_pr", {
      title: "Open PR",
      body: "see token ghp_NOT_A_TOKEN_IN_PROMPT",
      token: "ghp_SECRETO",
    });
    const formatted = formatGitApproval(p);
    expect(formatted).toContain("Open PR");
    expect(formatted).not.toContain("ghp_SECRETO");
  });
});
