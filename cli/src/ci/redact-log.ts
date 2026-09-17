/** keep-in-sync PATTERNS: cli/src/llm/redact.ts, api/src/lib/redact.ts */

import { REDACT_REPLACEMENT, redactText } from "../llm/redact";

export { REDACT_REPLACEMENT };

const BEARER = /Bearer\s+[A-Za-z0-9._\-]+/g;

export function redactCiLog(
  input: string,
  extras: Array<string | undefined | null> = [],
): string {
  let out = redactText(input);
  out = out.replace(new RegExp(BEARER.source, BEARER.flags), REDACT_REPLACEMENT);
  for (const secret of extras) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACT_REPLACEMENT);
  }
  return out;
}

export function collectCiSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const k of [
    "CHAVEZ_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CURSOR_API_KEY",
  ]) {
    const v = env[k];
    if (v && v.length >= 8) out.push(v);
  }
  return out;
}
