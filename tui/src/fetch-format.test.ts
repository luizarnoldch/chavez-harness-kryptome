import { describe, expect, test } from "bun:test";
import { formatFetchLine } from "./lib/fetch-format";

test("shows url while awaiting", () => {
  const line = formatFetchLine({
    kind: "fetch",
    status: "awaiting_approval",
    url: "https://example.com/doc",
    needsNetwork: true,
  });
  expect(line).toContain("https://example.com/doc");
  expect(line).toContain("awaiting_approval");
  expect(line).toContain("pide red");
});
