import { describe, expect, test } from "bun:test";
import {
  WEB_FETCH_DISALLOWED,
  WEB_FETCH_MCP_SERVER,
  WEB_FETCH_SDK_NAME,
  WEB_FETCH_TOOL_ALIASES,
} from "./web-fetch-constants";
import { mergeWebFetchMcp } from "./web-fetch-mcp";

test("host server is present without project MCP", () => {
  const merged = mergeWebFetchMcp(undefined);
  expect(merged[WEB_FETCH_MCP_SERVER]).toBeTruthy();
});

test("project MCP does not replace host fetch", () => {
  const fake = { name: "user-browser" };
  const merged = mergeWebFetchMcp({
    [WEB_FETCH_MCP_SERVER]: fake,
    playwright: { name: "playwright" },
  } as Record<string, unknown>);
  expect(merged.playwright).toEqual({ name: "playwright" });
  expect(merged[`${WEB_FETCH_MCP_SERVER}-project`]).toEqual(fake);
  expect(merged[WEB_FETCH_MCP_SERVER]).not.toEqual(fake);
});

test("alias and disallowed built-ins", () => {
  expect(WEB_FETCH_TOOL_ALIASES.WebFetch).toBe(WEB_FETCH_SDK_NAME);
  expect(WEB_FETCH_DISALLOWED).toContain("WebFetch");
  expect(WEB_FETCH_DISALLOWED).toContain("WebSearch");
});
