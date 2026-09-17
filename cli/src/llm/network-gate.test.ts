import { describe, expect, test } from "bun:test";
import {
  NETWORK_DENIED_AUTO,
  NETWORK_DENIED_PLAN,
} from "./network-constants";
import { gateNetwork } from "./network-gate";

describe("gateNetwork", () => {
  test("auto + curl denies with stable message", () => {
    const g = gateNetwork("auto", "Bash", {
      command: "curl https://example.com",
    });
    expect(g).toEqual({
      action: "deny",
      network: false,
      message: NETWORK_DENIED_AUTO,
    });
  });

  test("auto + ls allows without network", () => {
    const g = gateNetwork("auto", "Bash", { command: "ls" });
    expect(g).toEqual({ action: "allow", network: false });
  });

  test("ask + curl asks for network", () => {
    const g = gateNetwork("ask", "Bash", {
      command: "curl https://example.com",
    });
    expect(g).toEqual({ action: "ask", network: true });
  });

  test("plan + curl denies", () => {
    const g = gateNetwork("plan", "Bash", {
      command: "curl https://example.com",
    });
    expect(g.action).toBe("deny");
    expect(g.message).toBe(NETWORK_DENIED_PLAN);
  });

  test("auto + WebFetch denies (plan 30 hook)", () => {
    const g = gateNetwork("auto", "WebFetch", { url: "https://example.com" });
    expect(g.action).toBe("deny");
    expect(g.message).toBe(NETWORK_DENIED_AUTO);
  });

  test("ask + WebFetch asks", () => {
    const g = gateNetwork("ask", "WebFetch", { url: "https://example.com" });
    expect(g).toEqual({ action: "ask", network: true });
  });

  test("plan + WebFetch denies", () => {
    expect(gateNetwork("plan", "WebFetch", { url: "https://x" }).message).toBe(
      NETWORK_DENIED_PLAN,
    );
  });
});
