import type { ExecutionMode } from "./execution-mode";
import {
  NETWORK_DENIED_ASK,
  NETWORK_DENIED_AUTO,
  NETWORK_DENIED_PLAN,
} from "./network-constants";
import { toolNeedsNetwork } from "./network-classify";

export type NetworkAction = "allow" | "deny" | "ask";

export type NetworkGate = {
  action: NetworkAction;
  network: boolean;
  message?: string;
};

/**
 * Capa de red. Se llama DESPUÉS de gateMutation:
 * - plan + Bash ya salió con PLAN_MUTATION_DENIED (no llega aquí).
 * - plan + WebFetch (si gateMutation la dejó como other/deny) — si llega, deny PLAN.
 * - auto + needsNetwork → deny AUTO (no spawn).
 * - auto + local → allow network:false (wrap OS).
 * - ask + needsNetwork → ask (awaiting_approval "pide red").
 * - ask + local → allow network:false; el waiter de mutación (bash) lo decide gateMutation.
 */
export function gateNetwork(
  mode: ExecutionMode,
  sdkName: string,
  input: Record<string, unknown> | null,
): NetworkGate {
  const needs = toolNeedsNetwork(sdkName, input);
  if (!needs) {
    return { action: "allow", network: false };
  }
  if (mode === "plan") {
    return {
      action: "deny",
      network: false,
      message: NETWORK_DENIED_PLAN,
    };
  }
  if (mode === "auto") {
    return {
      action: "deny",
      network: false,
      message: NETWORK_DENIED_AUTO,
    };
  }
  return { action: "ask", network: true };
}

export function networkDenyMessage(mode: ExecutionMode): string {
  if (mode === "plan") return NETWORK_DENIED_PLAN;
  if (mode === "auto") return NETWORK_DENIED_AUTO;
  return NETWORK_DENIED_ASK;
}
