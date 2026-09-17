import { GIT_DIFF_MAX_CHARS, GIT_MISSING, NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { parseDiffNameOnly } from "./git-porcelain";
import type { GitHeadDiff } from "./git-format";

export async function collectDiffVsHead(
  cwd: string,
  paths?: string[],
): Promise<GitHeadDiff> {
  const ident = await detectGit(cwd);
  if (!ident.gitAvailable) {
    return { isRepo: false, message: GIT_MISSING, unified: "", stat: "", paths: [], truncated: false };
  }
  if (!ident.isRepo) {
    return { isRepo: false, message: NOT_A_GIT_REPO, unified: "", stat: "", paths: [], truncated: false };
  }
  const pathArgs = paths?.length ? ["--", ...paths] : [];
  const diff = await runGit(cwd, ["diff", "HEAD", ...pathArgs]);
  const stat = await runGit(cwd, ["diff", "--stat", "HEAD", ...pathArgs]);
  const names = await runGit(cwd, ["diff", "--name-only", "HEAD", ...pathArgs]);
  const untracked = await runGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  let unified = diff.ok ? diff.stdout : diff.stderr;
  let truncated = false;
  if (unified.length > GIT_DIFF_MAX_CHARS) {
    unified =
      unified.slice(0, GIT_DIFF_MAX_CHARS) +
      `\n[truncated: showing ${GIT_DIFF_MAX_CHARS} of ${unified.length} chars]`;
    truncated = true;
  }
  const pathsOut = [
    ...parseDiffNameOnly(names.stdout),
    ...parseDiffNameOnly(untracked.stdout),
  ];
  return {
    isRepo: true,
    unified,
    stat: stat.ok ? stat.stdout : "",
    paths: [...new Set(pathsOut)],
    truncated,
  };
}
