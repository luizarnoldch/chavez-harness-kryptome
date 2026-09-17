import { PTY_STRIP_ENV } from "./constants";

export function sanitizePtyEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = new Set(PTY_STRIP_ENV.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (strip.has(k.toLowerCase())) continue;
    if (/(api[_-]?key|secret|token|password|authorization)/i.test(k)) continue;
    out[k] = v;
  }
  out.TERM = out.TERM || "xterm-256color";
  out.COLORTERM = out.COLORTERM || "truecolor";
  return out;
}
