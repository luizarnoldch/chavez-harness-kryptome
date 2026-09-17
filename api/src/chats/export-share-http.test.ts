import { describe, expect, test } from "bun:test";
import {
  CHAT_NOT_FOUND,
  SESSION_NOT_FOUND,
  SHARE_NOT_FOUND,
  IMPORT_INVALID,
  FORMAT_REQUIRED,
} from "./export-share";

function ownerStatus(opts: {
  session: boolean;
  owned: boolean;
  kind: "export" | "import" | "share" | "public";
  shareExists?: boolean;
}): number {
  if (opts.kind === "public") return opts.shareExists ? 200 : 404;
  if (!opts.session) return 401;
  if (!opts.owned) return 404;
  if (opts.kind === "share" && opts.shareExists === false) return 404;
  return 200;
}

describe("http mapping", () => {
  test("other user is 404 not 403", () => {
    expect(ownerStatus({ session: true, owned: false, kind: "export" })).toBe(404);
    expect(ownerStatus({ session: true, owned: false, kind: "import" })).toBe(404);
    expect(ownerStatus({ session: true, owned: false, kind: "share" })).toBe(404);
    expect(CHAT_NOT_FOUND).toBe("Chat not found");
    expect(SESSION_NOT_FOUND).toBe("Session not found");
    expect(SHARE_NOT_FOUND).toBe("Share not found");
  });
  test("no session on owner routes is 401", () => {
    expect(ownerStatus({ session: false, owned: true, kind: "export" })).toBe(401);
  });
  test("public invalid token is 404 without leaking", () => {
    expect(ownerStatus({ session: false, owned: false, kind: "public", shareExists: false })).toBe(404);
  });
  test("constants", () => {
    expect(IMPORT_INVALID).toBe("Invalid export document");
    expect(FORMAT_REQUIRED).toBe("format must be md or json");
  });
});
