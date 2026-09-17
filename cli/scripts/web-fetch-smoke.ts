import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCanUseTool } from "../src/llm/can-use-tool";
import { NETWORK_DENIED_AUTO } from "../src/llm/network-constants";
import { SSRF_DENIED_API, SSRF_DENIED_METADATA } from "../src/llm/web-fetch-constants";
import { applyWebFetchToQueryOptions } from "../src/llm/web-fetch-mcp";
import { runWebFetch } from "../src/llm/web-fetch-http";
import { fetchToolMetadata } from "../src/llm/web-fetch-display";

const cwd = mkdtempSync(join(tmpdir(), "chavez-fetch-smoke-"));
mkdirSync(join(cwd, "src"));

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response("<html><body><p>docs outside repo</p></body></html>", {
      headers: { "content-type": "text/html" },
    });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const apiUrl = "http://127.0.0.1:25001";

const auto = await decideCanUseTool({
  cwd,
  executionMode: "auto",
  toolName: "WebFetch",
  toolInput: { url: `${origin}/readme` },
  ssrfEnv: { apiUrl },
});
if (auto.behavior !== "deny" || auto.message !== NETWORK_DENIED_AUTO) {
  fail(`auto: ${JSON.stringify(auto)}`);
}

const got = await runWebFetch(`${origin}/readme`, { apiUrl });
if (!got.ok || !got.text.includes("docs outside repo") || got.text.includes("<p>")) {
  fail(`daemon GET: ${got.text}`);
}

const awaiting = fetchToolMetadata("WebFetch", { url: `${origin}/readme` }, "awaiting_approval");
if (awaiting.url !== `${origin}/readme` || awaiting.kind !== "fetch") {
  fail(`timeline: ${JSON.stringify(awaiting)}`);
}

const md = await runWebFetch("http://169.254.169.254/latest/meta-data", { apiUrl });
if (md.ok || md.text !== SSRF_DENIED_METADATA) fail(`metadata: ${md.text}`);

const apiHit = await runWebFetch("http://127.0.0.1:25001/providers", { apiUrl });
if (apiHit.ok || apiHit.text !== SSRF_DENIED_API) fail(`api origin: ${apiHit.text}`);

const opts = applyWebFetchToQueryOptions({ mcpServers: {}, allowedTools: [] });
if (!(opts.mcpServers as Record<string, unknown>)["chavez-web"]) {
  fail("host fetch missing without MCP config");
}

server.stop();
console.log("web-fetch smoke ok");
