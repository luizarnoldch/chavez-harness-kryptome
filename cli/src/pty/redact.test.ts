import { describe, expect, test } from "bun:test";
import { PTY_TRANSCRIPT_MAX_CHARS } from "./constants";
import { persistPtyTranscript } from "./redact";

describe("persistPtyTranscript", () => {
  test("redacts sk-ant and ghp tokens", () => {
    expect(persistPtyTranscript("key sk-ant-abc here")).toBe("key *** here");
    expect(persistPtyTranscript("token ghp_abc here")).toBe("token *** here");
  });

  test("truncates long dumps", () => {
    const raw = "x".repeat(9000);
    const out = persistPtyTranscript(raw);
    expect(out.length).toBeLessThanOrEqual(
      PTY_TRANSCRIPT_MAX_CHARS + "[truncated: showing ".length + 50,
    );
    expect(out).toContain("[truncated:");
  });
});
