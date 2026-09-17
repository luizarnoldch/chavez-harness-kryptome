export const REDACT_REPLACEMENT = "***";

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
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const ENV_LINE =
  /^([A-Za-z_][A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH)[A-Za-z0-9_]*)\s*=\s*(.+)$/gm;

const VAULT_PATH_RE = /(?:^|[^\w.])(?:~\/)?\.chavez\/[A-Za-z0-9._\-\/]+/g;

export function redactText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  out = out.replace(ENV_LINE, `$1=${REDACT_REPLACEMENT}`);
  out = out.replace(VAULT_PATH_RE, (m) => {
    const prefix = m[0] === "~" || m[0] === "." ? "" : m[0];
    return `${prefix}${REDACT_REPLACEMENT}`;
  });
  return out;
}

export function redactEnvValues(input: string): string {
  return input.replace(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/gm, (full, k, v) => {
    if (v === "" || v === REDACT_REPLACEMENT) return full;
    return `${k}=${REDACT_REPLACEMENT}`;
  });
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

export function looksLikeSecretText(input: string): boolean {
  if (PATTERNS.some((re) => new RegExp(re.source, re.flags).test(input))) return true;
  ENV_LINE.lastIndex = 0;
  return ENV_LINE.test(input);
}
