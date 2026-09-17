/** keep-in-sync: cli/src/llm/network-constants.ts */
export const NETWORK_REQUEST_LABEL = "pide red";

export function bannerNeedsNetwork(meta: Record<string, unknown>): boolean {
  if (meta.needsNetwork === true) return true;
  const prompt = meta.prompt as { needsNetwork?: boolean } | undefined;
  return prompt?.needsNetwork === true;
}
