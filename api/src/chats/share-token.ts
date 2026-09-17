import { SHARE_TOKEN_BYTES } from "./export-share";

export function generateShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function isShareTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,}$/.test(token);
}
