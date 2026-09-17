export const REDACT_REPLACEMENT = "***";

const KEY_NAME =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token)$/i;

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

export function redactText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  return out;
}

export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactJson(v);
    }
    return out;
  }
  return value;
}
