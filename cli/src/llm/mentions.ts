/**
 * Path-like @mentions. Keep the regex in sync with web/src/lib/mentions.ts.
 *
 * Matches:
 *   @"quoted path"  |  @'quoted'  |  @src/auth.ts  |  @package.json  |  @src/  |  @../../x  |  @/etc/passwd
 * Does not match:
 *   user@example.com  (word char before @)
 *   @decorator        (no slash, no extension, no trailing slash)
 */
export const MENTION_RE =
  /(?<![A-Za-z0-9_])@(?:"([^"]+)"|'([^']+)'|(\/[A-Za-z0-9._/-]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._/-]*|[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}|[A-Za-z0-9._-]+\/))/g;

export type ParsedMention = {
  raw: string;
  path: string;
  start: number;
  end: number;
};

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function parseMentions(prompt: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  const re = new RegExp(MENTION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const captured = m[1] ?? m[2] ?? m[3] ?? "";
    const path = normalizeRel(captured);
    if (!path || path === ".") continue;
    out.push({ raw: m[0], path, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Union text mentions with picker-supplied paths (relative posix, no leading @). */
export function mergeMentions(
  prompt: string,
  extraPaths: string[] = [],
): string[] {
  const fromText = parseMentions(prompt).map((x) => x.path);
  const extra = extraPaths
    .map((p) => normalizeRel(p.replace(/^@/, "")))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...fromText, ...extra]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function isPathLikeMentionToken(token: string): boolean {
  const t = token.startsWith("@") ? token.slice(1) : token;
  if (!t) return false;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return true;
  }
  return (
    t.startsWith("/") ||
    t.includes("/") ||
    t.endsWith("/") ||
    /\.[A-Za-z0-9]{1,12}$/.test(t)
  );
}
