import { describe, expect, test } from "bun:test";
import { htmlToText, isHtmlContentType, isTextContentType } from "./web-fetch-html";

test("strips tags and scripts", () => {
  const out = htmlToText(
    `<html><head><script>alert(1)</script><style>p{}</style></head><body><h1>Title</h1><p>Hello &amp; world</p></body></html>`,
  );
  expect(out).toContain("Title");
  expect(out).toContain("Hello & world");
  expect(out).not.toContain("alert");
  expect(out).not.toContain("<p>");
});

test("content types", () => {
  expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
  expect(isTextContentType("application/json")).toBe(true);
  expect(isTextContentType("image/png")).toBe(false);
});
