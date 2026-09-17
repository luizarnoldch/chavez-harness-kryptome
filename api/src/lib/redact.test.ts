import { describe, expect, test } from "bun:test";
import { redactJson, redactText } from "./redact";

describe("redactText", () => {
  test("redacts anthropic keys", () => {
    expect(redactText("sk-ant-api03-abc")).toBe("***");
  });

  test("redacts github pats", () => {
    expect(redactText("ghp_abc")).toBe("***");
  });

  test("leaves innocent text intact", () => {
    expect(redactText("hello src/auth.ts")).toBe("hello src/auth.ts");
  });
});

describe("redactJson", () => {
  test("redacts secret-named keys", () => {
    expect(redactJson({ api_key: "x", file: "a.ts" })).toEqual({
      api_key: "***",
      file: "a.ts",
    });
  });
});
