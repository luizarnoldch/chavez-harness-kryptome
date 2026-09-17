import { describe, expect, test } from "bun:test";
import { ASK_CI_INVALID, CI_TURN_TIMEOUT_MAX_MS } from "./constants";
import { parseCiArgs, resolveCiMode } from "./args";

describe("parseCiArgs", () => {
  test('["--mode", "auto", "fix tests"] → modeFlag auto, prompt fix tests', () => {
    const r = parseCiArgs(["--mode", "auto", "fix tests"]);
    expect(r.modeFlag).toBe("auto");
    expect(r.prompt).toBe("fix tests");
  });

  test('["--mode=plan", "--chat", "c1", "hello"] → chat c1, mode plan', () => {
    const r = parseCiArgs(["--mode=plan", "--chat", "c1", "hello"]);
    expect(r.chatId).toBe("c1");
    expect(r.modeFlag).toBe("plan");
    expect(r.prompt).toBe("hello");
  });

  test('["--mode", "ask", "x"] parsea (reject es resolveCiMode)', () => {
    const r = parseCiArgs(["--mode", "ask", "x"]);
    expect(r.modeFlag).toBe("ask");
    expect(r.prompt).toBe("x");
  });

  test('["--timeout", "5000", "p"] → timeoutMs 5000', () => {
    const r = parseCiArgs(["--timeout", "5000", "p"]);
    expect(r.timeoutMs).toBe(5000);
  });

  test('["--timeout", "999999999", "p"] → cap CI_TURN_TIMEOUT_MAX_MS', () => {
    const r = parseCiArgs(["--timeout", "999999999", "p"]);
    expect(r.timeoutMs).toBe(CI_TURN_TIMEOUT_MAX_MS);
  });

  test('["--ci", "-"] → forceCi true, readStdin true', () => {
    const r = parseCiArgs(["--ci", "-"]);
    expect(r.forceCi).toBe(true);
    expect(r.readStdin).toBe(true);
  });
});

describe("resolveCiMode", () => {
  test('flag "ask" → ok false, error ASK_CI_INVALID', () => {
    const r = resolveCiMode({ flag: "ask" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ASK_CI_INVALID);
  });

  test('flag "auto" → mode auto, putPrefs true', () => {
    const r = resolveCiMode({ flag: "auto" });
    expect(r).toEqual({ ok: true, mode: "auto", putPrefs: true });
  });

  test('prefsMode "ask" → fail ASK_CI_INVALID', () => {
    const r = resolveCiMode({ prefsMode: "ask" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ASK_CI_INVALID);
  });

  test('prefsMode "auto" → mode auto, putPrefs false', () => {
    const r = resolveCiMode({ prefsMode: "auto" });
    expect(r).toEqual({ ok: true, mode: "auto", putPrefs: false });
  });

  test("prefsMode null → mode auto, putPrefs false", () => {
    const r = resolveCiMode({ prefsMode: null });
    expect(r).toEqual({ ok: true, mode: "auto", putPrefs: false });
  });

  test('envMode "auto" gana sobre prefsMode "ask"', () => {
    const r = resolveCiMode({ envMode: "auto", prefsMode: "ask" });
    expect(r).toEqual({ ok: true, mode: "auto", putPrefs: true });
  });

  test('flag "plan" gana sobre prefsMode "ask"', () => {
    const r = resolveCiMode({ flag: "plan", prefsMode: "ask" });
    expect(r).toEqual({ ok: true, mode: "plan", putPrefs: true });
  });
});
