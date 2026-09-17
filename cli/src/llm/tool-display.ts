import { canonicalToolName } from "./tool-names";
import { redactText } from "./redact";

export const TOOL_OUTPUT_MAX_CHARS = 8000;

export { redactText as redactSecrets } from "./redact";

const SECRET_KEY_RE =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token|ciphertext|pat|github[_-]?token)$/i;

export function truncateToolText(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function sanitizeToolInput(input: unknown): unknown {
  if (typeof input === "string") return redactText(input);
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
    const s = typeof input === "string" ? redactText(input) : "";
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
    return cmd ? redactText(cmd).slice(0, 200) : "bash";
  }
  if (name === "fetch" || canonicalToolName(sdkName) === "fetch") {
    const url = str(rec.url) || str(rec.uri) || "";
    return url ? redactText(url).slice(0, 200) : "fetch";
  }
  if (name === "git_status") return "status";
  if (name === "git_diff") {
    const p = Array.isArray(rec.paths) ? rec.paths.filter((x) => typeof x === "string").join(" ") : "";
    return p ? `diff HEAD ${p}` : "diff HEAD";
  }
  if (name === "git_commit") {
    const msg = (str(rec.message) || "").slice(0, 80);
    const n = Array.isArray(rec.paths) ? rec.paths.length : 0;
    const pathsBit = n ? ` ${n} paths` : "";
    return msg ? `${msg}${pathsBit}` : `commit${pathsBit}`;
  }
  if (name === "git_push") {
    const remote = str(rec.remote) || "origin";
    const branch = str(rec.branch) || "";
    return branch ? `push ${remote} ${branch}` : `push ${remote}`;
  }
  if (name === "git_pr") {
    return str(rec.title) ? `PR ${str(rec.title)}` : "PR title";
  }
  if (name === "git_branch") {
    return str(rec.name) ? `branch ${str(rec.name)}` : "branch";
  }
  if (filePath) return filePath;
  try {
    return redactText(JSON.stringify(rec)).slice(0, 200);
  } catch {
    return name;
  }
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return truncateToolText(redactText(output));
  try {
    return truncateToolText(redactText(JSON.stringify(output, null, 2)));
  } catch {
    return truncateToolText(String(output));
  }
}

export function toolHeadline(sdkName: string, status: string, input?: unknown): string {
  const name = canonicalToolName(sdkName);
  const summary = input !== undefined ? summarizeToolInput(sdkName, input) : "";
  return summary && summary !== name
    ? `tool · ${name} · ${status}  ${summary}`
    : `tool · ${name} · ${status}`;
}
