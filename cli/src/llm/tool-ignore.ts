import { extractToolPath } from "./tool-sandbox";
import { classifyPath, loadIgnore, type IgnoreSet } from "./ignore";
import { reasonForClass, type IgnoreClass } from "./ignore-patterns";
import { toolClass } from "./tool-names";
import { redactByClass, stripVaultLines } from "./secret-scan";
import { redactText } from "./redact";
import { relativePosix, resolveInsideCwd } from "./workspace-path";

export function classifyToolPath(
  cwd: string,
  set: IgnoreSet,
  rawPath: string | null,
): { cls: IgnoreClass; rel: string } | null {
  if (!rawPath) return null;
  let abs: string;
  try {
    abs = resolveInsideCwd(cwd, rawPath);
  } catch {
    return null;
  }
  const rel = relativePosix(cwd, abs);
  const cls = classifyPath(set, rel, { absPath: abs });
  return { cls, rel };
}

export function denyIfIgnored(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
  set?: IgnoreSet,
): { behavior: "deny"; message: string } | null {
  const ignore = set ?? loadIgnore(cwd);
  const raw = extractToolPath(input);
  const hit = classifyToolPath(cwd, ignore, raw);
  if (!hit || hit.cls === "none") return null;
  const cls = toolClass(sdkName);
  if (hit.cls === "vault") {
    return { behavior: "deny", message: "Chavez vault is not readable or writable by tools" };
  }
  if (cls === "write" && (hit.cls === "secret" || hit.cls === "huge")) {
    return {
      behavior: "deny",
      message: `Write blocked: ${hit.rel} looks like a secret (.env/key/vault). Git will not commit it.`,
    };
  }
  if (cls === "read" && hit.cls === "secret") {
    return {
      behavior: "deny",
      message: `Secret file ${hit.rel} — values redacted`,
    };
  }
  if (cls === "read" || cls === "write") {
    return {
      behavior: "deny",
      message: `Path is ignored: ${hit.rel} (${reasonForClass(hit.cls)}). Not read.`,
    };
  }
  return null;
}

const GREP_LINE = /^([^:\n]+):(\d+:)?(.*)$/;

export function filterGrepOrGlobOutput(
  cwd: string,
  sdkName: string,
  output: string,
  set?: IgnoreSet,
): string {
  const ignore = set ?? loadIgnore(cwd);
  const name = sdkName.toLowerCase();
  const lines = output.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (name.includes("grep") || name.includes("glob") || name === "ls") {
      const m = GREP_LINE.exec(line);
      const pathPart = m ? m[1]! : (name.includes("glob") ? line.trim() : "");
      if (pathPart) {
        const cls = classifyPath(ignore, pathPart.replace(/^\.\//, ""));
        if (cls === "vault") continue;
        if (cls === "junk" || cls === "huge") continue;
        if (cls === "secret") {
          kept.push(redactByClass(line, "secret"));
          continue;
        }
      }
    }
    kept.push(redactText(stripVaultLines(line)));
  }
  return kept.join("\n");
}

export function sanitizeVisibleToolOutput(
  cwd: string,
  sdkName: string,
  output: string,
): string {
  const filtered = filterGrepOrGlobOutput(cwd, sdkName, output);
  return redactText(stripVaultLines(filtered));
}
