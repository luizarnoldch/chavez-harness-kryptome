import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, planMcpInstall, planMcpUninstall } from "../src/llm/marketplace-fs";
import { loadMcpFromDisk } from "../src/llm/mcp-load";
import { DEFAULT_CLAUDE_TOOLS } from "../src/llm/tool-names";

const EXPECTED_NATIVES = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash",
] as const;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "marketplace-smoke-"));

const install = planMcpInstall(tmp, "github");
if ("error" in install) fail(install.error);
applyPatch(tmp, install);

const afterInstall = loadMcpFromDisk(tmp);
const names = afterInstall.servers.map((s) => s.name);
console.log("MCP servers:", names.join(", ") || "(none)");

if (!names.includes("github")) {
  fail("github not found after install");
}

const uninstall = planMcpUninstall(tmp, "github");
if ("error" in uninstall) fail(uninstall.error);
applyPatch(tmp, uninstall);

const afterUninstall = loadMcpFromDisk(tmp);
if (afterUninstall.servers.some((s) => s.name === "github")) {
  fail("github still on disk after uninstall");
}

if (
  DEFAULT_CLAUDE_TOOLS.length !== EXPECTED_NATIVES.length ||
  !EXPECTED_NATIVES.every((t) => DEFAULT_CLAUDE_TOOLS.includes(t))
) {
  fail(`native tools missing: ${DEFAULT_CLAUDE_TOOLS.join(", ")}`);
}

console.log("marketplace-smoke ok", tmp);
