export type CiExitCode = 0 | 1 | 2;

export type CiTurnOutcome = {
  finished: boolean;
  streamEnd: boolean;
  streamError: string | null;
  providerError: string | null;
  timedOut: boolean;
  busy: boolean;
  askRejected: boolean;
  verificationStatus: "failed" | "timeout" | "passed" | "skipped" | null;
  assistantText: string;
};

export type CiEvent =
  | { kind: "tool"; name: string; status: string; output?: string }
  | { kind: "assistant_delta"; text: string }
  | {
      kind: "stream_end";
      content?: string;
      verificationStatus?: CiTurnOutcome["verificationStatus"];
    }
  | { kind: "stream_error"; error: string }
  | { kind: "turn_ended"; status?: string }
  | { kind: "provider_error"; error: string }
  | { kind: "busy" }
  | { kind: "timeout" };
