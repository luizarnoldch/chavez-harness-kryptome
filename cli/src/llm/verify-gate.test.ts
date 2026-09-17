import { describe, expect, test } from "bun:test";
import { PLAN_VERIFY_MUTATION_DENIED } from "./verify-constants";
import { gateVerifyBash } from "./verify-gate";

describe("gateVerifyBash", () => {
  test("plan denies snapshot update with specific message", () => {
    const g = gateVerifyBash({
      mode: "plan",
      sdkName: "Bash",
      toolInput: { command: "npx jest --updateSnapshot" },
    });
    expect(g.decision).toBe("deny");
    expect(g.message).toBe(PLAN_VERIFY_MUTATION_DENIED);
    expect(g.mutating).toBe(true);
  });

  test("plan denies non-mutating tests too (bash is disabled) but may propose", () => {
    const g = gateVerifyBash({
      mode: "plan",
      sdkName: "Bash",
      toolInput: { command: "npm test" },
    });
    expect(g.decision).toBe("deny");
    expect(g.kind).toBe("verify");
  });

  test("ask never treats tests as reads", () => {
    const g = gateVerifyBash({
      mode: "ask",
      sdkName: "Bash",
      toolInput: { command: "bun test" },
    });
    expect(g.decision).toBe("ask");
    expect(g.kind).toBe("verify");
  });

  test("auto allows and injects timeout", () => {
    const g = gateVerifyBash({
      mode: "auto",
      sdkName: "Bash",
      toolInput: { command: "npm test" },
    });
    expect(g.decision).toBe("allow");
    expect(g.updatedInput?.timeout).toBe(120_000);
  });

  test("plain bash passthrough", () => {
    const g = gateVerifyBash({
      mode: "auto",
      sdkName: "Bash",
      toolInput: { command: "ls" },
    });
    expect(g.decision).toBe("passthrough");
  });
});
