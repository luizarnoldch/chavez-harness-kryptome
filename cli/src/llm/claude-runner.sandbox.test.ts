import { describe, expect, test } from "bun:test";
import { sdkSandbox } from "./claude-runner";

describe("sdkSandbox", () => {
  test("enabled, no auto-allow bash, empty allowlist", () => {
    const s = sdkSandbox("/tmp/ws");
    expect(s.enabled).toBe(true);
    expect(s.autoAllowBashIfSandboxed).toBe(false);
    expect(s.allowUnsandboxedCommands).toBe(true);
    expect((s.network as { allowedDomains: string[] }).allowedDomains).toEqual(
      [],
    );
    expect((s.network as { strictAllowlist: boolean }).strictAllowlist).toBe(
      true,
    );
    expect((s.filesystem as { allowWrite: string[] }).allowWrite).toEqual([
      "/tmp/ws",
    ]);
  });
});
