import {
  SHARE_NOT_MEMBERSHIP,
  SHARE_READONLY_BANNER,
} from "./no-team";

export { SHARE_NOT_MEMBERSHIP, SHARE_READONLY_BANNER };

const VAULT_KEYS = [
  "ciphertext",
  "secret",
  "api_key",
  "accessToken",
  "access_token",
  "password",
] as const;

export function sharePayloadLeaksVault(payload: unknown): boolean {
  const raw = JSON.stringify(payload);
  for (const k of VAULT_KEYS) {
    if (raw.includes(`"${k}"`)) return true;
  }
  return false;
}

export function sharePayloadLooksLikeMembership(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const o = payload as Record<string, unknown>;
  if ("members" in o || "role" in o || "orgId" in o) return true;
  if ("workspaceId" in o || "userId" in o) return true;
  if (typeof o.banner === "string" && o.banner === SHARE_READONLY_BANNER) {
    return false;
  }
  return false;
}

export function assertPublicShareView(payload: unknown): void {
  if (sharePayloadLeaksVault(payload)) {
    throw new Error("share payload must not include vault keys");
  }
  if (sharePayloadLooksLikeMembership(payload)) {
    throw new Error(SHARE_NOT_MEMBERSHIP);
  }
  const o = payload as { banner?: string };
  if (o && typeof o === "object" && "banner" in o) {
    if (o.banner !== SHARE_READONLY_BANNER) {
      throw new Error("share banner mismatch");
    }
  }
}

/** Share tokens never authenticate. A 32-byte hex is not a Better Auth session. */
export function shareTokenMustNotBeSession(): true {
  return true;
}
