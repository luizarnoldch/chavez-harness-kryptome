import { NETWORK_REQUEST_LABEL } from "../../../cli/src/llm/network-constants";

export function formatFetchLine(meta: Record<string, unknown>): string {
  const status = String(meta.status || "running");
  const url = String(
    meta.url ||
      (meta.input as { url?: string } | undefined)?.url ||
      (meta.prompt as { url?: string } | undefined)?.url ||
      "",
  );
  const net = meta.needsNetwork === true ? `${NETWORK_REQUEST_LABEL} · ` : "";
  return `tool · fetch · ${status}  ${net}${url}`.trim();
}
