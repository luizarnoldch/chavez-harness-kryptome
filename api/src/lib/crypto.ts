import { env } from "./config";

const textEncoder = new TextEncoder();

function requireKey(): Uint8Array {
  const hex = env.server.providerSecretsKey;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    requireKey(),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

export async function decryptSecret(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    requireKey(),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const combined = fromBase64(payload);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return new TextDecoder().decode(plaintext);
}
