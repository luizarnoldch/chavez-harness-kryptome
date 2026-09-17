/** keep-in-sync: cli/src/chats/export-share.ts, api/src/chats/export-share.ts, web/src/lib/export-share.ts */

export const EXPORT_FORMAT_ID = "chavez.chat.export" as const;
export const EXPORT_FORMAT_VERSION = 1 as const;
export const EXPORT_FORMATS = ["md", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const TOOL_SUMMARY_MAX_CHARS = 500;
export const JSON_TOOL_OUTPUT_MAX_CHARS = 8000;
export const REDACT_REPLACEMENT = "***";
export const SHARE_TOKEN_BYTES = 32;
export const CHAT_NOT_FOUND = "Chat not found";
export const SESSION_NOT_FOUND = "Session not found";
export const SHARE_NOT_FOUND = "Share not found";
export const IMPORT_INVALID = "Invalid export document";
export const IMPORT_JSON_ONLY = "Import requires a JSON export (chavez.chat.export)";
export const FORMAT_REQUIRED = "format must be md or json";
export const EXPORT_USAGE =
  "Uso: chavez headless chat export <chatId> [--format md|json] [--out file]";
export const IMPORT_USAGE =
  "Uso: chavez headless chat import <sessionId> <file.json>";
export const SHARE_USAGE =
  "Uso: chavez headless chat share <create|get|revoke> <chatId>";
export const EXPORT_HUB_HINT =
  "Export: chavez headless chat export <chatId> [--format md|json]. Import: chat import <sessionId> <file.json>. Share: chat share create <chatId>. Sin vault. Tools no se re-ejecutan.";
export const TUI_EXPORT_HINT = "[E] export/share  [Esc] cierra";
export const SHARE_READONLY_BANNER =
  "Vista de solo lectura. No es un workspace compartido. No puedes enviar un turn ni ver el vault.";
export const SHARE_REVOKED_HINT = "Link revocado";
export const IMPORT_TITLE_PREFIX = "Imported: ";
export const USAGE_META_KIND = "turn_usage";
export const DEFAULT_CHAT_TITLE = "Chat";

export const DROP_ATTACH_KEYS = [
  "imageBase64",
  "hydratedText",
  "bytes",
  "contentBase64",
  "data",
  "blob",
  "preview",
] as const;

const KEY_NAME =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token|ciphertext)$/i;

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]+/g,
  /ghu_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const ENV_LINE =
  /^([A-Za-z_][A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|[A-Za-z0-9_]*))\s*=\s*(.+)$/gm;

const VAULT_PATH_RE = /(?:^|[^\w.])(?:~\/)?\.chavez\/[A-Za-z0-9._\-\/]+/g;

const CANONICAL: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "grep",
  Glob: "glob",
  LS: "glob",
  Bash: "bash",
};

export type ExportAttach = {
  path: string;
  kind: string;
  status: string;
};

export type ExportToolSummary = {
  toolCallId: string;
  name: string;
  status: string;
  input: unknown;
  output: string;
};

export type ExportDiffSummary = {
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
};

export type ExportUsageEntry = {
  provider: string;
  modelId: string | null;
  usage: Record<string, unknown>;
};

export type ExportMessage = {
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

export type ChatExportDocument = {
  format: typeof EXPORT_FORMAT_ID;
  version: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  chat: { title: string };
  messages: ExportMessage[];
  usage: ExportUsageEntry[];
  diffs: ExportDiffSummary[];
};

export type ChatExportResult = {
  markdown: string;
  document: ChatExportDocument;
};

export type ShareView = {
  title: string;
  createdAt: string;
  messages: ExportMessage[];
  banner: typeof SHARE_READONLY_BANNER;
};

export type SourceMessage = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
};

export type SourceDiffRow = {
  streamId?: string | null;
  path?: string | null;
  kind?: string | null;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
  preview?: string | null;
  body?: string | null;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function iso(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return 0;
}

export function redactExportText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  out = out.replace(ENV_LINE, (full, k, val) => {
    if (String(val).trim() === "" || String(val) === REDACT_REPLACEMENT) {
      return full;
    }
    return `${k}=${REDACT_REPLACEMENT}`;
  });
  out = out.replace(VAULT_PATH_RE, (m) => {
    const prefix = m[0] === "~" || m[0] === "." ? "" : m[0];
    return `${prefix}${REDACT_REPLACEMENT}`;
  });
  return out;
}

export function redactExportJson(value: unknown): unknown {
  if (typeof value === "string") return redactExportText(value);
  if (Array.isArray(value)) return value.map(redactExportJson);
  const obj = rec(value);
  if (obj) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactExportJson(v);
    }
    return out;
  }
  return value;
}

export function truncateExportText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function parseExportFormat(raw: string | null | undefined): ExportFormat | null {
  const v = String(raw || "json").trim().toLowerCase();
  if (v === "md" || v === "markdown") return "md";
  if (v === "json") return "json";
  return null;
}

export function shareUrl(webOrigin: string, token: string): string {
  return `${webOrigin.replace(/\/$/, "")}/s/${encodeURIComponent(token)}`;
}

function metaOf(m: SourceMessage): Record<string, unknown> {
  return rec(m.metadata) ?? {};
}

function canonicalToolName(name: string): string {
  return CANONICAL[name] || name.toLowerCase();
}

function boundAttach(raw: unknown): ExportAttach | null {
  const o = rec(raw);
  if (!o) return null;
  const path = typeof o.path === "string" ? o.path : "";
  if (!path) return null;
  return {
    path: redactExportText(path),
    kind: typeof o.kind === "string" ? o.kind : "file",
    status: typeof o.status === "string" ? o.status : "ok",
  };
}

function dropBlobKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if ((DROP_ATTACH_KEYS as readonly string[]).includes(k)) continue;
    if (k === "attachments" && Array.isArray(v)) {
      out.attachments = v.map(boundAttach).filter(Boolean);
      continue;
    }
    if (k === "output" && typeof v === "string") {
      out.output = truncateExportText(redactExportText(v), JSON_TOOL_OUTPUT_MAX_CHARS);
      continue;
    }
    if (k === "input") {
      out.input = redactExportJson(v);
      continue;
    }
    if (k === "usage" && rec(v)) {
      out.usage = redactExportJson(v);
      continue;
    }
    out[k] = redactExportJson(v);
  }
  return out;
}

function boundMessage(m: SourceMessage): ExportMessage {
  const role = String(m.role || "user");
  const meta = metaOf(m);
  return {
    role,
    content: redactExportText(String(m.content ?? "")),
    createdAt: iso(m.createdAt),
    metadata: Object.keys(meta).length ? dropBlobKeys(meta) : null,
  };
}

function toolSummary(m: SourceMessage, maxOut: number): ExportToolSummary {
  const meta = metaOf(m);
  const outputRaw =
    (typeof meta.output === "string" ? meta.output : null) ||
    String(m.content ?? "");
  return {
    toolCallId: typeof meta.toolCallId === "string" ? meta.toolCallId : "",
    name: canonicalToolName(String(meta.toolName || m.content || "tool")),
    status: typeof meta.status === "string" ? meta.status : "done",
    input: redactExportJson(meta.input ?? null),
    output: truncateExportText(redactExportText(outputRaw), maxOut),
  };
}

function usageFromMeta(meta: Record<string, unknown>): ExportUsageEntry | null {
  if (meta.kind !== USAGE_META_KIND) return null;
  const usage = rec(meta.usage);
  if (!usage) return null;
  const provider =
    typeof meta.provider === "string" && meta.provider.trim()
      ? meta.provider
      : "unknown";
  const modelId = typeof meta.modelId === "string" ? meta.modelId : null;
  return {
    provider,
    modelId,
    usage: redactExportJson(usage) as Record<string, unknown>,
  };
}

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return truncateExportText(redactExportText(input), TOOL_SUMMARY_MAX_CHARS);
  }
  const o = rec(input);
  if (o) {
    const cmd = o.command ?? o.path ?? o.pattern ?? o.file_path;
    if (typeof cmd === "string") {
      return truncateExportText(redactExportText(cmd), TOOL_SUMMARY_MAX_CHARS);
    }
  }
  try {
    return truncateExportText(
      redactExportText(JSON.stringify(input)),
      TOOL_SUMMARY_MAX_CHARS,
    );
  } catch {
    return "";
  }
}

function mapDiffs(rows: SourceDiffRow[] | undefined): ExportDiffSummary[] {
  if (!rows?.length) return [];
  const out: ExportDiffSummary[] = [];
  for (const d of rows) {
    if (d.status === "rejected") continue;
    const path = typeof d.path === "string" ? d.path : "";
    if (!path) continue;
    out.push({
      path: redactExportText(path),
      kind: typeof d.kind === "string" ? d.kind : "modified",
      status: typeof d.status === "string" ? d.status : "applied",
      additions: num(d.additions),
      deletions: num(d.deletions),
    });
  }
  return out;
}

export function assembleChatExport(input: {
  title?: string | null;
  messages: SourceMessage[];
  diffs?: SourceDiffRow[];
  exportedAt?: string;
}): ChatExportResult {
  const title = (input.title || "").trim() || DEFAULT_CHAT_TITLE;
  const messages = input.messages.map(boundMessage);
  const usage: ExportUsageEntry[] = [];
  for (const m of input.messages) {
    const u = usageFromMeta(metaOf(m));
    if (u) usage.push(u);
  }
  const diffs = mapDiffs(input.diffs);
  const document: ChatExportDocument = {
    format: EXPORT_FORMAT_ID,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt || new Date().toISOString(),
    chat: { title: redactExportText(title) },
    messages,
    usage,
    diffs,
  };
  const clean = redactExportJson(document) as ChatExportDocument;
  return {
    document: clean,
    markdown: formatChatMarkdown(clean, input.messages, input.diffs),
  };
}

function attachesOf(m: SourceMessage): ExportAttach[] {
  const raw = metaOf(m).attachments;
  if (!Array.isArray(raw)) return [];
  return raw.map(boundAttach).filter((a): a is ExportAttach => Boolean(a));
}

export function formatChatMarkdown(
  doc: ChatExportDocument,
  source?: SourceMessage[],
  diffs?: SourceDiffRow[],
): string {
  const lines: string[] = [`# ${doc.chat.title}`, ""];
  const src = source ?? [];
  const diffSum = doc.diffs.length ? doc.diffs : mapDiffs(diffs);
  let diffsEmitted = false;

  const emitTools = (tools: SourceMessage[]) => {
    if (!tools.length) return;
    lines.push("## tools");
    for (const t of tools) {
      const s = toolSummary(t, TOOL_SUMMARY_MAX_CHARS);
      lines.push(`tool · ${s.name} · ${s.status}`);
      const inn = summarizeInput(s.input);
      if (inn) lines.push(`  in: ${inn}`);
      if (s.output) {
        const outLines = s.output.split("\n");
        lines.push(`  out: ${outLines[0] ?? ""}`);
        for (const extra of outLines.slice(1)) lines.push(`  ${extra}`);
      }
    }
    lines.push("");
  };

  let pendingTools: SourceMessage[] = [];
  const flushTools = () => {
    emitTools(pendingTools);
    pendingTools = [];
  };

  for (let i = 0; i < src.length; i++) {
    const m = src[i]!;
    const role = String(m.role || "");
    if (role === "tool") {
      pendingTools.push(m);
      continue;
    }
    flushTools();
    lines.push(`## ${role}`);
    lines.push(redactExportText(String(m.content ?? "")));
    lines.push("");
    const atts = attachesOf(m);
    if (atts.length) {
      lines.push("## attaches");
      for (const a of atts) {
        lines.push(`@ ${a.path}  ${a.kind}  ${a.status}`);
      }
      lines.push("");
    }
    if (!diffsEmitted && diffSum.length && role === "assistant") {
      lines.push("## diffs");
      for (const d of diffSum) {
        lines.push(`${d.path}  ${d.kind}  +${d.additions} −${d.deletions}`);
      }
      lines.push("");
      diffsEmitted = true;
    }
  }
  flushTools();
  if (!diffsEmitted && diffSum.length) {
    lines.push("## diffs");
    for (const d of diffSum) {
      lines.push(`${d.path}  ${d.kind}  +${d.additions} −${d.deletions}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function parseExportDocument(raw: unknown): ChatExportDocument | null {
  const o = rec(raw);
  if (!o) return null;
  if (o.format !== EXPORT_FORMAT_ID) return null;
  if (o.version !== EXPORT_FORMAT_VERSION) return null;
  const chat = rec(o.chat);
  if (!chat || typeof chat.title !== "string") return null;
  if (!Array.isArray(o.messages)) return null;
  const messages: ExportMessage[] = [];
  for (const item of o.messages) {
    const m = rec(item);
    if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
      return null;
    }
    messages.push({
      role: m.role,
      content: String(m.content),
      createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
      metadata: rec(m.metadata),
    });
  }
  const usage: ExportUsageEntry[] = [];
  if (Array.isArray(o.usage)) {
    for (const item of o.usage) {
      const u = rec(item);
      if (!u || typeof u.provider !== "string") continue;
      const blob = rec(u.usage) ?? {};
      usage.push({
        provider: u.provider,
        modelId: typeof u.modelId === "string" ? u.modelId : null,
        usage: blob,
      });
    }
  }
  const diffs = mapDiffs(
    Array.isArray(o.diffs) ? (o.diffs as SourceDiffRow[]) : [],
  );
  return {
    format: EXPORT_FORMAT_ID,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
    chat: { title: chat.title },
    messages,
    usage,
    diffs,
  };
}

export function importedChatTitle(original: string): string {
  const t = (original || "").trim() || DEFAULT_CHAT_TITLE;
  if (t.startsWith(IMPORT_TITLE_PREFIX)) return t.slice(0, 120);
  return `${IMPORT_TITLE_PREFIX}${t}`.slice(0, 120);
}

export function messagesForImport(doc: ChatExportDocument): ExportMessage[] {
  return doc.messages.map((m) => {
    const meta = rec(m.metadata) ?? {};
    const bounded = dropBlobKeys({
      ...meta,
      imported: true,
      importedAt: new Date().toISOString(),
    });
    return {
      role: ["user", "assistant", "system", "tool"].includes(m.role)
        ? m.role
        : "user",
      content: redactExportText(m.content),
      createdAt: m.createdAt,
      metadata: bounded,
    };
  });
}

export function shareViewFromExport(
  title: string,
  createdAt: string,
  messages: SourceMessage[],
): ShareView {
  const assembled = assembleChatExport({ title, messages });
  return {
    title: assembled.document.chat.title,
    createdAt,
    messages: assembled.document.messages,
    banner: SHARE_READONLY_BANNER,
  };
}

export function documentHasForbidden(doc: ChatExportDocument, needle: string): boolean {
  return JSON.stringify(doc).includes(needle);
}
