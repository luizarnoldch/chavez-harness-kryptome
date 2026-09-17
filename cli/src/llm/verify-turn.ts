import type { ExecutionMode } from "./execution-mode";
import type { VerificationMetadata } from "./verify-constants";
import {
  VERIFY_CONTINUATION_MAX,
  VERIFY_SKIPPED_NO_RULE,
  VERIFY_TIMEOUT_ERROR,
  VERIFY_TIMEOUT_MS,
} from "./verify-constants";
import {
  classifyBashKind,
  extractBashCommand,
  promptAsksForTests,
  sameCommand,
} from "./verify-classify";
import { buildVerificationMetadata, isSilentSuccess } from "./verify-outcome";
import { runVerifyCommand } from "./verify-run";

export class VerifyTimeoutError extends Error {
  readonly code = "VERIFY_TIMEOUT" as const;

  constructor() {
    super(VERIFY_TIMEOUT_ERROR);
    this.name = "VerifyTimeoutError";
  }
}

export type VerifyToolEvent = {
  toolCallId: string;
  sdkName: string;
  input?: unknown;
  output?: string;
  status?: string;
};

export type TurnVerifyState = {
  mode: ExecutionMode;
  pactCommand: string | null;
  userAsked: boolean;
  mutated: boolean;
  verifyRan: boolean;
  last?: VerificationMetadata;
  inFlight: Map<
    string,
    { kind: "verify" | "lint"; command: string; startedAt: number }
  >;
  continuations: number;
};

export function createTurnVerifyState(input: {
  mode: ExecutionMode;
  pactCommand: string | null;
  prompt: string;
}): TurnVerifyState {
  return {
    mode: input.mode,
    pactCommand: input.pactCommand,
    userAsked: promptAsksForTests(input.prompt),
    mutated: false,
    verifyRan: false,
    inFlight: new Map(),
    continuations: 0,
  };
}

const WRITE_TOOLS = new Set(["write", "edit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);

export function noteToolStart(
  state: TurnVerifyState,
  ev: VerifyToolEvent,
): { kind: "verify" | "lint" | "bash" | "write" | "read"; command?: string } {
  const sdk = ev.sdkName.toLowerCase();
  if (WRITE_TOOLS.has(sdk)) {
    state.mutated = true;
    return { kind: "write" };
  }
  if (READ_TOOLS.has(sdk)) {
    return { kind: "read" };
  }
  if (sdk === "bash") {
    const command = extractBashCommand(ev.input);
    const kind = classifyBashKind(command);
    if (kind === "verify" || kind === "lint") {
      state.inFlight.set(ev.toolCallId, {
        kind,
        command,
        startedAt: Date.now(),
      });
      return { kind, command };
    }
    state.mutated = true;
    return { kind: "bash", command };
  }
  return { kind: "bash" };
}

export function noteToolResult(
  state: TurnVerifyState,
  ev: VerifyToolEvent,
): VerificationMetadata | null {
  const inflight = state.inFlight.get(ev.toolCallId);
  state.inFlight.delete(ev.toolCallId);
  if (!inflight) return null;

  const output = String(ev.output || "");
  const timedOut =
    ev.status === "error" &&
    (output.includes("timed out") || output.includes(VERIFY_TIMEOUT_ERROR));
  const exitMatch = /exit (\d+)/.exec(output);
  const isError = ev.status === "error" || timedOut;
  const exitCode = timedOut
    ? 124
    : exitMatch
      ? Number(exitMatch[1])
      : isError
        ? 1
        : 0;
  if (inflight.kind === "verify") {
    state.verifyRan = true;
  }
  const meta = buildVerificationMetadata({
    kind: inflight.kind,
    command: inflight.command || state.pactCommand || "test",
    exitCode,
    timedOut,
    source:
      state.pactCommand && sameCommand(inflight.command, state.pactCommand)
        ? "pact"
        : "agent",
    truncated: output.includes("[truncated:"),
  });
  state.last = meta;
  return meta;
}

export function shouldRunPact(state: TurnVerifyState): boolean {
  return (
    state.mode === "auto" &&
    state.mutated &&
    Boolean(state.pactCommand) &&
    !state.verifyRan
  );
}

export function skippedBecauseNoRule(
  state: TurnVerifyState,
): VerificationMetadata | null {
  if (
    state.mode !== "auto" ||
    !state.mutated ||
    state.pactCommand ||
    state.verifyRan
  ) {
    return null;
  }
  return {
    status: "skipped",
    kind: "verify",
    command: "",
    exitCode: null,
    timedOut: false,
    source: "pact",
    truncated: false,
  };
}

export async function runPactIfNeeded(
  state: TurnVerifyState,
  cwd: string,
): Promise<{
  ran: boolean;
  result?: Awaited<ReturnType<typeof runVerifyCommand>>;
  meta?: VerificationMetadata;
  skipReason?: string;
}> {
  if (!shouldRunPact(state)) {
    const skip = skippedBecauseNoRule(state);
    return {
      ran: false,
      skipReason: skip ? VERIFY_SKIPPED_NO_RULE : undefined,
      meta: skip ?? undefined,
    };
  }

  const result = await runVerifyCommand({
    cwd,
    command: state.pactCommand!,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  state.verifyRan = true;
  const meta = buildVerificationMetadata({
    kind: "verify",
    command: state.pactCommand!,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    source: "pact",
    truncated: result.truncated,
  });
  state.last = meta;
  return { ran: true, result, meta };
}

export function shouldExplain(
  state: TurnVerifyState,
  assistantText: string,
): boolean {
  if (!state.last || state.last.status !== "failed") return false;
  if (state.continuations >= VERIFY_CONTINUATION_MAX) return false;
  return isSilentSuccess(assistantText, state.last) || !assistantText.trim();
}

export function stampSilentSuccess(
  state: TurnVerifyState,
  assistantText: string,
): VerificationMetadata | undefined {
  if (!state.last) return undefined;
  if (isSilentSuccess(assistantText, state.last)) {
    state.last = { ...state.last, silentSuccess: true };
  }
  return state.last;
}

export function watchdogTimedOut(
  state: TurnVerifyState,
  now = Date.now(),
): { toolCallId: string; command: string; kind: "verify" | "lint" } | null {
  for (const [toolCallId, rec] of state.inFlight) {
    if (now - rec.startedAt >= VERIFY_TIMEOUT_MS) {
      return { toolCallId, command: rec.command, kind: rec.kind };
    }
  }
  return null;
}
