import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("share timeline has no ask and no vault", () => {
  const src = readFileSync(join(import.meta.dir, "ShareTimeline.tsx"), "utf8");
  expect(src).not.toContain("agent.turn");
  expect(src).not.toContain("useProviders");
  expect(src).not.toContain("credentials");
  expect(src).not.toContain("useWsAgentTurn");
});
