import type { ExecutionMode } from "./execution-mode";
import { denyIfIgnored } from "./tool-ignore";
import { denyIfEscapes } from "./tool-sandbox";
import { gateMutation } from "./execution-gate";
import { gateGitTool } from "./git-can-use";
import { isReadSdkName } from "./approval-constants";
import {
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  PLAN_MUTATION_DENIED,
} from "./execution-mode";
import type { TurnDiffCollector } from "./turn-diff-collector";
import { denyIfRuleDisallowed, type RulesBundle } from "./rules-merge";
import { canonicalToolName } from "./tool-names";
import { gateVerifyBash } from "./verify-gate";
import { VERIFY_TIMEOUT_MS } from "./verify-constants";
import { annotationsFromUnknown } from "./mcp-classify";
import { gateMcpTool } from "./mcp-gate";
import { isSubagentSpawnTool } from "./subagent-constants";
import {
  trySpawnSubagent,
  type SubagentBudget,
} from "./subagent-budget";

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
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
  rulesBundle?: RulesBundle;
  subagentBudget?: SubagentBudget;
}): Promise<PermissionDecision> {
  const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
  if (denied) return denied;
  const ignored = denyIfIgnored(input.cwd, input.toolName, input.toolInput);
  if (ignored) return ignored;
  const mode = (input.executionMode || "ask") as ExecutionMode;
  const git = gateGitTool(mode, input.toolName, input.toolInput);
  if (git.decision === "deny") return { behavior: "deny", message: git.message };
  if (input.rulesBundle) {
    const ruleDenied = denyIfRuleDisallowed(
      input.rulesBundle,
      canonicalToolName(input.toolName),
    );
    if (ruleDenied) return ruleDenied;
  }
  if (git.decision === "allow") return { behavior: "allow" };
  if (git.decision === "ask") {
    const outcome = (await input.ask?.()) ?? "deny";
    if (outcome === "approve") return { behavior: "allow" };
    return {
      behavior: "deny",
      message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
    };
  }
  if (isSubagentSpawnTool(input.toolName) && input.subagentBudget) {
    const depth = input.toolInput.agent_id ? 2 : 1;
    const spawned = trySpawnSubagent(input.subagentBudget, depth);
    if (!spawned.ok) {
      return { behavior: "deny", message: spawned.message };
    }
    Object.assign(input.subagentBudget, spawned.next);
    return { behavior: "allow" };
  }
  const mcp = gateMcpTool(
    mode,
    input.toolName,
    annotationsFromUnknown(input.toolInput.annotations),
  );
  if (mcp.decision === "allow") return { behavior: "allow" };
  if (mcp.decision === "deny") {
    return { behavior: "deny", message: mcp.message };
  }
  if (mcp.decision === "ask") {
    const outcome = (await input.ask?.()) ?? "deny";
    if (outcome === "approve") return { behavior: "allow" };
    return {
      behavior: "deny",
      message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
    };
  }
  if (isReadSdkName(input.toolName)) {
    return { behavior: "allow" };
  }
  if (input.toolName === "Bash" || input.toolName === "bash") {
    const vg = gateVerifyBash({
      mode,
      sdkName: input.toolName,
      toolInput: input.toolInput,
    });
    if (vg.decision === "deny") {
      return { behavior: "deny", message: vg.message || PLAN_MUTATION_DENIED };
    }
    if (vg.decision === "ask") {
      const outcome = (await input.ask?.()) ?? "deny";
      if (outcome === "approve") {
        return {
          behavior: "allow",
          updatedInput: {
            ...input.toolInput,
            timeout: VERIFY_TIMEOUT_MS,
          },
        };
      }
      return {
        behavior: "deny",
        message: outcome === "timeout" ? ASK_TIMEOUT_DENIED : ASK_DENIED,
      };
    }
    if (vg.decision === "allow") {
      return { behavior: "allow", updatedInput: vg.updatedInput };
    }
  }
  const g = gateMutation(mode, input.toolName, input.toolInput);
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
  rulesBundle?: RulesBundle;
  subagentBudget?: SubagentBudget;
}): (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOpts: { signal: AbortSignal; toolUseID?: string },
) => Promise<{
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}> {
  const mode: ExecutionMode = opts.executionMode ?? "auto";
  return async (toolName, toolInput, toolOpts) => {
    const toolCallId = String(toolOpts?.toolUseID || crypto.randomUUID());
    const denied = denyIfEscapes(opts.cwd, toolName, toolInput);
    if (denied) return denied;
    const ignored = denyIfIgnored(opts.cwd, toolName, toolInput);
    if (ignored) return ignored;
    const git = gateGitTool(mode, toolName, toolInput);
    if (git.decision === "deny") {
      return { behavior: "deny", message: git.message };
    }
    if (opts.rulesBundle) {
      const ruleDenied = denyIfRuleDisallowed(
        opts.rulesBundle,
        canonicalToolName(toolName),
      );
      if (ruleDenied) return ruleDenied;
    }
    if (git.decision === "allow") return { behavior: "allow" };
    if (isSubagentSpawnTool(toolName) && opts.subagentBudget) {
      const depth = toolInput.agent_id ? 2 : 1;
      const spawned = trySpawnSubagent(opts.subagentBudget, depth);
      if (!spawned.ok) {
        return { behavior: "deny", message: spawned.message };
      }
      Object.assign(opts.subagentBudget, spawned.next);
      return { behavior: "allow" };
    }
    const mcp = gateMcpTool(
      mode,
      toolName,
      annotationsFromUnknown(toolInput.annotations),
    );
    if (mcp.decision === "deny") {
      return { behavior: "deny", message: mcp.message };
    }
    if (mcp.decision === "allow") return { behavior: "allow" };
    if (toolName === "Bash" || toolName === "bash") {
      const vg = gateVerifyBash({
        mode,
        sdkName: toolName,
        toolInput,
      });
      if (vg.decision === "deny") {
        return { behavior: "deny", message: vg.message || PLAN_MUTATION_DENIED };
      }
      if (vg.decision === "ask") {
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
        const updatedInput = {
          ...toolInput,
          timeout: VERIFY_TIMEOUT_MS,
        };
        await opts.collector.beforeAllow(toolName, updatedInput, toolCallId);
        return { behavior: "allow", updatedInput };
      }
      if (vg.decision === "allow") {
        const updatedInput = vg.updatedInput ?? toolInput;
        await opts.collector.beforeAllow(toolName, updatedInput, toolCallId);
        return { behavior: "allow", updatedInput };
      }
    }
    const g =
      git.decision === "ask" || mcp.decision === "ask"
        ? { decision: "ask" as const }
        : gateMutation(mode, toolName, toolInput);
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
