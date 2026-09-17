import type { ExecutionMode } from "./execution-mode";
import { gateNetwork, type NetworkGate } from "./network-gate";

/**
 * Plan 30 llama esto ANTES de fetch() en el daemon.
 * Auto → deny. Plan → deny. Ask → ask (el waiter vive en canUseTool).
 * SSRF (localhost, metadata cloud) es plan 30, no este módulo.
 */
export function gateWebFetch(
  mode: ExecutionMode,
  url: string,
): NetworkGate {
  return gateNetwork(mode, "WebFetch", { url });
}

export function shouldSpawnFetch(gate: NetworkGate): boolean {
  return gate.action === "allow" && gate.network === true;
}
