import { describe, expect, test } from "bun:test";
import { fetchHeadline, isFetchTool } from "./fetch-display";

test("awaiting_approval headline has url and pide red", () => {
  const meta = {
    kind: "fetch",
    status: "awaiting_approval",
    url: "https://example.com/doc",
    needsNetwork: true,
  };
  expect(isFetchTool(meta)).toBe(true);
  const line = fetchHeadline(meta);
  expect(line).toContain("https://example.com/doc");
  expect(line).toContain("pide red");
  expect(line).toContain("awaiting_approval");
});
