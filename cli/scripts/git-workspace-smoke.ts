#!/usr/bin/env bun
/**
 * Smoke Plan git-workspace — 12 Gherkin scenes. No LLM, no live GitHub.
 * Usage: bun run scripts/git-workspace-smoke.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalToolName } from "../src/llm/tool-names";
import { sanitizeToolInput, summarizeToolInput } from "../src/llm/tool-display";
import { classifyGitBash } from "../src/llm/git-bash";
import { gateGitTool } from "../src/llm/git-can-use";
import { formatGitApproval, gitApprovalPrompt } from "../src/llm/git-approval";
import {
  COMMIT_ON_PROTECTED,
  FORCE_PUSH_PROTECTED,
  GITHUB_UNLINKED,
  NOT_A_GIT_REPO,
  NO_FAKE_COMMIT,
  PLAN_GIT_DENIED,
  PR_REQUIRES_GITHUB_REMOTE,
  PUSH_REJECTED_PREFIX,
} from "../src/llm/git-constants";
import { createWorkBranch } from "../src/llm/git-branch";
import { commitWorkspace } from "../src/llm/git-commit";
import { detectGit } from "../src/llm/git-detect";
import { collectDiffVsHead } from "../src/llm/git-diff-head";
import { runGit } from "../src/llm/git-exec";
import { formatGitSnapshot } from "../src/llm/git-format";
import { denyForcePushToProtected } from "../src/llm/git-guard";
import { runGitAction } from "../src/llm/handle-git-rpc";
import { createPullRequest } from "../src/llm/git-pr";
import type { pushWorkspace } from "../src/llm/git-push";
import { collectGitSnapshot } from "../src/llm/git-status";
import { formatWatchLine } from "../src/llm/watch-format";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function initRepo(branch = "main"): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-smoke-"));
  await runGit(cwd, ["init", "-b", branch]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

async function countCommits(cwd: string): Promise<number> {
  const r = await runGit(cwd, ["rev-list", "--count", "HEAD"]);
  return Number(r.stdout.trim() || "0");
}

// 1. Status visible.
{
  const cwd = await initRepo("feat");
  writeFileSync(join(cwd, "dirty.ts"), "x\n");
  const snap = await collectGitSnapshot(cwd);
  assert(snap.isRepo, "1 isRepo");
  assert(snap.branch, "1 branch");
  assert(snap.dirty.length >= 1, "1 dirty");
  const formatted = formatGitSnapshot(snap);
  assert(formatted.includes(snap.branch || ""), "1 format branch");
  const watch = formatWatchLine({
    type: "workspace.git.snapshot",
    data: { snapshot: snap },
  });
  assert(watch?.includes(snap.branch || ""), "1 watch branch");
  assert(watch?.includes("dirty="), "1 watch dirty");
  console.log("ok  1 status visible");
}

// 2. Diff vs HEAD. (per-turn diffs of plan 6 are a different set)
{
  const cwd = await initRepo("feat");
  writeFileSync(join(cwd, "a.ts"), "two\n");
  const d = await collectDiffVsHead(cwd);
  assert(d.isRepo, "2 isRepo");
  assert(d.paths.includes("a.ts") || d.unified.includes("a.ts"), "2 path in diff");
  console.log("ok  2 diff vs HEAD");
}

// 3. Not a repo.
{
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-smoke-nongit-"));
  const snap = await collectGitSnapshot(cwd);
  assert(snap.isRepo === false, "3 isRepo false");
  assert(snap.message === NOT_A_GIT_REPO, "3 message");
  let threw = "";
  try {
    await commitWorkspace({ cwd, message: "x", mode: "user" });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(
    threw === NOT_A_GIT_REPO || threw === NO_FAKE_COMMIT,
    `3 commit throw got ${threw}`,
  );
  const action = await runGitAction({
    cwd,
    action: "commit",
    payload: { message: "x" },
    getGitHubToken: async () => null,
  });
  assert(action.ok === false, "3 rpc commit not ok");
  console.log("ok  3 not a repo");
}

// 4. Commit in ask — log intact until approve.
{
  const cwd = await initRepo("feat");
  writeFileSync(join(cwd, "b.ts"), "b\n");
  const g = gateGitTool("ask", "git_commit", { message: "x", paths: ["b.ts"] });
  assert(g.decision === "ask", "4 gate ask");
  const before = await countCommits(cwd);
  const prompt = gitApprovalPrompt(
    "git_commit",
    { message: "feat smoke", paths: ["b.ts"] },
    { branch: "feat" },
  );
  const formatted = formatGitApproval(prompt);
  assert(formatted.includes("feat smoke"), "4 message in approval");
  assert(formatted.includes("b.ts"), "4 paths in approval");
  assert((await countCommits(cwd)) === before, "4 log intact before approve");
  await commitWorkspace({ cwd, message: "feat smoke", mode: "user", paths: ["b.ts"] });
  assert((await countCommits(cwd)) === before + 1, "4 after approve +1");
  console.log("ok  4 ask log intact until approve");
}

// 5. Auto commit if user asked, on a work branch.
{
  const cwd = await initRepo("feat");
  writeFileSync(join(cwd, "c.ts"), "c\n");
  assert(
    gateGitTool("auto", "git_commit", { message: "x" }).decision === "allow",
    "5 auto allow",
  );
  await commitWorkspace({ cwd, message: "auto commit", mode: "auto" });
  const log = await runGit(cwd, ["log", "-1", "--pretty=%s"]);
  assert(log.stdout.trim() === "auto commit", "5 log");
  assert(
    canonicalToolName("mcp__chavez-git__git_commit") === "git_commit",
    "5 canonical",
  );
  console.log("ok  5 auto commit on work branch");
}

// 6. Plan does not commit.
{
  const g = gateGitTool("plan", "git_commit", { message: "x" });
  assert(g.decision === "deny", "6 deny");
  if (g.decision === "deny") assert(g.message === PLAN_GIT_DENIED, "6 PLAN_GIT_DENIED");
  assert(gateGitTool("plan", "git_pr", { title: "t" }).decision === "deny", "6 pr deny");
  assert(gateGitTool("plan", "git_status", {}).decision === "allow", "6 status allow");
  console.log("ok  6 plan does not commit");
}

// 7. Create branch.
{
  const cwd = await initRepo("main");
  const r = await createWorkBranch({ cwd, name: "feat-smoke" });
  assert(r.branch === "feat-smoke", "7 branch");
  assert((await detectGit(cwd)).branch === "feat-smoke", "7 detect");
  let threw = false;
  try {
    await createWorkBranch({ cwd, name: "main" });
  } catch {
    threw = true;
  }
  assert(threw, "7 main throw");
  assert((await detectGit(cwd)).branch === "feat-smoke", "7 still feat-smoke");
  console.log("ok  7 create branch");
}

// 8. Link GitHub — no token in chat.
{
  const cwd = await initRepo("feat");
  await runGit(cwd, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  let threw = "";
  try {
    await createPullRequest({ cwd, title: "t", token: null });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw === GITHUB_UNLINKED, `8 unlinked got ${threw}`);
  const summary = summarizeToolInput(
    "git_pr",
    sanitizeToolInput({ title: "x", token: "ghp_SECRETO" }),
  );
  assert(!summary.includes("ghp_SECRETO"), "8 token leaked in summary");
  console.log("ok  8 github unlinked / no token in chat");
}

// 9. Open PR.
{
  const cwd = await initRepo("feat");
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
  assert(pr.url === "https://github.com/acme/demo/pull/7", "9 url");
  assert(
    formatWatchLine({
      type: "github.pr.created",
      data: { url: pr.url },
    }) === "git · pr https://github.com/acme/demo/pull/7",
    "9 watch",
  );
  console.log("ok  9 open PR");
}

// 10. Push rejected — no PR.
{
  const cwd = await initRepo("feat");
  await runGit(cwd, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  let fetched = false;
  let threw = "";
  try {
    await createPullRequest({
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
    });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes("non-fast-forward"), "10 throw");
  assert(fetched === false, "10 fetch not called");
  console.log("ok  10 push rejected");
}

// 11. Auto guards.
{
  const cwd = await initRepo("feat");
  writeFileSync(join(cwd, ".env"), "K=1\n");
  mkdirSync(join(cwd, ".chavez"), { recursive: true });
  writeFileSync(join(cwd, ".chavez", "config.json"), "{}\n");
  let envThrew = false;
  try {
    await commitWorkspace({
      cwd,
      message: "nope",
      paths: [".env"],
      mode: "auto",
    });
  } catch {
    envThrew = true;
  }
  assert(envThrew, "11 .env");
  let vaultThrew = false;
  try {
    await commitWorkspace({
      cwd,
      message: "nope",
      paths: [".chavez/config.json"],
      mode: "auto",
    });
  } catch {
    vaultThrew = true;
  }
  assert(vaultThrew, "11 vault");
  assert(
    denyForcePushToProtected({ force: true, branch: "main" }) ===
      FORCE_PUSH_PROTECTED,
    "11 force",
  );
  assert(
    classifyGitBash("git push --force origin master").kind === "forbidden",
    "11 bash forbidden",
  );
  const main = await initRepo("main");
  writeFileSync(join(main, "z.ts"), "z\n");
  let prot = "";
  try {
    await commitWorkspace({ cwd: main, message: "nope", mode: "auto" });
  } catch (err) {
    prot = err instanceof Error ? err.message : String(err);
  }
  assert(prot === COMMIT_ON_PROTECTED, "11 protected");
  console.log("ok  11 auto guards");
}

// 12. Auth per user — covered by api/scripts/e2e-git-vault.ts
console.log("ok  12 skipped here (api e2e vault isolation)");

void PR_REQUIRES_GITHUB_REMOTE;
console.log("git-workspace-smoke ok");
