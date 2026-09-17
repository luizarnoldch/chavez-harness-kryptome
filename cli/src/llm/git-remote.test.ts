import { describe, expect, test } from "bun:test";
import { parseGitHubRemote } from "./git-remote";

describe("parseGitHubRemote", () => {
  test("ssh and https github urls", () => {
    const sshUrl = "git@" + "github.com:org/repo.git";
    const ssh = parseGitHubRemote(sshUrl);
    expect(ssh).toEqual({
      owner: "org",
      repo: "repo",
      host: "github.com",
      url: sshUrl,
    });
    const https = parseGitHubRemote("https://github.com/org/repo.git");
    expect(https).toEqual({
      owner: "org",
      repo: "repo",
      host: "github.com",
      url: "https://github.com/org/repo.git",
    });
  });

  test("gitlab is null", () => {
    expect(parseGitHubRemote("https://gitlab.com/org/repo")).toBeNull();
  });
});
