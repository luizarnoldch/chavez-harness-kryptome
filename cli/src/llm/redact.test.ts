import { describe, expect, test } from "bun:test";
import {
  redactEnvValues,
  redactJson,
  redactText,
} from "./redact";

describe("redactText", () => {
  test("anthropic and github tokens", () => {
    expect(redactText("key sk-ant-api03-abc rest")).toBe("key *** rest");
    expect(redactText("ghp_abc123")).toBe("***");
  });

  test("redacts anthropic keys", () => {
    expect(redactText("sk-ant-api03-abc")).toBe("***");
  });

  test("redacts github pats", () => {
    expect(redactText("ghp_abc")).toBe("***");
  });

  test("env secret lines", () => {
    expect(redactText("OPENAI_API_KEY=sk-abc\nOK=1")).toContain("OPENAI_API_KEY=***");
  });

  test("innocent code intact", () => {
    expect(redactText("hello src/auth.ts")).toBe("hello src/auth.ts");
  });

  test("leaves innocent text intact", () => {
    expect(redactText("hello src/auth.ts")).toBe("hello src/auth.ts");
  });

  test("json keys", () => {
    const s = redactJson({ api_key: "x", file: "a.ts" }) as Record<string, unknown>;
    expect(s.api_key).toBe("***");
    expect(s.file).toBe("a.ts");
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

describe("redactEnvValues", () => {
  test("all assignments in a dotenv file", () => {
    const out = redactEnvValues("FOO=bar\nBAZ=qux\n");
    expect(out).toBe("FOO=***\nBAZ=***\n");
  });
});
