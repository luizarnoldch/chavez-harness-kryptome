import { describe, expect, test } from "bun:test";
import { createFakeBackend } from "./fake-backend";
import { PtyManager } from "./manager";
import { gatePty, isBashOneShot, isPtyTool } from "./gate";
import { persistPtyTranscript } from "./redact";
import { sanitizePtyEnv } from "./env";
import { formatPtyHeader } from "./display";
import {
  PTY_DENIED_AUTO,
  PTY_DENIED_CI,
  PTY_DENIED_PLAN,
  PTY_OWNER_GONE,
} from "./constants";

describe("Gherkin PTY", () => {
  test("Abrir PTY: cwd del daemon + hostname/path + redact persist", async () => {
    const backend = createFakeBackend();
    const exits: string[] = [];
    const mgr = new PtyManager(
      backend,
      {
        onData() {},
        onExit(_id, info) {
          exits.push(info.transcript);
        },
      },
      () => 1,
      5,
    );
    const opened = mgr.open({
      kind: "user",
      ownerConnectionId: "web-1",
      cwd: "/home/me/proj",
    });
    expect(opened.cwd).toBe("/home/me/proj");
    expect(formatPtyHeader(opened.hostname, opened.cwd)).toContain("/home/me/proj");
    expect(formatPtyHeader(opened.hostname, opened.cwd)).toMatch(/^pty · /);
    backend.children[0]!.emitData("token sk-ant-secretvalue\n");
    await mgr.close(opened.ptyId);
    expect(exits[0] || persistPtyTranscript("sk-ant-secretvalue")).not.toContain(
      "sk-ant-secretvalue",
    );
    expect(sanitizePtyEnv({ CHAVEZ_ACCESS_TOKEN: "abc", PATH: "/bin" }).CHAVEZ_ACCESS_TOKEN).toBeUndefined();
  });

  test("El agente no toma el PTY por defecto: Bash one-shot aislado", () => {
    const backend = createFakeBackend();
    const userData: string[] = [];
    const mgr = new PtyManager(backend, {
      onData(id, chunk) {
        if (id === userId) userData.push(new TextDecoder().decode(chunk));
      },
      onExit() {},
    });
    const user = mgr.open({ kind: "user", ownerConnectionId: "tui", cwd: "/repo" });
    const userId = user.ptyId;
    expect(isBashOneShot("Bash")).toBe(true);
    expect(isPtyTool("Bash")).toBe(false);
    expect("bashOneShot" in mgr).toBe(false);
    const agent = mgr.open({
      kind: "agent",
      ownerConnectionId: "tui",
      cwd: "/repo",
      command: "echo hijack",
    });
    backend.children[1]!.emitData("hijack\n");
    expect(userData.join("")).not.toContain("hijack");
    expect(agent.ptyId).not.toBe(user.ptyId);
  });

  test("Comando interactivo vía tool: ask / auto / CI", () => {
    expect(gatePty({ mode: "ask" }).action).toBe("ask");
    expect(gatePty({ mode: "auto" })).toEqual({
      action: "deny",
      message: PTY_DENIED_AUTO,
    });
    expect(gatePty({ mode: "plan" }).message).toBe(PTY_DENIED_PLAN);
    expect(gatePty({ mode: "ask", ci: true }).message).toBe(PTY_DENIED_CI);
  });

  test("Cerrar: owner gone mata y no deja sesión", async () => {
    const backend = createFakeBackend();
    const mgr = new PtyManager(
      backend,
      { onData() {}, onExit() {} },
      () => 1,
      5,
    );
    const opened = mgr.open({ kind: "user", ownerConnectionId: "web-9", cwd: "/repo" });
    await mgr.ownerGone("web-9");
    expect(mgr.sessions.has(opened.ptyId)).toBe(false);
    expect(backend.children[0]!.killed.length).toBeGreaterThan(0);
    expect(backend.children[0]!.unrefCalled).toBe(false);
    expect(PTY_OWNER_GONE).toMatch(/owner disconnected/);
  });
});
