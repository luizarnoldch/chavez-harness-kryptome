export const NETWORK_DENIED_AUTO =
  "Network denied in auto mode. Switch to ask to request network.";
export const NETWORK_DENIED_PLAN =
  "Plan mode: network is disabled. Switch to ask to request network.";
export const NETWORK_DENIED_ASK = "User denied network for this tool";
export const NETWORK_DENIED_RUNTIME =
  "Network denied by workspace sandbox.";
export const NETWORK_REQUEST_LABEL = "pide red";

export const NETWORK_SDK_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "WebBrowser",
]);

export const BASH_SDK_TOOLS = new Set(["Bash", "bash", "shell", "Shell"]);

export function bannerNeedsNetwork(meta: Record<string, unknown>): boolean {
  if (meta.needsNetwork === true) return true;
  const prompt = meta.prompt as { needsNetwork?: boolean } | undefined;
  return prompt?.needsNetwork === true;
}
