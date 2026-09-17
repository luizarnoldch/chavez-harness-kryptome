export const REDACT_REPLACEMENT = "***";

export const HUGE_FILE_BYTES = 8_000_000;
export const HUGE_BINARY_BYTES = 1_000_000;

export const HARNESS_JUNK_DIR_NAMES = [
  ".git",
  "node_modules",
  "dist",
  ".next",
  "target",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  ".output",
  ".cache",
] as const;

/** gitignore-style. Applied as secret class; `!` exceptions are secret-safe examples. */
export const HARNESS_SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "!**/.env.sample",
  "!**/.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa.pub",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  "**/.aws/credentials",
  "**/credentials.json",
  "**/secrets.json",
  "**/*-service-account.json",
] as const;

export const VAULT_DIR_NAME = ".chavez";

export type IgnoreClass = "none" | "junk" | "secret" | "vault" | "huge";

export function reasonForClass(cls: IgnoreClass, extra?: string): string {
  if (cls === "vault") return "chavez vault";
  if (cls === "secret") return extra || "harness secret";
  if (cls === "huge") return extra || "huge file";
  if (cls === "junk") return extra || "ignored";
  return extra || "";
}
