/**
 * Smoke: PtyManager live if /dev/ptmx exists; always prints policy lines.
 */
import { existsSync } from "node:fs";
import { gatePty } from "../src/pty/gate";
import { formatPtyHeader } from "../src/pty/display";
import { nativePtyBackend, isPtyPlatformSupported } from "../src/pty/native";
import { PtyManager } from "../src/pty/manager";
import { PTY_DENIED_AUTO, PTY_DENIED_CI } from "../src/pty/constants";

if (gatePty({ mode: "auto" }).message !== PTY_DENIED_AUTO) process.exit(1);
if (gatePty({ mode: "ask", ci: true }).message !== PTY_DENIED_CI) process.exit(1);
console.log(formatPtyHeader("smoke-host", "/tmp/smoke"));

if (isPtyPlatformSupported() && existsSync("/dev/ptmx")) {
  const mgr = new PtyManager(nativePtyBackend, {
    onData() {},
    onExit() {},
  });
  const opened = mgr.open({
    kind: "agent",
    ownerConnectionId: "smoke",
    cwd: process.cwd(),
    command: "echo pty-smoke-ok",
  });
  await mgr.waitForExit(opened.ptyId, 8_000);
  await mgr.killAll("smoke");
  console.log("pty-terminal smoke ok", opened.hostname, opened.cwd);
} else {
  console.log("pty-terminal smoke ok (skip live ptmx)");
}
