export const TOOL_OUTPUT_MAX_CHARS = 8000;

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

export function canonicalToolName(sdkName: string): string {
  return CANONICAL[sdkName] ?? (sdkName.toLowerCase() || "tool");
}

const SECRET_KEY_RE =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token)$/i;
const SECRET_VALUE_RE = /sk-ant-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+/g;

export function truncateToolText(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE_RE, "***");
}

export function sanitizeToolInput(input: unknown): unknown {
  if (typeof input === "string") return redactSecrets(input);
  if (Array.isArray(input)) return input.map(sanitizeToolInput);
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "***";
    } else {
      out[k] = sanitizeToolInput(v);
    }
  }
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** One-line summary for timeline / watch. Never dumps file contents or secrets. */
export function summarizeToolInput(sdkName: string, input: unknown): string {
  const rec = asRecord(sanitizeToolInput(input));
  const name = canonicalToolName(sdkName);
  if (!rec) {
    const s = typeof input === "string" ? redactSecrets(input) : "";
    return s ? `${name} ${s.slice(0, 200)}` : name;
  }
  const filePath = str(rec.file_path) || str(rec.notebook_path) || str(rec.path);
  if (name === "read") {
    const off = rec.offset != null ? ` offset=${rec.offset}` : "";
    const lim = rec.limit != null ? ` limit=${rec.limit}` : "";
    return filePath ? `${filePath}${off}${lim}` : "read";
  }
  if (name === "write") return filePath || "write";
  if (name === "edit") {
    const oldS = str(rec.old_string);
    const newS = str(rec.new_string);
    if (filePath && oldS && newS) {
      return `${filePath}  −${oldS.split("\n").length} +${newS.split("\n").length} lines`;
    }
    return filePath || "edit";
  }
  if (name === "grep") {
    const pat = str(rec.pattern) || "";
    const p = filePath ? ` in ${filePath}` : "";
    return pat ? `${pat}${p}` : "grep";
  }
  if (name === "glob") {
    const pat = str(rec.pattern) || "";
    const p = filePath ? ` in ${filePath}` : "";
    return pat ? `${pat}${p}` : "glob";
  }
  if (name === "bash") {
    const cmd = str(rec.command) || "";
    return cmd ? redactSecrets(cmd).slice(0, 200) : "bash";
  }
  if (filePath) return filePath;
  try {
    return redactSecrets(JSON.stringify(rec)).slice(0, 200);
  } catch {
    return name;
  }
}

export function toolHeadline(sdkName: string, status: string, input?: unknown): string {
  const name = canonicalToolName(sdkName);
  const summary = input !== undefined ? summarizeToolInput(sdkName, input) : "";
  return summary && summary !== name
    ? `tool · ${name} · ${status}  ${summary}`
    : `tool · ${name} · ${status}`;
}
