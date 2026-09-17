import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { buildClaudeAppendSystemPrompt } from "./claude-runner";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { VERIFY_PLAN_HINT, VERIFY_PREAMBLE } from "./verify-constants";

const cwd = mkdtempSync(join(tmpdir(), "chavez-mode-"));
writeFileSync(join(cwd, "in.txt"), "ok");

describe("decideCanUseTool", () => {
  test("ask + Read does not call ask()", async () => {
    let called = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Read",
      toolInput: { file_path: join(cwd, "in.txt") },
      ask: async () => {
        called = true;
        return "deny";
      },
    });
    expect(r.behavior).toBe("allow");
    expect(called).toBe(false);
  });

  test("ask + Write waits; deny does not imply allow", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      ask: async () => "deny",
    });
    expect(r).toEqual({ behavior: "deny", message: "User denied this tool" });
  });

  test("auto + Write inside cwd allows", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
    });
    expect(r.behavior).toBe("allow");
  });

  test("auto + Write outside cwd still sandboxes", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Write",
      toolInput: { file_path: "/etc/passwd", content: "nope" },
    });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message.startsWith("Path outside workspace:")).toBe(true);
    }
  });

  test("plan + Write denies without ask", async () => {
    let called = false;
    const r = await decideCanUseTool({
      cwd,
      executionMode: "plan",
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      ask: async () => {
        called = true;
        return "approve";
      },
    });
    expect(r).toEqual({ behavior: "deny", message: PLAN_MUTATION_DENIED });
    expect(called).toBe(false);
  });
});

describe("buildClaudeAppendSystemPrompt", () => {
  test("always appends the verification policy", () => {
    const prompt = buildClaudeAppendSystemPrompt({
      executionMode: "ask",
      appendSystemPrompt: "workspace rules",
    });
    expect(prompt).toContain("workspace rules");
    expect(prompt).toContain(VERIFY_PREAMBLE);
  });

  test("adds the plan verification hint only in plan mode", () => {
    const plan = buildClaudeAppendSystemPrompt({ executionMode: "plan" });
    const auto = buildClaudeAppendSystemPrompt({ executionMode: "auto" });
    expect(plan).toContain(VERIFY_PLAN_HINT);
    expect(auto).not.toContain(VERIFY_PLAN_HINT);
  });

  test("adds a pact command once when rules do not already contain it", () => {
    const marker = "Workspace verification command";
    const commandLine =
      `${marker} (use this exact command after edits; do not invent another): \`bun test\``;
    const added = buildClaudeAppendSystemPrompt({
      executionMode: "auto",
      verifyPactCommand: "bun test",
    });
    const existing = buildClaudeAppendSystemPrompt({
      executionMode: "auto",
      appendSystemPrompt: commandLine,
      verifyPactCommand: "bun test",
    });
    expect(added).toContain(commandLine);
    expect(existing.split(marker)).toHaveLength(2);
  });
});
