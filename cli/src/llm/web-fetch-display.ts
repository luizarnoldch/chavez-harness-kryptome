import { canonicalToolName } from "./tool-names";
import { stringifyToolOutput, TOOL_OUTPUT_MAX_CHARS } from "./tool-display";
import { isFetchSdkName } from "./web-fetch-constants";
import { urlFromToolInput } from "./web-fetch-ssrf";

export function fetchToolMetadata(
  sdkName: string,
  input: Record<string, unknown> | null,
  status: string,
  output?: string,
) {
  const url = urlFromToolInput(input);
  const out = output != null ? stringifyToolOutput(output) : undefined;
  return {
    sdkName,
    toolName: isFetchSdkName(sdkName) ? "fetch" : canonicalToolName(sdkName),
    kind: "fetch" as const,
    status,
    input: { url },
    url,
    summary: url,
    needsNetwork: true as const,
    prompt: { kind: "fetch" as const, url, needsNetwork: true as const },
    output: out,
    truncated: typeof output === "string" && output.length > TOOL_OUTPUT_MAX_CHARS,
  };
}
