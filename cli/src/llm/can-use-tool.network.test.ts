import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import {
  NETWORK_DENIED_ASK,
  NETWORK_DENIED_AUTO,
} from "./network-constants";
import { PLAN_MUTATION_DENIED } from "./execution-mode";

const cwd = mkdtempSync(join(tmpdir(), "chavez-net-"));
mkdirSync(join(cwd, "src"));
writeFileSync(join(cwd, "src", "a.ts"), "ok");

describe("decideCanUseTool network", () => {
  test("auto + curl denies; ask callback never runs; no wrap", async () => {
    let asked = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => {
        asked = true;
        return "approve";
      },
    });
    expect(r).toEqual({
      behavior: "deny",
      message: NETWORK_DENIED_AUTO,
    });
    expect(asked).toBe(false);
  });

  test("auto + ls allows with wrap network=false", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") {
      expect(r.needsNetwork).toBe(false);
      expect(String(r.updatedInput?.command)).toContain("ls");
      expect(r.updatedInput?.dangerouslyDisableSandbox).toBe(false);
    }
  });

  test("ask + curl waits; deny → NETWORK_DENIED_ASK", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async ({ needsNetwork }) => {
        expect(needsNetwork).toBe(true);
        return "deny";
      },
    });
    expect(r).toEqual({
      behavior: "deny",
      message: NETWORK_DENIED_ASK,
    });
  });

  test("ask + curl approve → wrap with network", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => "approve",
    });
    expect(r.behavior).toBe("allow");
    if (r.behavior === "allow") {
      expect(r.needsNetwork).toBe(true);
      expect(r.updatedInput?.dangerouslyDisableSandbox).toBe(true);
      const cmd = String(r.updatedInput?.command || "");
      expect(cmd.includes("curl")).toBe(true);
      expect(cmd.includes("--unshare-net")).toBe(false);
    }
  });

  test("plan + curl never asks", async () => {
    let asked = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "plan",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => {
        asked = true;
        return "approve";
      },
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(
        r.message === PLAN_MUTATION_DENIED ||
          r.message.includes("Plan mode"),
      ).toBe(true);
    }
    expect(asked).toBe(false);
  });

  test("auto + cat /etc/passwd sandboxes FS", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "cat /etc/passwd" },
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message.startsWith("Path outside workspace:")).toBe(true);
    }
  });

  test("auto + WebFetch denies (plan 30)", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com" },
    });
    expect(r).toEqual({
      behavior: "deny",
      message: NETWORK_DENIED_AUTO,
    });
  });

  test("ask + WebFetch deny does not allow", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com" },
      ask: async () => "deny",
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message).toBe(NETWORK_DENIED_ASK);
    }
  });

  test("ask deny never builds a wrap (no spawn)", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "curl https://example.com" },
      ask: async () => "deny",
    });
    expect(r.behavior).toBe("deny");
    expect("updatedInput" in r ? r.updatedInput : undefined).toBeUndefined();
  });
});
