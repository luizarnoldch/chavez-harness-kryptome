import type { ExecutionMode } from "./execution-mode";
import { denyIfIgnored } from "./tool-ignore";
import { denyIfEscapes } from "./tool-sandbox";
import { denyIfBashEscapes } from "./bash-fs";
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
import { gateNetwork } from "./network-gate";
import { NETWORK_DENIED_ASK } from "./network-constants";
import {
  bashCommandFromInput,
  isBashSdkName,
} from "./network-classify";
import { wrapCommandString } from "./sandbox-wrap";
import { isMemoryToolName } from "./memory-constants";

export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      needsNetwork?: boolean;
    }
  | { behavior: "deny"; message: string };

export type AskFn = (req: {
  needsNetwork: boolean;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export type AskPermission = (req: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  proposed?: ReturnType<TurnDiffCollector["propose"]>;
  needsNetwork?: boolean;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

function allowBashOrOther(input: {
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  grantedNetwork: boolean;
  extra?: Record<string, unknown>;
}): PermissionDecision {
  if (isBashSdkName(input.toolName)) {
    const command = bashCommandFromInput(input.toolInput);
    const wrapped = wrapCommandString({
      cwd: input.cwd,
      network: input.grantedNetwork,
      command,
    });
    return {
      behavior: "allow",
      needsNetwork: input.grantedNetwork,
      updatedInput: {
        ...input.toolInput,
        ...input.extra,
        command: wrapped,
        dangerouslyDisableSandbox: input.grantedNetwork,
      },
    };
  }
  return {
    behavior: "allow",
    needsNetwork: input.grantedNetwork,
    updatedInput: input.extra
      ? { ...input.toolInput, ...input.extra }
      : undefined,
  };
}

async function resolveAsk(
  ask: AskFn | undefined,
  needsNetwork: boolean,
): Promise<"approve" | "deny" | "timeout" | "cancelled"> {
  return (await ask?.({ needsNetwork })) ?? "deny";
}

function denyFromAskOutcome(
  outcome: "deny" | "timeout" | "cancelled",
  networkAsk: boolean,
): PermissionDecision {
  const message =
    outcome === "timeout"
      ? ASK_TIMEOUT_DENIED
      : networkAsk
        ? NETWORK_DENIED_ASK
        : ASK_DENIED;
  return { behavior: "deny", message };
}

/**
 * Apply network gate after mutation/verify decisions.
 * Returns a deny decision, or null if allowed (with grantedNetwork).
 */
async function afterMutationNetwork(input: {
  cwd: string;
  executionMode: ExecutionMode;
  toolName: string;
  toolInput: Record<string, unknown>;
  ask?: AskFn;
  mutationAsks: boolean;
}): Promise<
  | { kind: "deny"; decision: PermissionDecision }
  | { kind: "allow"; grantedNetwork: boolean }
> {
  const net = gateNetwork(
    input.executionMode,
    input.toolName,
    input.toolInput,
  );
  if (net.action === "deny") {
    return {
      kind: "deny",
      decision: {
        behavior: "deny",
        message: net.message || PLAN_MUTATION_DENIED,
      },
    };
  }

  const needsAsk = input.mutationAsks || net.action === "ask";
  if (needsAsk) {
    const outcome = await resolveAsk(input.ask, net.network);
    if (outcome !== "approve") {
      return {
        kind: "deny",
        decision: denyFromAskOutcome(outcome, net.action === "ask"),
      };
    }
    return { kind: "allow", grantedNetwork: net.network };
  }

  return { kind: "allow", grantedNetwork: false };
}

export async function decideCanUseTool(input: {
  cwd: string;
  executionMode?: ExecutionMode | string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ask?: AskFn;
  rulesBundle?: RulesBundle;
  subagentBudget?: SubagentBudget;
}): Promise<PermissionDecision> {
  if (isMemoryToolName(input.toolName)) {
    return { behavior: "allow" };
  }
  const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
  if (denied) return denied;
  const ignored = denyIfIgnored(input.cwd, input.toolName, input.toolInput);
  if (ignored) return ignored;
  const bashFs = denyIfBashEscapes(input.cwd, input.toolName, input.toolInput);
  if (bashFs) return bashFs;

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
    const outcome = await resolveAsk(input.ask, false);
    if (outcome === "approve") return { behavior: "allow" };
    return denyFromAskOutcome(outcome, false);
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
    const outcome = await resolveAsk(input.ask, false);
    if (outcome === "approve") return { behavior: "allow" };
    return denyFromAskOutcome(outcome, false);
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
    if (vg.decision === "ask" || vg.decision === "allow") {
      const netStep = await afterMutationNetwork({
        cwd: input.cwd,
        executionMode: mode,
        toolName: input.toolName,
        toolInput: input.toolInput,
        ask: input.ask,
        mutationAsks: vg.decision === "ask",
      });
      if (netStep.kind === "deny") return netStep.decision;
      const extra =
        vg.decision === "allow"
          ? { timeout: VERIFY_TIMEOUT_MS, ...(vg.updatedInput || {}) }
          : { timeout: VERIFY_TIMEOUT_MS };
      // Prefer original command for wrap; timeout from verify.
      const { command: _c, ...restExtra } = extra as Record<string, unknown> & {
        command?: string;
      };
      return allowBashOrOther({
        cwd: input.cwd,
        toolName: input.toolName,
        toolInput: input.toolInput,
        grantedNetwork: netStep.grantedNetwork,
        extra: { ...restExtra, timeout: VERIFY_TIMEOUT_MS },
      });
    }
    // passthrough → fall through to gateMutation
  }
  const g = gateMutation(mode, input.toolName, input.toolInput);
  if (g.decision === "deny") {
    return { behavior: "deny", message: g.message || PLAN_MUTATION_DENIED };
  }

  const netStep = await afterMutationNetwork({
    cwd: input.cwd,
    executionMode: mode,
    toolName: input.toolName,
    toolInput: input.toolInput,
    ask: input.ask,
    mutationAsks: g.decision === "ask",
  });
  if (netStep.kind === "deny") return netStep.decision;

  return allowBashOrOther({
    cwd: input.cwd,
    toolName: input.toolName,
    toolInput: input.toolInput,
    grantedNetwork: netStep.grantedNetwork,
  });
}

/**
 * Snapshot-before-mutate canUseTool. Gate order is fixed:
 * sandbox → ignore → bash-fs → mode gate → network → (ask) → wrap → allow.
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
    if (isMemoryToolName(toolName)) {
      return { behavior: "allow" };
    }
    const toolCallId = String(toolOpts?.toolUseID || crypto.randomUUID());
    const ask: AskFn | undefined = opts.onAskPermission
      ? async ({ needsNetwork }) => {
          const proposed = opts.collector.propose(toolName, toolInput, toolCallId);
          return opts.onAskPermission!({
            toolCallId,
            toolName,
            input: toolInput,
            signal: toolOpts?.signal ?? new AbortController().signal,
            proposed,
            needsNetwork,
          });
        }
      : undefined;

    const decision = await decideCanUseTool({
      cwd: opts.cwd,
      executionMode: mode,
      toolName,
      toolInput,
      ask,
      rulesBundle: opts.rulesBundle,
      subagentBudget: opts.subagentBudget,
    });

    if (decision.behavior === "deny") {
      opts.collector.dropProposed(toolCallId);
      return decision;
    }

    const updated = decision.updatedInput ?? toolInput;
    await opts.collector.beforeAllow(toolName, updated, toolCallId);
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput,
    };
  };
}
