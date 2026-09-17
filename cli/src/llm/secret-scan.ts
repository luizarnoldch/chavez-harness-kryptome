import { looksLikeSecretText, redactEnvValues, redactText } from "./redact";
import type { IgnoreClass } from "./ignore-patterns";

export function redactByClass(text: string, cls: IgnoreClass): string {
  if (cls === "vault") return "***";
  if (cls === "secret") return redactEnvValues(redactText(text));
  return redactText(text);
}

export function containsSecret(text: string): boolean {
  return looksLikeSecretText(text);
}

/** Drop any line that names the Chavez vault config. */
export function stripVaultLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/\.chavez\/config\.json|CHAVEZ_ACCESS_TOKEN/i.test(line))
    .join("\n");
}
