import { describe, expect, test } from "bun:test";
import {
  formatMcpFailedSystem,
  preserveToolMetadata,
} from "./mcp-protocol";

describe("formatMcpFailedSystem", () => {
  test("includes every failed server and native-tool fallback", () => {
    const message = formatMcpFailedSystem([
      { name: "alpha", status: "failed" },
      { name: "connected", status: "connected" },
      { name: "beta", status: "failed" },
    ]);

    expect(message).toContain("alpha");
    expect(message).toContain("beta");
    expect(message).toContain("Native tools continue");
  });

  test("returns null when no server failed", () => {
    expect(
      formatMcpFailedSystem([{ name: "alpha", status: "connected" }]),
    ).toBeNull();
  });
});

describe("preserveToolMetadata", () => {
  test("keeps parentToolCallId from incoming metadata", () => {
    expect(
      preserveToolMetadata(
        { toolCallId: "child", status: "running" },
        { parentToolCallId: "parent" },
      ),
    ).toMatchObject({
      toolCallId: "child",
      status: "running",
      parentToolCallId: "parent",
    });
  });
});
