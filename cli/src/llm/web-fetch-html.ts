const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t]+\n/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  const stripped = html
    .replace(SCRIPT_RE, " ")
    .replace(STYLE_RE, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(TAG_RE, " ")
    .replace(/&([a-z]+);/gi, (_, n: string) => ENTITIES[n.toLowerCase()] ?? "")
    .replace(/&#(\d+);/g, (_, d: string) => {
      const c = Number(d);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : "";
    })
    .replace(/\r\n/g, "\n")
    .replace(WS_RE, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped;
}

export function isHtmlContentType(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("text/html") || t.includes("application/xhtml");
}

export function isTextContentType(type: string): boolean {
  const t = type.toLowerCase();
  if (!t) return true;
  if (t.startsWith("text/")) return true;
  if (t.includes("json") || t.includes("xml") || t.includes("javascript")) {
    return true;
  }
  if (t.includes("markdown") || t.includes("yaml") || t.includes("csv")) {
    return true;
  }
  return false;
}
