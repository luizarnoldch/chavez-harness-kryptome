import type { ExecutionMode } from "./execution-mode";
import { gateWebFetch } from "./network-fetch";
import { isFetchSdkName } from "./web-fetch-constants";
import { assertFetchUrlSafe, urlFromToolInput, type SsrfEnv } from "./web-fetch-ssrf";

export { isFetchSdkName };

export async function denyIfSsrfAsync(
  sdkName: string,
  input: Record<string, unknown> | null,
  env: SsrfEnv = {},
): Promise<{ behavior: "deny"; message: string } | null> {
  if (!isFetchSdkName(sdkName)) return null;
  const url = urlFromToolInput(input);
  if (!url) {
    return { behavior: "deny", message: "Fetch blocked: url is required." };
  }
  const safe = await assertFetchUrlSafe(url, env);
  if (!safe.ok) return { behavior: "deny", message: safe.message };
  return null;
}

/**
 * Política fetch: SSRF luego modo (plan 26). No reimplementa NETWORK_DENIED_*.
 */
export async function decideFetch(
  mode: ExecutionMode,
  sdkName: string,
  input: Record<string, unknown> | null,
  env: SsrfEnv = {},
): Promise<
  | { action: "deny"; message: string }
  | { action: "ask"; url: string }
  | { action: "allow"; url: string }
> {
  const ssrf = await denyIfSsrfAsync(sdkName, input, env);
  if (ssrf) return { action: "deny", message: ssrf.message };
  const url = urlFromToolInput(input);
  const g = gateWebFetch(mode, url);
  if (g.action === "deny") {
    return { action: "deny", message: g.message || "Network denied." };
  }
  if (g.action === "ask") return { action: "ask", url };
  return { action: "allow", url };
}
