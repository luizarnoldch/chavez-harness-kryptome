import type { ExecutionMode } from "./execution-mode";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import {
  PLAN_VERIFY_MUTATION_DENIED,
  VERIFY_TIMEOUT_MS,
  type VerifyKind,
} from "./verify-constants";
import {
  classifyBashKind,
  extractBashCommand,
  isMutatingVerify,
} from "./verify-classify";

export type VerifyGate = {
  kind: VerifyKind;
  command: string;
  mutating: boolean;
  decision: "allow" | "deny" | "ask" | "passthrough";
  message?: string;
  updatedInput?: Record<string, unknown>;
};

export function gateVerifyBash(input: {
  mode: ExecutionMode;
  sdkName: string;
  toolInput: Record<string, unknown> | null;
}): VerifyGate {
  const command = extractBashCommand(input.toolInput);
  const kind =
    input.sdkName === "Bash" || input.sdkName === "bash"
      ? classifyBashKind(command)
      : "bash";
  const mutating = kind !== "bash" && isMutatingVerify(command);

  if (kind === "bash") {
    return { kind, command, mutating: false, decision: "passthrough" };
  }

  if (input.mode === "plan") {
    return {
      kind,
      command,
      mutating,
      decision: "deny",
      message: mutating
        ? PLAN_VERIFY_MUTATION_DENIED
        : PLAN_MUTATION_DENIED,
    };
  }

  if (input.mode === "ask") {
    return { kind, command, mutating, decision: "ask" };
  }

  return {
    kind,
    command,
    mutating,
    decision: "allow",
    updatedInput: {
      ...(input.toolInput || {}),
      command,
      timeout: VERIFY_TIMEOUT_MS,
    },
  };
}
