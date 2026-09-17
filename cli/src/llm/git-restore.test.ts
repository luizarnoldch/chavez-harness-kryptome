import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnCheckpoint, finalizeCheckpoint } from "./git-checkpoint";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { restoreTurn } from "./git-restore";
import { SHELL_SIDE_EFFECT_WARNING, UNDO_REQUIRES_GIT } from "./undo-constants";

describe("restoreTurn", () => {
  test("restores allowlisted files only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-"));
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
    await runGit(cwd, ["config", "user.name", "Undo Bot"]);
    writeFileSync(join(cwd, "keep.ts"), "keep\n");
    writeFileSync(join(cwd, "a.ts"), "one\n");
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", "init"]);

    const cp0 = await createTurnCheckpoint(cwd, "s1");
    expect(cp0.kind).toBe("git");
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "b.ts"), "new\n");
    const fin = await finalizeCheckpoint(cwd, cp0, {
      paths: ["a.ts", "b.ts"],
      hadBash: false,
    });
    writeFileSync(join(cwd, "keep.ts"), "user-edit\n");
    const out = await restoreTurn({ cwd, chatId: "c1", checkpoint: fin });
    expect(out.diskTouched).toBe(true);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("one\n");
    expect(existsSync(join(cwd, "b.ts"))).toBe(false);
    expect(readFileSync(join(cwd, "keep.ts"), "utf8")).toBe("user-edit\n");
  });

  test("no git — disk untouched", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-"));
    writeFileSync(join(cwd, "a.ts"), "hello\n");
    const ident = await detectGit(cwd);
    expect(ident.isRepo).toBe(false);
    const out = await restoreTurn({
      cwd,
      chatId: "c1",
      checkpoint: {
        kind: "none",
        streamId: "s1",
        reason: "not_git",
        headSha: null,
        commitSha: null,
        treeSha: null,
        branch: null,
        paths: ["a.ts"],
        commitsCreated: [],
        hadBash: false,
        appliedMutations: true,
        createdAt: new Date().toISOString(),
      },
    });
    expect(out.message).toBe(UNDO_REQUIRES_GIT);
    expect(out.diskTouched).toBe(false);
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("hello\n");
  });

  test("turn commit is reverted, not reset --hard", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-commit-"));
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
    await runGit(cwd, ["config", "user.name", "Undo Bot"]);
    writeFileSync(join(cwd, "a.ts"), "one\n");
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", "init"]);
    const headBefore = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();

    const cp0 = await createTurnCheckpoint(cwd, "s-commit");
    writeFileSync(join(cwd, "a.ts"), "committed-by-turn\n");
    await runGit(cwd, ["add", "a.ts"]);
    await runGit(cwd, ["commit", "-m", "turn commit"]);
    const turnHead = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    expect(turnHead).not.toBe(headBefore);

    const fin = await finalizeCheckpoint(cwd, cp0, {
      paths: ["a.ts"],
      hadBash: false,
    });
    expect(fin.commitsCreated.length).toBeGreaterThan(0);
    const out = await restoreTurn({ cwd, chatId: "c1", checkpoint: fin });
    expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("one\n");
    const log = (await runGit(cwd, ["log", "--oneline"])).stdout;
    const headAfter = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    // HEAD may move via revert commit, never by rewriting away the turn sha without a new commit
    if (headAfter === headBefore) {
      throw new Error("HEAD reset to parent without a new revert commit");
    }
    const ancestor = await runGit(cwd, ["merge-base", "--is-ancestor", turnHead, "HEAD"]);
    expect(ancestor.ok).toBe(true);
    expect(out.commitAction === "revert" || out.commitAction === "warn" || log.includes("Revert")).toBe(true);
  });

  test("bash rm of tracked file is restored; ignored may stay gone", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-bash-"));
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
    await runGit(cwd, ["config", "user.name", "Undo Bot"]);
    writeFileSync(join(cwd, "tracked.ts"), "keep-me\n");
    writeFileSync(join(cwd, ".gitignore"), ".secret\n");
    writeFileSync(join(cwd, ".secret"), "secret\n");
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", "init"]);

    const cp0 = await createTurnCheckpoint(cwd, "s-bash");
    // tracked rm (versioned) + ignored rm
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(cwd, "tracked.ts"));
    unlinkSync(join(cwd, ".secret"));
    const fin = await finalizeCheckpoint(cwd, cp0, {
      paths: ["tracked.ts"],
      hadBash: true,
    });
    const out = await restoreTurn({ cwd, chatId: "c1", checkpoint: fin });
    expect(readFileSync(join(cwd, "tracked.ts"), "utf8")).toBe("keep-me\n");
    expect(out.warning).toBe(SHELL_SIDE_EFFECT_WARNING);
    // ignored file is not in the checkpoint tree; it may not come back
    // (document: .secret may remain missing)
  });

  test("source does not use reset --hard", async () => {
    const src = await Bun.file(new URL("./git-restore.ts", import.meta.url)).text();
    expect(src).not.toContain("reset --hard");
    expect(src).not.toContain("push --force");
  });
});
