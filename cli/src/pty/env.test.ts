import { describe, expect, test } from "bun:test";
import { sanitizePtyEnv } from "./env";

describe("sanitizePtyEnv", () => {
  test("strips secrets and keeps safe vars", () => {
    const out = sanitizePtyEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CHAVEZ_ACCESS_TOKEN: "secret",
      ANTHROPIC_API_KEY: "sk-ant-abc",
      OPENAI_API_KEY: "sk-openai-abc",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/user");
    expect(out.CHAVEZ_ACCESS_TOKEN).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.TERM).toBe("xterm-256color");
  });
});
