import {
  RULE_BODY_MAX_CHARS,
  USER_RULE_TITLE_MAX,
  parseCanonicalToolList,
  type CanonicalDisallowTool,
  type RuleLayer,
} from "./rules-constants";

export type ParsedRuleFile = {
  title: string;
  body: string;
  disallowTools: CanonicalDisallowTool[];
  allowTools: CanonicalDisallowTool[];
  globs: string[];
  alwaysApply: boolean;
  truncated: boolean;
};

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseScalarList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s))
    .filter(Boolean);
}

export function parseFrontmatter(raw: string): {
  attrs: Record<string, unknown>;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { attrs: {}, body: text };
  const rest = text.slice(3);
  const nl = rest.startsWith("\n") || rest.startsWith("\r\n") ? rest : "";
  if (!nl && rest[0] !== "\n" && rest[0] !== "\r") {
    return { attrs: {}, body: text };
  }
  const end = rest.search(/\r?\n---[ \t]*\r?\n/);
  if (end < 0) return { attrs: {}, body: text };
  const fm = rest.slice(0, end).replace(/^\r?\n/, "");
  const after = rest.slice(end).replace(/^\r?\n---[ \t]*\r?\n/, "");
  const attrs: Record<string, unknown> = {};
  let pendingKey: string | null = null;
  for (const line of fm.split(/\r?\n/)) {
    const listItem = pendingKey && /^\s+-\s+(.+)$/.exec(line);
    if (listItem) {
      const arr = Array.isArray(attrs[pendingKey!])
        ? (attrs[pendingKey!] as unknown[])
        : [];
      arr.push(stripQuotes(listItem[1]!));
      attrs[pendingKey!] = arr;
      continue;
    }
    pendingKey = null;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.trim();
    if (val === "" || val === "|" || val === ">") {
      pendingKey = key;
      attrs[key] = [];
      continue;
    }
    if (val.startsWith("[")) {
      attrs[key] = parseScalarList(val);
      continue;
    }
    if (val === "true" || val === "false") {
      attrs[key] = val === "true";
      continue;
    }
    attrs[key] = stripQuotes(val);
  }
  return { attrs, body: after };
}

export function titleFromBodyOrPath(
  body: string,
  pathOrFallback: string,
  fmTitle?: unknown,
): string {
  if (typeof fmTitle === "string" && fmTitle.trim()) {
    return fmTitle.trim().slice(0, USER_RULE_TITLE_MAX);
  }
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(body);
  if (heading?.[1]) {
    return heading[1].trim().slice(0, USER_RULE_TITLE_MAX);
  }
  const base = pathOrFallback.replace(/\\/g, "/").split("/").pop() || "Untitled rule";
  return base.slice(0, USER_RULE_TITLE_MAX);
}

export function parseRuleFile(
  raw: string,
  pathOrFallback: string,
): ParsedRuleFile {
  const { attrs, body: parsedBody } = parseFrontmatter(raw);
  let body = parsedBody.replace(/^\s+/, "");
  let truncated = false;
  if (body.length > RULE_BODY_MAX_CHARS) {
    const over = body.length - RULE_BODY_MAX_CHARS;
    body = `${body.slice(0, RULE_BODY_MAX_CHARS)}\n\n[truncated ${over} chars]`;
    truncated = true;
  }
  const disallow =
    parseCanonicalToolList(attrs.disallowTools ?? attrs.disallow) ?? [];
  const allow = parseCanonicalToolList(attrs.allowTools ?? attrs.allow) ?? [];
  const globsRaw = attrs.globs;
  const globs = Array.isArray(globsRaw)
    ? globsRaw.map(String)
    : typeof globsRaw === "string"
      ? parseScalarList(globsRaw)
      : [];
  const alwaysApply =
    attrs.alwaysApply === undefined ? true : Boolean(attrs.alwaysApply);
  return {
    title: titleFromBodyOrPath(body, pathOrFallback, attrs.title),
    body,
    disallowTools: disallow,
    allowTools: allow,
    globs,
    alwaysApply,
    truncated,
  };
}

export function toRuleSource(
  layer: RuleLayer,
  parsed: ParsedRuleFile,
  opts: { id?: string; path?: string; enabled?: boolean },
): import("./rules-merge").RuleSource {
  return {
    layer,
    id: opts.id,
    title: parsed.title,
    body: parsed.body,
    path: opts.path,
    enabled: opts.enabled !== false,
    disallowTools: parsed.disallowTools,
    allowTools: parsed.allowTools,
    chars: parsed.body.length,
    truncated: parsed.truncated,
    globs: parsed.globs,
    alwaysApply: parsed.alwaysApply,
  };
}
