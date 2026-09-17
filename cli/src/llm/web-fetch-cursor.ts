import { WEB_FETCH_CURSOR_NAME } from "./web-fetch-constants";
import { decideFetch } from "./web-fetch-gate";
import { runWebFetch } from "./web-fetch-http";
import type { ExecutionMode } from "./execution-mode";
import { NETWORK_DENIED_ASK } from "./network-constants";
import { ASK_TIMEOUT_DENIED } from "./execution-mode";
import type { SsrfEnv } from "./web-fetch-ssrf";

export type CursorFetchAsk = (req: {
  url: string;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export function cursorWebFetchCustomTool(opts: {
  executionMode: ExecutionMode;
  ask?: CursorFetchAsk;
  ssrfEnv?: SsrfEnv;
}) {
  return {
    [WEB_FETCH_CURSOR_NAME]: {
      description:
        "Fetch an http(s) URL from the daemon machine and return truncated text. Not a cloud browser.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL" } },
        required: ["url"],
      },
      annotations: {
        title: "fetch",
        readOnlyHint: true,
        openWorldHint: true,
      },
      async execute(args: Record<string, unknown>) {
        const url = String(args.url || "");
        const d = await decideFetch(
          opts.executionMode,
          WEB_FETCH_CURSOR_NAME,
          { url },
          opts.ssrfEnv,
        );
        if (d.action === "deny") return d.message;
        if (d.action === "ask") {
          const outcome = (await opts.ask?.({ url })) ?? "deny";
          if (outcome !== "approve") {
            return outcome === "timeout" ? ASK_TIMEOUT_DENIED : NETWORK_DENIED_ASK;
          }
        }
        const r = await runWebFetch(url, opts.ssrfEnv);
        return r.text;
      },
    },
  };
}
