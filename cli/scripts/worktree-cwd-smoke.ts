#!/usr/bin/env bun
/**
 * Smoke worktree-cwd — Gherkin scenes. No LLM, no GitHub.
 * Usage: bun run scripts/worktree-cwd-smoke.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEffectiveCwd,
  initEffectiveCwd,
} from "../src/llm/effective-cwd";
import { handleWorktreeRpc } from "../src/llm/handle-worktree-rpc";
import { detectGit } from "../src/llm/git-detect";
import { runGit } from "../src/llm/git-exec";
import { TURN_BUSY_ERROR } from "../src/llm/undo-constants";
import {
  WEB_CWD_SEP,
  WORKTREE_REQUIRES_GIT,
} from "../src/llm/worktree-constants";
import {
  formatDaemonCwdLabel,
  formatWatchCwdLine,
} from "../src/llm/worktree-parse";
import {
  addWorktree,
  collectWorktreeSnapshot,
  selectWorktree,
} from "../src/llm/worktree";
import { resolveInsideCwd } from "../src/llm/workspace-path";
import {
  readWorkspaceState,
  writeWorkspaceState,
  workspaceHash,
  statePath,
} from "../src/workspace";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function initRepo(dir: string) {
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "wt@test"]);
  await runGit(dir, ["config", "user.name", "wt"]);
  await runGit(dir, ["commit", "--allow-empty", "-m", "init"]);
}

const processCwdStart = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "chavez-wt-smoke-"));
const siblings: string[] = [];

try {
  // 5. Sin git first (clean dir)
  {
    const bare = mkdtempSync(join(tmpdir(), "chavez-wt-nongit-"));
    initEffectiveCwd(bare);
    const snap = await collectWorktreeSnapshot(bare);
    assert(snap.message === WORKTREE_REQUIRES_GIT, "no-git message");
    assert(snap.cwd === bare.replace(/\\/g, "/").replace(/\/+$/, "") || bare, "no-git cwd=bind");
    let threw = false;
    try {
      await addWorktree({ branch: "feat", createBranch: true }, bare);
    } catch (err) {
      threw = err instanceof Error && err.message === WORKTREE_REQUIRES_GIT;
    }
    assert(threw, "add throws WORKTREE_REQUIRES_GIT");
    assert(!existsSync(`${bare}-feat`), "no sibling created");
    rmSync(bare, { recursive: true, force: true });
  }

  const probe = await detectGit(tmp);
  if (!probe.gitAvailable) {
    console.log("git unavailable — skipped repo scenes");
    assert(process.cwd() === processCwdStart, "process.cwd stable");
    console.log("worktree-cwd-smoke OK");
    process.exit(0);
  }

  const main = join(tmp, "repo");
  mkdirSync(main);
  await initRepo(main);
  initEffectiveCwd(main);

  // 1. Elegir worktree
  const added = await addWorktree({ branch: "feat", createBranch: true }, main);
  const wt = getEffectiveCwd();
  siblings.push(wt);
  assert(wt !== main.replace(/\\/g, "/"), "cwd is sibling");
  assert(added.current?.branch === "feat", "current.branch feat");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src/a.txt"), "hello");
  assert(!existsSync(join(main, "src/a.txt")), "file not in main");
  assert(
    (await collectWorktreeSnapshot(main)).current?.branch === "feat",
    "snapshot current feat",
  );
  const label = formatDaemonCwdLabel("host-a", getEffectiveCwd());
  assert(label.includes(getEffectiveCwd()), "label has wt path");
  assert(label.includes(WEB_CWD_SEP), "label has sep");

  // 2. @ / tools / diffs — resolveInsideCwd
  // cwd = getEffectiveCwd()
  const resolved = resolveInsideCwd(getEffectiveCwd(), "src/a.txt");
  assert(existsSync(resolved), "resolve in worktree ok");
  assert(readFileSync(resolved, "utf8") === "hello", "read worktree file");
  let escapeOrMissing = false;
  try {
    const wrong = resolveInsideCwd(main, "src/a.txt");
    escapeOrMissing = !existsSync(wrong);
  } catch {
    escapeOrMissing = true;
  }
  assert(escapeOrMissing, "relative missing under main bind");

  // 3. Web / watch label
  const watchLine = formatWatchCwdLine({
    hostname: "host-a",
    cwd: getEffectiveCwd(),
    current: { branch: "feat", isMain: false },
  });
  assert(/host-a · /.test(watchLine), "watch host sep");
  assert(watchLine.includes("worktree feat"), "watch worktree feat");

  // 4. Un writer — busy blocks select
  const otherSnap = await addWorktree({ branch: "other", createBranch: true }, main);
  siblings.push(getEffectiveCwd());
  const otherPath = otherSnap.current?.path || getEffectiveCwd();
  const beforeBusy = getEffectiveCwd();
  const busy = await handleWorktreeRpc({
    bindPath: main,
    action: "select",
    payload: { path: otherPath },
    turnBusy: true,
  });
  assert(busy.error === TURN_BUSY_ERROR, "busy select");
  assert(getEffectiveCwd() === beforeBusy, "cwd unchanged while busy");
  // second agent.turn.request → TURN_BUSY_ERROR or plan 29 queue; this phase does not spawn second query()
  const listBusy = await handleWorktreeRpc({
    bindPath: main,
    action: "list",
    turnBusy: true,
  });
  assert(listBusy.ok, "list ok while busy");
  const free = await handleWorktreeRpc({
    bindPath: main,
    action: "select",
    payload: { path: otherPath },
    turnBusy: false,
  });
  assert(free.ok, "select other when free");
  assert(getEffectiveCwd() === otherPath.replace(/\\/g, "/"), "cwd is other");

  // 7. State file keyed by main bind
  writeWorkspaceState({
    path: main,
    pid: process.pid,
    openedAt: new Date().toISOString(),
    cwd: getEffectiveCwd(),
  });
  assert(readWorkspaceState(main)?.cwd === getEffectiveCwd(), "state cwd");
  assert(
    statePath(main).includes(workspaceHash(main)),
    "hash is bind not worktree",
  );

  assert(process.cwd() === processCwdStart, "process.cwd stable end");
  console.log("worktree-cwd-smoke OK");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  for (const s of siblings) {
    try {
      await runGit(tmp, ["worktree", "remove", "--force", s]);
    } catch {
      // ignore
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}
