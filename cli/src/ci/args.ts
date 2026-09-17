import {
  ASK_CI_INVALID,
  CI_TURN_TIMEOUT_MAX_MS,
  CI_TURN_TIMEOUT_MS,
  CI_USAGE,
} from "./constants";
import { CiCliError } from "./errors";
import { INVALID_MODE_ERROR } from "../llm/execution-mode";

export type ParsedCiArgs = {
  prompt: string;
  chatId: string | null;
  sessionId: string | null;
  modeFlag: "auto" | "plan" | "ask" | undefined;
  timeoutMs: number;
  forceCi: boolean;
  readStdin: boolean;
};

export type CiResolvedMode =
  | { ok: true; mode: "auto" | "plan"; putPrefs: boolean }
  | { ok: false; error: typeof ASK_CI_INVALID };

function capTimeout(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return CI_TURN_TIMEOUT_MS;
  return Math.min(raw, CI_TURN_TIMEOUT_MAX_MS);
}

export function parseCiArgs(argv: string[]): ParsedCiArgs {
  let chatId: string | null = null;
  let sessionId: string | null = null;
  let modeFlag: ParsedCiArgs["modeFlag"];
  let timeoutMs = CI_TURN_TIMEOUT_MS;
  let forceCi = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ci") {
      forceCi = true;
      continue;
    }
    if (a === "--mode") {
      const v = argv[++i];
      if (v !== "auto" && v !== "plan" && v !== "ask") {
        throw new CiCliError(INVALID_MODE_ERROR);
      }
      modeFlag = v;
      continue;
    }
    if (a.startsWith("--mode=")) {
      const v = a.slice("--mode=".length);
      if (v !== "auto" && v !== "plan" && v !== "ask") {
        throw new CiCliError(INVALID_MODE_ERROR);
      }
      modeFlag = v;
      continue;
    }
    if (a === "--chat") {
      chatId = argv[++i] || null;
      continue;
    }
    if (a.startsWith("--chat=")) {
      chatId = a.slice("--chat=".length) || null;
      continue;
    }
    if (a === "--session") {
      sessionId = argv[++i] || null;
      continue;
    }
    if (a.startsWith("--session=")) {
      sessionId = a.slice("--session=".length) || null;
      continue;
    }
    if (a === "--timeout") {
      timeoutMs = capTimeout(Number(argv[++i]));
      continue;
    }
    if (a.startsWith("--timeout=")) {
      timeoutMs = capTimeout(Number(a.slice("--timeout=".length)));
      continue;
    }
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    positional.push(a);
  }

  const joined = positional.join(" ").trim();
  return {
    prompt: joined === "-" ? "" : joined,
    chatId,
    sessionId,
    modeFlag,
    timeoutMs,
    forceCi,
    readStdin: joined === "-" || (joined === "" && positional.length === 0),
  };
}

export function assertCiUsage(args: ParsedCiArgs, prompt: string): void {
  if (!prompt.trim()) throw new CiCliError(CI_USAGE);
}

function asMode(v: unknown): "auto" | "plan" | "ask" | "unset" {
  if (v === "auto" || v === "plan" || v === "ask") return v;
  return "unset";
}

export function resolveCiMode(input: {
  flag?: "auto" | "plan" | "ask";
  envMode?: string;
  prefsMode?: unknown;
}): CiResolvedMode {
  if (input.flag === "ask") return { ok: false, error: ASK_CI_INVALID };
  if (input.flag === "auto" || input.flag === "plan") {
    return { ok: true, mode: input.flag, putPrefs: true };
  }
  const envMode = asMode(input.envMode);
  if (envMode === "ask") return { ok: false, error: ASK_CI_INVALID };
  if (envMode === "auto" || envMode === "plan") {
    return { ok: true, mode: envMode, putPrefs: true };
  }
  const prefs = asMode(input.prefsMode);
  if (prefs === "ask") return { ok: false, error: ASK_CI_INVALID };
  if (prefs === "auto" || prefs === "plan") {
    return { ok: true, mode: prefs, putPrefs: false };
  }
  return { ok: true, mode: "auto", putPrefs: false };
}
