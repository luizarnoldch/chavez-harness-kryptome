import { describe, expect, test } from "bun:test";
import { isLlmProvider, isVaultProvider } from "./provider-ids";

describe("provider ids", () => {
  test("github is vault not LLM", () => {
    expect(isVaultProvider("github")).toBe(true);
    expect(isLlmProvider("github")).toBe(false);
    expect(isLlmProvider("claude")).toBe(true);
    expect(isVaultProvider("claude")).toBe(true);
    expect(isVaultProvider("unknown")).toBe(false);
  });
});
