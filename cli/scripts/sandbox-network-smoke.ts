import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCanUseTool } from "../src/llm/can-use-tool";
import {
  NETWORK_DENIED_AUTO,
  NETWORK_DENIED_ASK,
} from "../src/llm/network-constants";
import { gateWebFetch } from "../src/llm/network-fetch";
import {
  detectSandboxBackend,
  runSandboxedBash,
} from "../src/llm/sandbox-wrap";

const cwd = mkdtempSync(join(tmpdir(), "chavez-net-smoke-"));
mkdirSync(join(cwd, "src"));
writeFileSync(join(cwd, "src", "a.ts"), "ok");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const autoCurl = await decideCanUseTool({
  cwd,
  executionMode: "auto",
  toolName: "Bash",
  toolInput: { command: "curl https://example.com" },
});
if (autoCurl.behavior !== "deny" || autoCurl.message !== NETWORK_DENIED_AUTO) {
  fail(`auto curl: ${JSON.stringify(autoCurl)}`);
}

const askDeny = await decideCanUseTool({
  cwd,
  executionMode: "ask",
  toolName: "Bash",
  toolInput: { command: "curl https://example.com" },
  ask: async () => "deny",
});
if (askDeny.behavior !== "deny" || askDeny.message !== NETWORK_DENIED_ASK) {
  fail(`ask deny: ${JSON.stringify(askDeny)}`);
}

const planCurl = await decideCanUseTool({
  cwd,
  executionMode: "plan",
  toolName: "Bash",
  toolInput: { command: "curl https://example.com" },
});
if (planCurl.behavior !== "deny") fail(`plan curl ran: ${JSON.stringify(planCurl)}`);

const autoEtc = await decideCanUseTool({
  cwd,
  executionMode: "auto",
  toolName: "Bash",
  toolInput: { command: "cat /etc/passwd" },
});
if (
  autoEtc.behavior !== "deny" ||
  !String((autoEtc as { message: string }).message).startsWith(
    "Path outside workspace:",
  )
) {
  fail(`fs escape: ${JSON.stringify(autoEtc)}`);
}

const fetchAuto = gateWebFetch("auto", "https://example.com");
if (fetchAuto.action !== "deny") fail("fetch auto allowed");

const backend = detectSandboxBackend();
if (backend !== "none") {
  const r = await runSandboxedBash({
    cwd,
    network: false,
    command: "curl -sS --max-time 3 https://example.com",
  });
  if (r.exitCode === 0) fail("wrap allowed curl with network=false");
}

console.log("sandbox-network smoke ok");
