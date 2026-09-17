import { NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { denyProtectedBranchName } from "./git-guard";

export async function createWorkBranch(input: {
  cwd: string;
  name: string;
  checkout?: boolean;
}): Promise<{ branch: string; from: string | null }> {
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) throw new Error(NOT_A_GIT_REPO);
  const name = input.name.trim();
  if (!name) throw new Error("Branch name is required");
  const denied = denyProtectedBranchName(name);
  if (denied) throw new Error(denied);
  const from = ident.branch;
  const args =
    input.checkout === false
      ? ["branch", name]
      : ["switch", "-c", name];
  const r = await runGit(input.cwd, args);
  if (!r.ok) throw new Error(r.stderr || r.stdout || "git branch failed");
  const now = await detectGit(input.cwd);
  return { branch: now.branch || name, from };
}
