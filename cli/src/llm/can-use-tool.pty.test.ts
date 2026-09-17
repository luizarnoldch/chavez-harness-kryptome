import { expect, test } from "bun:test";
import {
  PTY_DENIED_ASK,
  PTY_DENIED_AUTO,
  PTY_DENIED_CI,
  PTY_DENIED_PLAN,
  PTY_MCP_FULL,
} from "../pty/constants";
import { decideCanUseTool } from "./can-use-tool";

const cwd = process.cwd();

test("Pty is denied in auto mode before the generic mutation gate", async () => {
  const result = await decideCanUseTool({
    cwd,
    executionMode: "auto",
    toolName: PTY_MCP_FULL,
    toolInput: { command: "less README.md" },
  });
  expect(result).toEqual({ behavior: "deny", message: PTY_DENIED_AUTO });
});

test("Pty is denied in plan and CI", async () => {
  const plan = await decideCanUseTool({
    cwd,
    executionMode: "plan",
    toolName: "Pty",
    toolInput: { command: "vim README.md" },
  });
  const ci = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: PTY_MCP_FULL,
    toolInput: { command: "top" },
    ci: true,
  });
  expect(plan).toEqual({ behavior: "deny", message: PTY_DENIED_PLAN });
  expect(ci).toEqual({ behavior: "deny", message: PTY_DENIED_CI });
});

test("Pty ask resolves approval and uses the Pty denial message", async () => {
  const approved = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: PTY_MCP_FULL,
    toolInput: { command: "python" },
    ask: async () => "approve",
  });
  const denied = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: PTY_MCP_FULL,
    toolInput: { command: "python" },
    ask: async () => "deny",
  });
  expect(approved.behavior).toBe("allow");
  expect(denied).toEqual({ behavior: "deny", message: PTY_DENIED_ASK });
});

test("Bash remains one-shot and is not denied as Pty in auto", async () => {
  const result = await decideCanUseTool({
    cwd,
    executionMode: "auto",
    toolName: "Bash",
    toolInput: { command: "printf ok" },
  });
  expect(result.behavior).toBe("allow");
  expect(result.behavior === "deny" ? result.message : "").not.toBe(
    PTY_DENIED_AUTO,
  );
});
