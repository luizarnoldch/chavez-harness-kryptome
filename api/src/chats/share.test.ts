import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { shareViewFromExport, SHARE_READONLY_BANNER, shareUrl } from "./export-share";

test("share view banner and no vault", () => {
  const view = shareViewFromExport("t", "2026-09-16T00:00:00.000Z", [
    {
      role: "user",
      content: "hi",
      createdAt: "2026-09-16T00:00:00.000Z",
      metadata: { ciphertext: "SHOULD_DROP_VIA_KEY_NAME" },
    },
  ]);
  expect(view.banner).toBe(SHARE_READONLY_BANNER);
  expect(JSON.stringify(view)).not.toContain("SHOULD_DROP_VIA_KEY_NAME");
  expect(JSON.stringify(view.messages[0]!.metadata)).toContain("***");
});

test("shareUrl builds /s/ path without vault fields", () => {
  const url = shareUrl("https://web.example", "abc");
  expect(url).toBe("https://web.example/s/abc");
  expect(url).not.toContain("ciphertext");
  expect(url).not.toContain("userId");
});

test("share.ts source has no vault/daemon", () => {
  const src = readFileSync(new URL("./share.ts", import.meta.url), "utf8");
  expect(src).not.toContain("providerCredentials");
  expect(src).not.toContain("decryptSecret");
  expect(src).not.toContain("findDaemon");
  expect(src).not.toContain("agent.turn");
});
