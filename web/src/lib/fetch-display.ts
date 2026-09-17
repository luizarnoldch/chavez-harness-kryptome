// keep-in-sync: cli/src/llm/web-fetch-constants.ts, cli/src/llm/web-fetch-display.ts
export const NETWORK_REQUEST_LABEL = "pide red";
export const FETCH_BODY_MAX_CHARS = 8000;

export function isFetchTool(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false;
  const kind = String(meta.kind || "");
  const name = String(meta.toolName || meta.sdkName || "").toLowerCase();
  return kind === "fetch" || name === "fetch" || name === "webfetch" || name === "web_fetch";
}

export function fetchUrlFromMeta(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return "";
  if (typeof meta.url === "string" && meta.url) return meta.url;
  const prompt = meta.prompt as { url?: string } | undefined;
  if (prompt && typeof prompt.url === "string") return prompt.url;
  const input = meta.input as { url?: string } | undefined;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

export function fetchHeadline(meta: Record<string, unknown>): string {
  const status = String(meta.status || "running");
  const url = fetchUrlFromMeta(meta);
  const net =
    meta.needsNetwork === true || status === "awaiting_approval"
      ? `${NETWORK_REQUEST_LABEL} · `
      : "";
  return url
    ? `tool · fetch · ${status}  ${net}${url}`
    : `tool · fetch · ${status}`;
}
