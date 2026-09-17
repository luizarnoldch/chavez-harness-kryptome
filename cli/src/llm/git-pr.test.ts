import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_UNLINKED,
  PR_REQUIRES_GITHUB_REMOTE,
  PUSH_REJECTED_PREFIX,
} from "./git-constants";
import { runGit } from "./git-exec";
import { createPullRequest } from "./git-pr";
import type { pushWorkspace } from "./git-push";

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-pr-"));
  await runGit(cwd, ["init", "-b", "feat"]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("createPullRequest", () => {
  test("non-github origin", async () => {
    const cwd = await initRepo();
    await runGit(cwd, ["remote", "add", "origin", "https://gitlab.com/org/repo.git"]);
    await expect(
      createPullRequest({
        cwd,
        title: "t",
        token: "tok",
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
      }),
    ).rejects.toThrow(PR_REQUIRES_GITHUB_REMOTE);
  });

  test("token null is GITHUB_UNLINKED", async () => {
    const cwd = await initRepo();
    await runGit(cwd, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    await expect(
      createPullRequest({ cwd, title: "t", token: null }),
    ).rejects.toThrow(GITHUB_UNLINKED);
  });

  test("push failure does not call GitHub", async () => {
    const cwd = await initRepo();
    await runGit(cwd, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    let fetched = false;
    await expect(
      createPullRequest({
        cwd,
        title: "t",
        token: "tok",
        pushImpl: (async () => {
          throw new Error(`${PUSH_REJECTED_PREFIX}non-fast-forward`);
        }) as typeof pushWorkspace,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("fetch should not run");
        },
      }),
    ).rejects.toThrow(/non-fast-forward/);
    expect(fetched).toBe(false);
  });

  test("push stub plus fetch 201 returns PR", async () => {
    const cwd = await initRepo();
    await runGit(cwd, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    const pr = await createPullRequest({
      cwd,
      title: "Hello",
      token: "tok",
      pushImpl: (async () => ({
        remote: "origin",
        branch: "feat",
        stdout: "ok",
      })) as typeof pushWorkspace,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/demo/pull/7",
            number: 7,
            title: "Hello",
          }),
          { status: 201 },
        )) as typeof fetch,
    });
    expect(pr.url).toBe("https://github.com/acme/demo/pull/7");
    expect(pr.number).toBe(7);
    expect(pr.head).toBe("feat");
    expect(pr.base).toBe("main");
  });
});
