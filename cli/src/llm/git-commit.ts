import { NO_FAKE_COMMIT, NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit, shaLine } from "./git-exec";
import { denyCommitOnProtected } from "./git-guard";
import { assertCommitPathsAllowed } from "./git-secret-guard";
import { collectGitSnapshot } from "./git-status";

export type CommitMode = "plan" | "auto" | "ask" | "user";

export async function commitWorkspace(input: {
  cwd: string;
  message: string;
  paths?: string[];
  allowProtected?: boolean;
  mode: CommitMode;
}): Promise<{ sha: string; branch: string | null; paths: string[] }> {
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) {
    throw new Error(ident.gitAvailable ? NOT_A_GIT_REPO : NO_FAKE_COMMIT);
  }
  const snap = await collectGitSnapshot(input.cwd);
  const protectedErr = denyCommitOnProtected({
    branch: snap.branch,
    allowProtected: Boolean(input.allowProtected),
    mode: input.mode,
  });
  if (protectedErr) throw new Error(protectedErr);

  const paths =
    input.paths?.length ? input.paths : snap.dirty.map((d) => d.path);
  if (!paths.length) {
    throw new Error("Nothing to commit");
  }
  assertCommitPathsAllowed(input.cwd, paths);

  const add = await runGit(input.cwd, ["add", "--", ...paths]);
  if (!add.ok) throw new Error(add.stderr || add.stdout || "git add failed");

  const msg = input.message.trim();
  if (!msg) throw new Error("Commit message is required");
  const committed = await runGit(input.cwd, ["commit", "-m", msg, "--", ...paths]);
  if (!committed.ok) {
    throw new Error(committed.stderr || committed.stdout || "git commit failed");
  }
  const shaRes = await runGit(input.cwd, ["rev-parse", "HEAD"]);
  const sha = shaLine(shaRes.stdout) || shaRes.stdout.trim();
  return { sha, branch: snap.branch, paths };
}
