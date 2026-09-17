import { resolve } from "node:path";
import { runGit, shaLine } from "./git-exec";

export type GitIdentity = {
  isRepo: boolean;
  gitAvailable: boolean;
  headSha: string | null;
  branch: string | null;
  gitDir: string | null;
};

export async function gitCommonDir(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
  if (!r.ok || !r.stdout.trim()) return null;
  const raw = r.stdout.trim();
  if (raw.startsWith("/")) return raw.replace(/\\/g, "/");
  return resolve(cwd, raw).replace(/\\/g, "/");
}

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
