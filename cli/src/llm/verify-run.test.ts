import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runVerifyCommand } from "./verify-run";

const cwd = mkdtempSync(join(tmpdir(), "chavez-verify-"));

describe("runVerifyCommand", () => {
  test("exit 0 is ok and stdout is the tool body", async () => {
    const r = await runVerifyCommand({
      cwd,
      command: "echo hello-verify",
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.combined).toContain("hello-verify");
    expect(r.combined.startsWith("exit 0")).toBe(true);
  });

  test("exit 1 is not ok — not silent success material", async () => {
    const r = await runVerifyCommand({
      cwd,
      command: "echo fail-out; echo fail-err 1>&2; exit 7",
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.combined).toContain("fail-out");
    expect(r.combined).toContain("fail-err");
  });

  test("hanging command times out and is killed", async () => {
    const r = await runVerifyCommand({
      cwd,
      command: "sleep 30",
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(124);
    expect(r.combined.toLowerCase()).toContain("timed out");
  });

  test("huge stdout is truncated", async () => {
    writeFileSync(join(cwd, "big.sh"), "python3 -c 'print(\"x\"*20000)'");
    const r = await runVerifyCommand({
      cwd,
      command: "python3 -c 'print(\"x\"*20000)'",
      timeoutMs: 5_000,
      maxChars: 800,
    });
    expect(r.combined.length).toBeLessThanOrEqual(800 + 80);
    expect(r.combined).toContain("[truncated:");
    expect(r.truncated).toBe(true);
  });
});
