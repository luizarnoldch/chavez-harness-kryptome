import type { ExecutionMode } from "./execution-mode";
import { denyIfIgnored } from "./tool-ignore";
import { denyIfEscapes } from "./tool-sandbox";
import { gateMutation } from "./execution-gate";
import {
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
  PLAN_MUTATION_DENIED,
} from "./execution-mode";

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export async function decideCanUseTool(input: {
  cwd: string;
  executionMode: ExecutionMode;
  toolName: string;
  toolInput: Record<string, unknown>;
  ask?: () => Promise<"approve" | "deny" | "timeout" | "cancelled">;
}): Promise<PermissionDecision> {
  const denied = denyIfEscapes(input.cwd, input.toolName, input.toolInput);
  if (denied) return denied;
  const ignored = denyIfIgnored(input.cwd, input.toolName, input.toolInput);
  if (ignored) return ignored;
  const g = gateMutation(input.executionMode, input.toolName);
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
