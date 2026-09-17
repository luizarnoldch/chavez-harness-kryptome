import {
  MARKETPLACE_DENIED,
  MARKETPLACE_PLAN_DENIED,
} from "./marketplace-constants";

export type ExecutionMode = "plan" | "auto" | "ask";

export type MarketplaceGate =
  | { decision: "allow" }
  | { decision: "ask" }
  | { decision: "deny"; message: string };

export function gateMarketplaceWrite(
  mode: ExecutionMode,
  userRequested: boolean,
): MarketplaceGate {
  if (mode === "plan") return { decision: "deny", message: MARKETPLACE_PLAN_DENIED };
  if (mode === "ask") return { decision: "ask" };
  if (mode === "auto" && userRequested) return { decision: "allow" };
  return { decision: "deny", message: MARKETPLACE_DENIED };
}
