import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID, CI_OK_LINE, TUI_NO_TTY, NO_SECRET_PROMPT } from "./constants";
import { isNonInteractive, isTuiForbidden } from "./detect";
import { resolveCiMode } from "./args";
import { foldCiEvents, ciExitCode, ciFailReason } from "./outcome";
import { formatCiOutcome, formatCiPush } from "./format";
import { redactCiLog } from "./redact-log";
import { assertCanOpenTui, assertCanPromptSecret } from "./guards";

describe("Gherkin: Chavez en CI", () => {
  test("Turn auto en CI: stream.end → exit 0 y log texto de tools+assistant", () => {
    const lines = [
      formatCiPush({
        type: "chat.tool.start",
        data: {
          message: {
            metadata: {
              toolName: "Bash",
              status: "running",
            },
          },
        },
      }),
      formatCiPush({
        type: "chat.tool.result",
        data: {
          message: {
            metadata: {
              toolName: "Bash",
              status: "done",
            },
          },
        },
      }),
      formatCiPush({
        type: "chat.stream.delta",
        data: { delta: "listo" },
      }),
    ];
    expect(lines[0]).toContain("tool ·");
    expect(lines[0]).not.toMatch(/^\s*\{/);
    expect(lines[2]).toContain("listo");
    const outcome = foldCiEvents([{ kind: "stream_end", content: "listo" }]);
    expect(ciExitCode(outcome)).toBe(0);
    expect(formatCiOutcome(outcome)).toEqual({ stream: "stdout", text: CI_OK_LINE });
  });

  test("Fallo: provider error / stream.error / verification failed → exit != 0 + motivo", () => {
    const provider = foldCiEvents([
      { kind: "stream_error", error: "Claude no está vinculado — chavez provider link claude" },
    ]);
    expect(ciExitCode(provider)).not.toBe(0);
    expect(ciFailReason(provider)).toContain("Claude no está vinculado");

    const fatal = foldCiEvents([{ kind: "stream_error", error: "tool exploded" }]);
    expect(ciExitCode(fatal)).not.toBe(0);
    expect(ciFailReason(fatal)).toContain("tool exploded");

    const red = foldCiEvents([
      { kind: "stream_end", content: "tests failed", verificationStatus: "failed" },
    ]);
    expect(ciExitCode(red)).not.toBe(0);
    expect(formatCiOutcome(red).text).toMatch(/^ci fail:/);
  });

  test("Modo ask en CI: no espera humano; exit 2; ASK_CI_INVALID", () => {
    const r = resolveCiMode({ flag: "ask" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ASK_CI_INVALID);
    const prefs = resolveCiMode({ prefsMode: "ask" });
    expect(prefs.ok).toBe(false);
    const explicit = resolveCiMode({ flag: "auto", prefsMode: "ask" });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.mode).toBe("auto");
  });

  test("Sin TTY: no TUI, no prompt de secrets", () => {
    expect(isTuiForbidden({ CI: "true" }, { isTTY: true }, { isTTY: true })).toBe(true);
    expect(isNonInteractive({ CI: "true" }, { isTTY: true })).toBe(true);
    expect(() =>
      assertCanOpenTui({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toThrow(TUI_NO_TTY);
    expect(() =>
      assertCanPromptSecret({ CI: "true" }, { isTTY: true }, { isTTY: true }),
    ).toThrow(NO_SECRET_PROMPT);
  });

  test("Log no contiene vault: keys redactadas", () => {
    const raw = formatCiPush({
      type: "chat.stream.error",
      data: { error: "auth sk-ant-api03-LEAKEDSECRET999" },
    });
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toContain("LEAKEDSECRET999");
    const token = "tok_LIVE_abcdef123456";
    const out = redactCiLog(
      `CHAVEZ_ACCESS_TOKEN=${token} Bearer ${token}`,
      [token],
    );
    expect(out).not.toContain(token);
    expect(out).not.toContain("tok_LIVE_");
  });
});
