import { BASH_SDK_TOOLS, NETWORK_SDK_TOOLS } from "./network-constants";
import { isFetchSdkName, WEB_FETCH_SDK_NAME } from "./web-fetch-constants";

const NETWORK_BIN = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "telnet",
  "ftp",
  "rsync",
  "nmap",
  "dig",
  "nslookup",
  "host",
  "ping",
  "traceroute",
  "tracepath",
]);

const NETWORK_GIT = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);

const INSTALL_PAIR: Array<[string, Set<string>]> = [
  ["npm", new Set(["install", "i", "add", "ci", "update", "publish"])],
  ["pnpm", new Set(["install", "i", "add", "update", "publish"])],
  ["yarn", new Set(["install", "add", "upgrade", "publish"])],
  ["bun", new Set(["install", "i", "add", "update", "publish"])],
  ["pip", new Set(["install", "download"])],
  ["pip3", new Set(["install", "download"])],
  ["uv", new Set(["pip", "add", "sync"])],
  ["cargo", new Set(["install", "publish", "update"])],
  ["go", new Set(["get", "install", "mod"])],
  ["gem", new Set(["install"])],
  ["composer", new Set(["install", "update", "require"])],
  ["apt", new Set(["install", "update", "upgrade"])],
  ["apt-get", new Set(["install", "update", "upgrade"])],
  ["brew", new Set(["install", "update", "upgrade"])],
];

const URL_RE = /(?:https?|ftp|wss?):\/\//i;
const HOST_FLAG_RE = /\s(?:-h|--host|--hostname)\s+\S+/i;

export function isBashSdkName(sdkName: string): boolean {
  return BASH_SDK_TOOLS.has(sdkName);
}

export function isAlwaysNetworkTool(sdkName: string): boolean {
  if (NETWORK_SDK_TOOLS.has(sdkName)) return true;
  if (isFetchSdkName(sdkName)) return true;
  if (sdkName === WEB_FETCH_SDK_NAME) return true;
  const lower = sdkName.toLowerCase();
  if (lower === "webfetch" || lower === "websearch" || lower === "webbrowser") {
    return true;
  }
  if (lower.includes("webfetch") || lower.includes("web_fetch")) return true;
  return false;
}

export function bashCommandFromInput(
  input: Record<string, unknown> | null,
): string {
  if (!input) return "";
  const c = input.command ?? input.cmd ?? input.script;
  return typeof c === "string" ? c : "";
}

function tokens(command: string): string[] {
  return command
    .replace(/\\\n/g, " ")
    .split(/[\s;|&]+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * True si el command (o la tool) tocaría internet.
 * Conservador: un compuesto con curl en cualquier posición cuenta.
 * `git status` / `git commit` / `git diff` no cuentan.
 */
export function commandNeedsNetwork(command: string): boolean {
  const raw = command.trim();
  if (!raw) return false;
  if (URL_RE.test(raw) || HOST_FLAG_RE.test(raw)) return true;

  const parts = tokens(raw);
  for (let i = 0; i < parts.length; i++) {
    const bin = parts[i].replace(/^.*\//, "").toLowerCase();
    if (NETWORK_BIN.has(bin)) return true;
    if (bin === "git" && NETWORK_GIT.has((parts[i + 1] || "").toLowerCase())) {
      return true;
    }
    for (const [mgr, subs] of INSTALL_PAIR) {
      if (bin === mgr && subs.has((parts[i + 1] || "").toLowerCase())) {
        return true;
      }
    }
  }

  if (/\b(urllib|httpx|requests|fetch\s*\(|http\.client|axios)\b/i.test(raw)) {
    return true;
  }
  return false;
}

export function toolNeedsNetwork(
  sdkName: string,
  input: Record<string, unknown> | null,
): boolean {
  if (isAlwaysNetworkTool(sdkName)) return true;
  if (isBashSdkName(sdkName)) {
    return commandNeedsNetwork(bashCommandFromInput(input));
  }
  const url = input && typeof input.url === "string" ? input.url : "";
  if (url && URL_RE.test(url)) return true;
  return false;
}
