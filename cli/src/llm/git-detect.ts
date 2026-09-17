import { runGit, shaLine } from "./git-exec";

export type GitIdentity = {
  isRepo: boolean;
  gitAvailable: boolean;
  headSha: string | null;
  branch: string | null;
  gitDir: string | null;
};

export async function detectGit(cwd: string): Promise<GitIdentity> {
  const version = await runGit(cwd, ["--version"]);
  if (!version.ok) {
    return {
      isRepo: false,
      gitAvailable: false,
      headSha: null,
      branch: null,
      gitDir: null,
    };
  }
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      isRepo: false,
      gitAvailable: true,
      headSha: null,
      branch: null,
      gitDir: null,
    };
  }
  const gitDirRaw = await runGit(cwd, ["rev-parse", "--git-dir"]);
  const gitDir = gitDirRaw.ok ? gitDirRaw.stdout.trim() : null;
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  const headSha = head.ok ? shaLine(head.stdout) : null;
  const br = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = br.ok && br.stdout.trim() && br.stdout.trim() !== "HEAD"
    ? br.stdout.trim()
    : null;
  return { isRepo: true, gitAvailable: true, headSha, branch, gitDir };
}
