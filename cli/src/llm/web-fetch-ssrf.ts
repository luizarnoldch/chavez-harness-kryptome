import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import {
  DEFAULT_CHAVEZ_API_URL,
  METADATA_HOSTS,
  SSRF_DENIED,
  SSRF_DENIED_API,
  SSRF_DENIED_METADATA,
  SSRF_DENIED_SCHEME,
} from "./web-fetch-constants";

export type LookupFn = (hostname: string) => Promise<string[]>;

export type SsrfEnv = {
  apiUrl?: string;
  lookup?: LookupFn;
};

export type SsrfDeny = { ok: false; message: string };
export type SsrfAllow = { ok: true; url: URL; ips: string[] };
export type SsrfResult = SsrfDeny | SsrfAllow;

function defaultPort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === "https:" ? "443" : "80";
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((n[0]! << 24) | (n[1]! << 16) | (n[2]! << 8) | n[3]!) >>> 0;
}

function inCidrV4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipn = ipv4ToInt(ip);
  const bn = ipv4ToInt(base || "");
  if (ipn == null || bn == null || !Number.isInteger(bits)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipn & mask) === (bn & mask);
}

function stripV4Mapped(ip: string): string {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? m[1]! : ip;
}

function isLinkLocalOrMetadataIp(ip: string): boolean {
  const v = stripV4Mapped(ip);
  if (isIP(v) === 4) {
    if (inCidrV4(v, "169.254.0.0/16")) return true;
    if (inCidrV4(v, "0.0.0.0/8")) return true;
    return false;
  }
  const low = v.toLowerCase();
  if (low === "fd00:ec2::254" || low.startsWith("fd00:ec2:")) return true;
  if (low.startsWith("fe80:")) return true;
  return false;
}

function isLoopbackIp(ip: string): boolean {
  const v = stripV4Mapped(ip);
  if (isIP(v) === 4) return inCidrV4(v, "127.0.0.0/8");
  const low = v.toLowerCase();
  return low === "::1" || low === "0:0:0:0:0:0:0:1";
}

async function defaultLookup(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [stripV4Mapped(hostname)];
  const out = await dns.lookup(hostname, { all: true, verbatim: true });
  return [...new Set(out.map((r) => stripV4Mapped(r.address)))];
}

function parseHttpUrl(raw: string): URL | SsrfDeny {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, message: SSRF_DENIED };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, message: SSRF_DENIED_SCHEME };
  }
  if (u.username || u.password) {
    return { ok: false, message: SSRF_DENIED };
  }
  if (!u.hostname) {
    return { ok: false, message: SSRF_DENIED };
  }
  return u;
}

function hostMatchesApi(
  url: URL,
  api: URL,
  urlIps: string[],
  apiIps: string[],
): boolean {
  if (defaultPort(url) !== defaultPort(api)) return false;
  if (url.hostname.toLowerCase() === api.hostname.toLowerCase()) return true;
  const a = new Set(urlIps.map((x) => stripV4Mapped(x).toLowerCase()));
  for (const ip of apiIps) {
    if (a.has(stripV4Mapped(ip).toLowerCase())) return true;
  }
  return false;
}

/**
 * Decide si se puede abrir un socket a `raw`. No fetchea.
 * Metadata / link-local: siempre deny.
 * Origin de la API Chavez (host+puerto, localhost y 127.0.0.1 equivalentes): deny.
 * Loopback en OTRO puerto (docs locales): allow (el modo ask/auto lo decide gateWebFetch).
 */
export async function assertFetchUrlSafe(
  raw: string,
  env: SsrfEnv = {},
): Promise<SsrfResult> {
  const parsed = parseHttpUrl(raw);
  if (!(parsed instanceof URL)) return parsed;
  const url = parsed;
  const host = url.hostname.toLowerCase();

  if (METADATA_HOSTS.has(host)) {
    return { ok: false, message: SSRF_DENIED_METADATA };
  }

  const lookup = env.lookup ?? defaultLookup;
  let ips: string[];
  try {
    ips = await lookup(host);
  } catch {
    return { ok: false, message: SSRF_DENIED };
  }
  if (!ips.length) return { ok: false, message: SSRF_DENIED };

  if (ips.some(isLinkLocalOrMetadataIp)) {
    return { ok: false, message: SSRF_DENIED_METADATA };
  }

  const apiUrl =
    env.apiUrl || process.env.CHAVEZ_API_URL || DEFAULT_CHAVEZ_API_URL;
  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    api = new URL(DEFAULT_CHAVEZ_API_URL);
  }
  let apiIps: string[] = [];
  try {
    apiIps = await lookup(api.hostname);
  } catch {
    apiIps = isIP(api.hostname) ? [api.hostname] : [];
  }
  if (isLoopbackIp(apiIps[0] || "") || api.hostname === "localhost") {
    apiIps = [...new Set([...apiIps, "127.0.0.1", "::1"])];
  }
  if (hostMatchesApi(url, api, ips, apiIps)) {
    return { ok: false, message: SSRF_DENIED_API };
  }

  return { ok: true, url, ips };
}

export function denyIfSsrf(
  sdkName: string,
  input: Record<string, unknown> | null,
): { behavior: "deny"; message: string } | null {
  // sync wrapper used only to know IF we should run; the async check is assertFetchUrlSafe
  void sdkName;
  void input;
  return null;
}

export function urlFromToolInput(
  input: Record<string, unknown> | null,
): string {
  if (!input) return "";
  const u = input.url ?? input.uri ?? input.href;
  return typeof u === "string" ? u.trim() : "";
}
