import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  annotateNetworkFailure,
  detectSandboxBackend,
  runSandboxedBash,
  wrapArgv,
} from "./sandbox-wrap";
import { NETWORK_DENIED_RUNTIME } from "./network-constants";

const cwd = mkdtempSync(join(tmpdir(), "chavez-wrap-"));
writeFileSync(join(cwd, "in.txt"), "hello");

describe("wrapArgv", () => {
  test("bwrap unshares net when network=false", () => {
    const argv = wrapArgv(
      { cwd, network: false, command: "curl https://example.com" },
      "bwrap",
    );
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain(cwd);
  });

  test("bwrap keeps net when network=true", () => {
    const argv = wrapArgv(
      { cwd, network: true, command: "curl https://example.com" },
      "bwrap",
    );
    expect(argv).not.toContain("--unshare-net");
  });

  test("unshare --net when network=false", () => {
    const argv = wrapArgv(
      { cwd, network: false, command: "curl https://x" },
      "unshare",
    );
    expect(argv).toContain("--net");
  });
});

describe("runSandboxedBash", () => {
  const backend = detectSandboxBackend();

  test("echo inside cwd works", async () => {
    if (backend === "none") return;
    const r = await runSandboxedBash({
      cwd,
      network: false,
      command: "cat in.txt",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  test("curl to internet fails when network=false", async () => {
    if (backend === "none") return;
    const r = await runSandboxedBash({
      cwd,
      network: false,
      command: "curl -sS --max-time 3 https://example.com",
    });
    expect(r.exitCode).not.toBe(0);
  });

  test("cat /etc/passwd fails when FS is confined (bwrap/seatbelt)", async () => {
    if (backend !== "bwrap" && backend !== "seatbelt") return;
    const r = await runSandboxedBash({
      cwd,
      network: false,
      command: "cat /etc/passwd",
    });
    expect(r.exitCode).not.toBe(0);
  });
});

describe("annotateNetworkFailure", () => {
  test("prefixes runtime message", () => {
    const s = annotateNetworkFailure("Could not resolve host", "");
    expect(s.startsWith(NETWORK_DENIED_RUNTIME)).toBe(true);
    expect(s).toContain("Could not resolve host");
  });
});
