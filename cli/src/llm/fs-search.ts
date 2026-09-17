import { loadIgnore } from "./ignore";
import {
  FS_COMPLETE_LIMIT,
  type FsCandidate,
  scorePath,
  walkWorkspace,
} from "./fs-complete";
import { toPosix } from "./workspace-path";

export const FS_SEARCH_LIMIT = 50;

/** Keep the picker cap imported so a stray edit cannot silently raise it. */
export { FS_COMPLETE_LIMIT };

export type FsSearchResult = {
  cwd: string;
  query: string;
  matches: FsCandidate[];
  truncated: boolean;
};

export function searchWorkspace(
  cwd: string,
  query: string,
  limit = FS_SEARCH_LIMIT,
): FsSearchResult {
  const q = toPosix(query).replace(/^@/, "").replace(/^\.\//, "").trim();
  if (!q) {
    return { cwd, query: q, matches: [], truncated: false };
  }
  const set = loadIgnore(cwd);
  const cap = Math.min(Math.max(1, limit), FS_SEARCH_LIMIT);
  const ranked = walkWorkspace(cwd, set)
    .map((c) => {
      const s = scorePath(c.path, q);
      return s == null ? null : { c, s };
    })
    .filter((x): x is { c: FsCandidate; s: number } => x != null)
    .sort(
      (a, b) =>
        a.s - b.s ||
        a.c.path.length - b.c.path.length ||
        a.c.path.localeCompare(b.c.path),
    );
  return {
    cwd,
    query: q,
    matches: ranked.slice(0, cap).map((x) => x.c),
    truncated: ranked.length > cap,
  };
}
