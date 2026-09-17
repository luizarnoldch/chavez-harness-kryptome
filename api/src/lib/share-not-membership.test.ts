import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARE_READONLY_BANNER,
  SHARE_NOT_FOUND,
} from "./no-team";
import {
  assertPublicShareView,
  sharePayloadLeaksVault,
  sharePayloadLooksLikeMembership,
} from "./share-not-membership";

describe("share is not membership", () => {
  test("public view rejects vault and membership fields", () => {
    expect(
      sharePayloadLeaksVault({ title: "x", secret: "sk-ant-x" }),
    ).toBe(true);
    expect(
      sharePayloadLooksLikeMembership({
        title: "x",
        userId: "u-a",
        banner: SHARE_READONLY_BANNER,
      }),
    ).toBe(true);
    expect(() =>
      assertPublicShareView({
        title: "Fix",
        createdAt: "2026-09-16T00:00:00.000Z",
        messages: [],
        banner: SHARE_READONLY_BANNER,
      }),
    ).not.toThrow();
  });

  test("banner constant matches plan 23 if that module exists", () => {
    const p = join(import.meta.dir, "../chats/export-share.ts");
    if (!existsSync(p)) return;
    const src = readFileSync(p, "utf8");
    expect(src).toContain(SHARE_READONLY_BANNER);
    expect(src).toContain(SHARE_NOT_FOUND);
    expect(src).toContain("No es un workspace compartido");
  });
});
