import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const publish = readFileSync(
  join(import.meta.dir, "publish-turn.ts"),
  "utf8",
);
const daemon = readFileSync(
  join(import.meta.dir, "../ws/daemon.ts"),
  "utf8",
);

describe("daemon vault uses session token not foreign userId", () => {
  test("publish-turn credentials path is /providers/:p/credentials", () => {
    expect(publish).toMatch(/\/providers\/\$\{provider\}\/credentials|\/providers\/claude\/credentials/);
    expect(publish).not.toMatch(/\/providers\/.*\?userId/);
    expect(publish).toContain("loadSessionVaultSecret");
  });

  test("daemon does not pass dispatch userId into the vault", () => {
    expect(daemon).not.toMatch(/publishAgentTurn\([\s\S]*userId:\s*data\.userId/);
    expect(daemon).toContain("accessToken");
  });
});
