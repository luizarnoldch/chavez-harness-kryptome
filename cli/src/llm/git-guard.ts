import {
  COMMIT_ON_PROTECTED,
  FORCE_PUSH_PROTECTED,
} from "./git-constants";
import { isProtectedBranch } from "./git-porcelain";

export function denyForcePushToProtected(input: {
  force: boolean;
  branch: string | null;
  refspec?: string | null;
}): string | null {
  if (!input.force) return null;
  const spec = input.refspec || "";
  const dest =
    (spec.includes(":") ? spec.split(":").pop() : spec) || input.branch;
  if (isProtectedBranch(dest) || isProtectedBranch(input.branch)) {
    return FORCE_PUSH_PROTECTED;
  }
  return null;
}

/** Auto (and plan) cannot commit on main/master. Ask may if allowProtected. */
export function denyCommitOnProtected(input: {
  branch: string | null;
  allowProtected: boolean;
  mode: "plan" | "auto" | "ask" | "user";
}): string | null {
  if (!isProtectedBranch(input.branch)) return null;
  if (input.mode === "user") return null; // CLI explícito del usuario
  if (input.mode === "ask" && input.allowProtected) return null;
  return COMMIT_ON_PROTECTED;
}

export function denyProtectedBranchName(name: string): string | null {
  if (isProtectedBranch(name)) {
    return COMMIT_ON_PROTECTED;
  }
  return null;
}

export function sanitizeWorkBranch(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const base = s || "work";
  if (isProtectedBranch(base)) return `chavez/${base}`;
  return base.startsWith("chavez/") ? base : `chavez/${base}`;
}
