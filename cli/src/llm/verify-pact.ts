import { VERIFY_CMD_MAX_CHARS } from "./verify-constants";

export type PactRule = {
  layer: "user" | "project" | "local";
  body: string;
  verifyCommand?: string | null;
  enabled?: boolean;
};

function normalizeCmd(raw: string): string | null {
  const cmd = raw.trim().replace(/^`|`$/g, "").replace(/\s+/g, " ");
  if (!cmd) return null;
  return cmd.slice(0, VERIFY_CMD_MAX_CHARS);
}

function parseFrontmatterLite(raw: string): {
  attrs: Record<string, string>;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { attrs: {}, body: text };
  const rest = text.slice(3);
  const end = rest.search(/\r?\n---[ \t]*\r?\n/);
  if (end < 0) return { attrs: {}, body: text };
  const fm = rest.slice(0, end).replace(/^\r?\n/, "");
  const after = rest.slice(end).replace(/^\r?\n---[ \t]*\r?\n/, "");
  const attrs: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = /^(verifyCommand|verify|test)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    attrs[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { attrs, body: after };
}

export function extractVerifyCommandFromText(raw: string): string | null {
  const { attrs, body } = parseFrontmatterLite(raw);
  const fm = attrs.verifyCommand || attrs.verify || attrs.test;
  if (fm) return normalizeCmd(fm);
  const patterns = [
    /^verify(?:Command)?:\s*(.+)$/im,
    /^verification:\s*(.+)$/im,
    /^test(?:s)?(?: command)?:\s*(.+)$/im,
  ];
  for (const re of patterns) {
    const m = re.exec(body);
    if (m?.[1]) return normalizeCmd(m[1]);
  }
  return null;
}

/**
 * local > project > user. Disabled rules skipped.
 * Empty → null. NEVER defaults to `npm test`.
 */
export function pactCommandFromRules(rules: PactRule[]): string | null {
  const layers: Array<PactRule["layer"]> = ["local", "project", "user"];
  for (const layer of layers) {
    const slice = rules.filter((r) => r.layer === layer && r.enabled !== false);
    for (let i = slice.length - 1; i >= 0; i--) {
      const r = slice[i]!;
      const direct = r.verifyCommand?.trim();
      if (direct) return normalizeCmd(direct);
      const fromBody = extractVerifyCommandFromText(r.body || "");
      if (fromBody) return fromBody;
    }
  }
  return null;
}
