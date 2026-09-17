import { unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { checkpointRef, type Checkpoint } from "./undo-constants";
import { detectGit } from "./git-detect";
import { runGit, shaLine } from "./git-exec";
import { emptyCheckpoint } from "./undo-decide";

function absGitDir(cwd: string, gitDir: string): string {
  return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
}

export async function createTurnCheckpoint(
  cwd: string,
  streamId: string,
): Promise<Checkpoint> {
  const createdAt = new Date().toISOString();
  const ident = await detectGit(cwd);
  if (!ident.gitAvailable) return emptyCheckpoint(streamId, "git_missing");
  if (!ident.isRepo || !ident.gitDir) return emptyCheckpoint(streamId, "not_git");

  const indexPath = join(absGitDir(cwd, ident.gitDir), `chavez-index-${streamId}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (ident.headSha) {
      await runGit(cwd, ["read-tree", ident.headSha], env);
    } else {
      await runGit(cwd, ["read-tree", "--empty"], env);
    }
    const add = await runGit(cwd, ["add", "-A"], env);
    if (!add.ok) return emptyCheckpoint(streamId, "git_error");
    const tree = await runGit(cwd, ["write-tree"], env);
    const treeSha = tree.ok ? shaLine(tree.stdout) : null;
    if (!treeSha) return emptyCheckpoint(streamId, "git_error");
    const parentArgs = ident.headSha ? (["-p", ident.headSha] as string[]) : [];
    const commit = await runGit(
      cwd,
      ["commit-tree", treeSha, ...parentArgs, "-m", `chavez checkpoint ${streamId}`],
      env,
    );
    const commitSha = commit.ok ? shaLine(commit.stdout) : null;
    if (!commitSha) return emptyCheckpoint(streamId, "git_error");
    const ref = await runGit(cwd, ["update-ref", checkpointRef(streamId), commitSha]);
    if (!ref.ok) return emptyCheckpoint(streamId, "git_error");
    return {
      kind: "git",
      streamId,
      headSha: ident.headSha,
      commitSha,
      treeSha,
      branch: ident.branch,
      paths: [],
      commitsCreated: [],
      hadBash: false,
      appliedMutations: false,
      createdAt,
    };
  } catch {
    return emptyCheckpoint(streamId, "git_error");
  } finally {
    try {
      unlinkSync(indexPath);
    } catch {
      // leftover index must not block the turn
    }
  }
}

export async function treeHasPath(
  cwd: string,
  commitSha: string,
  relPath: string,
): Promise<boolean> {
  const r = await runGit(cwd, ["ls-tree", "--name-only", commitSha, "--", relPath]);
  return r.ok && r.stdout.trim() === relPath;
}

export async function listCommitsAfter(
  cwd: string,
  headBefore: string | null,
): Promise<string[]> {
  if (!headBefore) {
    const all = await runGit(cwd, ["rev-list", "--reverse", "HEAD"]);
    if (!all.ok || !all.stdout.trim()) return [];
    return all.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean);
  }
  const r = await runGit(cwd, ["rev-list", "--reverse", `${headBefore}..HEAD`]);
  if (!r.ok || !r.stdout.trim()) return [];
  return r.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean);
}

export async function diffPathsVsCheckpoint(
  cwd: string,
  commitSha: string,
): Promise<string[]> {
  const r = await runGit(cwd, ["diff", "--name-only", commitSha]);
  const named = r.ok && r.stdout.trim()
    ? r.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const untracked = await runGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const extra = untracked.ok && untracked.stdout.trim()
    ? untracked.stdout.split(/\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...named, ...extra]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export async function isAncestor(
  cwd: string,
  sha: string,
  head = "HEAD",
): Promise<boolean> {
  const r = await runGit(cwd, ["merge-base", "--is-ancestor", sha, head]);
  return r.ok;
}

export async function finalizeCheckpoint(
  cwd: string,
  checkpoint: Checkpoint,
  extra: { paths?: string[]; hadBash: boolean },
): Promise<Checkpoint> {
  if (checkpoint.kind !== "git" || !checkpoint.commitSha) {
    return {
      ...checkpoint,
      hadBash: extra.hadBash,
      appliedMutations: false,
      finalizedAt: new Date().toISOString(),
    };
  }
  const fromGit = await diffPathsVsCheckpoint(cwd, checkpoint.commitSha);
  const pathsSet = new Set<string>([...(extra.paths ?? []), ...fromGit]);
  const paths = [...pathsSet].filter(Boolean);
  const commitsCreated = await listCommitsAfter(cwd, checkpoint.headSha);
  const appliedMutations = paths.length > 0 || commitsCreated.length > 0;
  return {
    ...checkpoint,
    paths,
    commitsCreated,
    hadBash: extra.hadBash,
    appliedMutations,
    finalizedAt: new Date().toISOString(),
  };
}
