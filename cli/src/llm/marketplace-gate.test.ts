import { describe, expect, test } from "bun:test";
import {
  MARKETPLACE_DENIED,
  MARKETPLACE_PLAN_DENIED,
} from "./marketplace-constants";
import { gateMarketplaceWrite } from "./marketplace-gate";

describe("marketplace-gate", () => {
  test("plan + userRequested → deny with MARKETPLACE_PLAN_DENIED", () => {
    expect(gateMarketplaceWrite("plan", true)).toEqual({
      decision: "deny",
      message: MARKETPLACE_PLAN_DENIED,
    });
  });

  test("ask → ask", () => {
    expect(gateMarketplaceWrite("ask", true)).toEqual({ decision: "ask" });
  });

  test("auto + userRequested → allow", () => {
    expect(gateMarketplaceWrite("auto", true)).toEqual({ decision: "allow" });
  });

  test("auto + not userRequested → deny MARKETPLACE_DENIED", () => {
    expect(gateMarketplaceWrite("auto", false)).toEqual({
      decision: "deny",
      message: MARKETPLACE_DENIED,
    });
  });
});
