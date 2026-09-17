import type { VerifyKind } from "./verify-constants";
import { VERIFY_CMD_MAX_CHARS } from "./verify-constants";

const VERIFY_RUNNERS = [
  "npm test",
  "npm run test",
  "npx vitest",
  "npx jest",
  "npx mocha",
  "pnpm test",
  "pnpm run test",
  "yarn test",
  "yarn run test",
  "bun test",
  "bun run test",
  "cargo test",
  "go test",
  "pytest",
  "python -m pytest",
  "python -m unittest",
  "mvn test",
  "gradle test",
  "dotnet test",
  "make test",
  "rake test",
  "mix test",
] as const;

const LINT_RUNNERS = [
  "eslint",
  "biome check",
  "biome lint",
  "ruff check",
  "ruff",
  "flake8",
  "pylint",
  "mypy",
  "tsc --noemit",
  "tsc -b --noemit",
  "typos",
  "shellcheck",
  "clippy",
  "cargo clippy",
  "prettier --check",
  "golangci-lint",
  "rubocop",
  "ktlint",
  "deno lint",
] as const;

const MUTATING_FLAGS = [
  "--coverage",
  "--collectcoverage",
  "--collect-coverage",
  "--updatesnapshot",
  "--update-snapshots",
  "--snapshot-update",
  "--watchall",
  "--watch-all",
  "--watch",
] as const;

function stripEnvPrefix(cmd: string): string {
  return cmd.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/,
    "",
  );
}

function normalizeCommand(raw: string): string {
  return stripEnvPrefix(raw.trim().replace(/\s+/g, " ")).slice(
    0,
    VERIFY_CMD_MAX_CHARS,
  );
}

function haystack(cmd: string): string {
  return normalizeCommand(cmd).toLowerCase();
}

function startsWithRunner(cmd: string, runner: string): boolean {
  const h = haystack(cmd);
  const r = runner.toLowerCase();
  return h === r || h.startsWith(`${r} `) || h.includes(` ${r} `);
}

export function classifyBashKind(command: string): VerifyKind {
  const h = haystack(command);
  if (!h) return "bash";
  for (const r of LINT_RUNNERS) {
    if (startsWithRunner(h, r)) return "lint";
  }
  // tsc without --noEmit is still lint-ish when invoked as typecheck
  if (/\btsc\b/.test(h) && /--noemit|--pretty\s+false/.test(h)) return "lint";
  for (const r of VERIFY_RUNNERS) {
    if (startsWithRunner(h, r)) return "verify";
  }
  if (/\b(vitest|jest|mocha|pytest)\b/.test(h)) return "verify";
  return "bash";
}

export function isMutatingVerify(command: string): boolean {
  const h = haystack(command);
  if (h.includes("coverage/") || /\bnyc\b/.test(h) || /\bc8\b/.test(h)) {
    return true;
  }
  for (const f of MUTATING_FLAGS) {
    if (h.includes(f)) return true;
  }
  const jestOrVitest = /\b(jest|vitest)\b/.test(h);
  if (jestOrVitest && /(^|\s)-u(\s|$)/.test(h)) return true;
  return false;
}

export function extractBashCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const cmd = rec.command ?? rec.cmd ?? rec.shell;
  return typeof cmd === "string" ? cmd : "";
}

const ASK_TEST_RE =
  /\b((run|corre[rn]?|ejecuta)\b.{0,40}\btests?|\btests?\b.{0,20}\b(por\s?fa|please)?|npm\s+test|bun\s+test|cargo\s+test|pytest)\b/i;

export function promptAsksForTests(prompt: string): boolean {
  return ASK_TEST_RE.test(prompt);
}

/** User typed the command themselves — not an invented suite. */
export function extractExplicitTestCommand(prompt: string): string | null {
  const m =
    /(?:run|corre(?:r)?|ejecuta)\s+(`[^`]+`|npm test(?:[^\n]*)|bun test(?:[^\n]*)|pnpm test(?:[^\n]*)|yarn test(?:[^\n]*)|cargo test(?:[^\n]*)|go test(?:[^\n]*)|pytest(?:[^\n]*)|make test(?:[^\n]*))/i.exec(
      prompt,
    );
  if (!m?.[1]) return null;
  const cmd = m[1].replace(/^`|`$/g, "").trim();
  return cmd ? normalizeCommand(cmd) : null;
}

export function sameCommand(a: string, b: string): boolean {
  return haystack(a) === haystack(b);
}
