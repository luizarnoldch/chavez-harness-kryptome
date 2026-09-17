import {
  ASK_CI_INVALID,
  CI_BUSY,
  CI_EXIT_ASK,
  CI_EXIT_FAIL,
  CI_EXIT_OK,
  CI_TIMEOUT,
} from "./constants";
import type { CiEvent, CiExitCode, CiTurnOutcome } from "./types";

export type { CiEvent, CiExitCode, CiTurnOutcome };

export function emptyOutcome(): CiTurnOutcome {
  return {
    finished: false,
    streamEnd: false,
    streamError: null,
    providerError: null,
    timedOut: false,
    busy: false,
    askRejected: false,
    verificationStatus: null,
    assistantText: "",
  };
}

export function foldCiEvents(
  events: CiEvent[],
  base: CiTurnOutcome = emptyOutcome(),
): CiTurnOutcome {
  const out: CiTurnOutcome = { ...base, assistantText: base.assistantText };
  for (const ev of events) {
    if (ev.kind === "assistant_delta") out.assistantText += ev.text;
    if (ev.kind === "stream_end") {
      out.streamEnd = true;
      out.finished = true;
      if (ev.content) out.assistantText = out.assistantText || ev.content;
      if (ev.verificationStatus) out.verificationStatus = ev.verificationStatus;
    }
    if (ev.kind === "stream_error") {
      out.streamError = ev.error;
      out.finished = true;
    }
    if (ev.kind === "turn_ended") {
      out.finished = true;
    }
    if (ev.kind === "provider_error") {
      out.providerError = ev.error;
      out.finished = true;
    }
    if (ev.kind === "busy") out.busy = true;
    if (ev.kind === "timeout") {
      out.timedOut = true;
      out.finished = true;
    }
  }
  return out;
}

export function ciExitCode(outcome: CiTurnOutcome): CiExitCode {
  if (outcome.askRejected) return CI_EXIT_ASK;
  if (outcome.timedOut) return CI_EXIT_FAIL;
  if (outcome.busy && !outcome.streamEnd) return CI_EXIT_FAIL;
  if (outcome.providerError) return CI_EXIT_FAIL;
  if (outcome.streamError) return CI_EXIT_FAIL;
  if (
    outcome.verificationStatus === "failed" ||
    outcome.verificationStatus === "timeout"
  ) {
    return CI_EXIT_FAIL;
  }
  if (outcome.streamEnd) return CI_EXIT_OK;
  return CI_EXIT_FAIL;
}

export function ciFailReason(outcome: CiTurnOutcome): string {
  if (outcome.askRejected) return ASK_CI_INVALID;
  if (outcome.timedOut) return CI_TIMEOUT;
  if (outcome.busy && !outcome.streamEnd) return CI_BUSY;
  if (outcome.providerError) return outcome.providerError;
  if (outcome.streamError) return outcome.streamError;
  if (outcome.verificationStatus === "failed") {
    return "verification failed";
  }
  if (outcome.verificationStatus === "timeout") {
    return "verification timed out";
  }
  if (!outcome.finished || !outcome.streamEnd) {
    return "turn did not finish";
  }
  return "";
}
