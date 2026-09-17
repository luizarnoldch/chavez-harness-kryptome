import type { ExecutionMode } from "./execution-mode";
import { denyIfIgnored } from "./tool-ignore";
import { denyIfEscapes } from "./tool-sandbox";
import { gateMutation } from "./execution-gate";
import { isReadSdkName } from "./approval-constants";
import {
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  PLAN_MUTATION_DENIED,
} from "./execution-mode";
import type { TurnDiffCollector } from "./turn-diff-collector";

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export type AskPermission = (req: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  proposed?: ReturnType<TurnDiffCollector["propose"]>;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export async function decideCanUseTool(input: {
  cwd: string;
  executionMode?: ExecutionMode | string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ask?: () => Promise<"approve" | "deny" | "timeout" | "cancelled">;
}): Promise<PermissionDecision> {
  const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
  if (denied) return denied;
  const ignored = denyIfIgnored(input.cwd, input.toolName, input.toolInput);
  if (ignored) return ignored;
  if (isReadSdkName(input.toolName)) {
    return { behavior: "allow" };
  }
  const mode = (input.executionMode || "ask") as ExecutionMode;
  const g = gateMutation(mode, input.toolName);
  if (g.decision === "allow") return { behavior: "allow" };
  if (g.decision === "deny") {
    return { behavior: "deny", message: g.message || PLAN_MUTATION_DENIED };
  }
  const outcome = (await input.ask?.()) ?? "deny";
  if (outcome === "approve") return { behavior: "allow" };
  return {
    behavior: "deny",
    message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
  };
}

/**
 * Snapshot-before-mutate canUseTool. Gate order is fixed:
 * sandbox → ignore → mode gate → (ask: propose then wait) → beforeAllow → allow.
 * Plan denies without snapshot.
 */
export function buildCanUseTool(opts: {
  cwd: string;
  executionMode?: ExecutionMode;
  collector: TurnDiffCollector;
  onAskPermission?: AskPermission;
}): (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOpts: { signal: AbortSignal; toolUseID?: string },
) => Promise<{ behavior: "allow" | "deny"; message?: string }> {
  const mode: ExecutionMode = opts.executionMode ?? "auto";
  return async (toolName, toolInput, toolOpts) => {
    const toolCallId = String(toolOpts?.toolUseID || crypto.randomUUID());
    const denied = denyIfEscapes(opts.cwd, toolName, toolInput);
    if (denied) return denied;
    const ignored = denyIfIgnored(opts.cwd, toolName, toolInput);
    if (ignored) return ignored;
    const g = gateMutation(mode, toolName);
    if (g.decision === "deny") {
      return { behavior: "deny", message: g.message || PLAN_MUTATION_DENIED };
    }
    if (g.decision === "ask" && !isReadSdkName(toolName)) {
      const proposed = opts.collector.propose(toolName, toolInput, toolCallId);
      const outcome = opts.onAskPermission
        ? await opts.onAskPermission({
            toolCallId,
            toolName,
            input: toolInput,
            signal: toolOpts?.signal ?? new AbortController().signal,
            proposed,
          })
        : "deny";
      if (outcome !== "approve") {
        opts.collector.dropProposed(toolCallId);
        return {
          behavior: "deny",
          message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
        };
      }
    }
    await opts.collector.beforeAllow(toolName, toolInput, toolCallId);
    return { behavior: "allow" };
  };
}
