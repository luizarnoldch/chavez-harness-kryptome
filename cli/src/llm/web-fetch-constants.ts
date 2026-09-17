export const WEB_FETCH_MCP_SERVER = "chavez-web";
export const WEB_FETCH_TOOL_ID = "fetch";
export const WEB_FETCH_SDK_NAME = "mcp__chavez-web__fetch";
export const WEB_FETCH_CURSOR_NAME = "web_fetch";

export const WEB_FETCH_DISALLOWED = ["WebFetch", "WebSearch"] as const;

export const WEB_FETCH_TOOL_ALIASES: Record<string, string> = {
  WebFetch: WEB_FETCH_SDK_NAME,
};

export const FETCH_BODY_MAX_CHARS = 8000;
export const FETCH_MAX_BYTES = 1_000_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_REDIRECTS = 5;
export const FETCH_USER_AGENT = "Chavez-Fetch/1.0";

export const SSRF_DENIED =
  "Fetch blocked: URL is not allowed (SSRF).";
export const SSRF_DENIED_API =
  "Fetch blocked: Chavez API origin is not allowed.";
export const SSRF_DENIED_METADATA =
  "Fetch blocked: cloud metadata and link-local addresses are not allowed.";
export const SSRF_DENIED_SCHEME =
  "Fetch blocked: only http and https URLs are allowed.";
export const FETCH_EMPTY = "Fetch returned no text content.";

export const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.azure.com",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

export const DEFAULT_CHAVEZ_API_URL = "http://localhost:25001";

export function fetchBinaryOmitted(type: string, bytes: number): string {
  return `binary content omitted (type=${type || "application/octet-stream"}, bytes=${bytes})`;
}

export function isFetchSdkName(sdkName: string): boolean {
  const n = sdkName.toLowerCase();
  if (sdkName === WEB_FETCH_SDK_NAME) return true;
  if (n === "webfetch" || n === "web_fetch" || n === "webfetch") return true;
  if (n === "fetch" || n === WEB_FETCH_CURSOR_NAME) return true;
  if (n.includes("webfetch") || n.includes("web_fetch")) return true;
  if (n === `mcp__${WEB_FETCH_MCP_SERVER}__${WEB_FETCH_TOOL_ID}`) return true;
  return false;
}
