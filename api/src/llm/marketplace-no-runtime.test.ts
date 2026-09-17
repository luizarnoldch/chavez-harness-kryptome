import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const FORBIDDEN =
  /\bchild_process\b|\bexecFile\b|\bexecSync\b|\bBun\.spawn\b|\bcreateSdkMcpServer\b/;

const files = [
  "src/routes/marketplace.ts",
  "src/llm/marketplace-catalog.ts",
  "src/llm/marketplace-constants.ts",
  "src/llm/marketplace-view.ts",
];

describe("API marketplace has no runtime", () => {
  for (const f of files) {
    test(`does not spawn: ${f}`, () => {
      const text = readFileSync(join(import.meta.dir, "../..", f), "utf8");
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/from "@anthropic-ai\/claude-agent-sdk"/);
    });
  }

  test("route does not mention npx", () => {
    const text = readFileSync(
      join(import.meta.dir, "../..", "src/routes/marketplace.ts"),
      "utf8",
    );
    expect(text.includes("npx")).toBe(false);
    expect(text.includes("child_process")).toBe(false);
  });

  test("handlers do not import claude-agent-sdk for marketplace", () => {
    const text = readFileSync(
      join(import.meta.dir, "../ws/handlers.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/createSdkMcpServer/);
  });
});
