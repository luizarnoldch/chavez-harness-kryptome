/**
 * Path-like @mentions. Keep the regex in sync with cli/src/llm/mentions.ts.
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

export function activeMention(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const slice = text.slice(0, cursor);
  const at = slice.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_]/.test(slice[at - 1]!)) return null;
  const rest = slice.slice(at + 1);
  if (/\s/.test(rest)) return null;
  if (/^\S/.test(text.slice(cursor))) return null;
  return { start: at, query: rest };
}
