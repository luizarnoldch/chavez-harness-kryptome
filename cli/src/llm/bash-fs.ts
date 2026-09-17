import { isAbsolute, relative } from "node:path";
import {
  PATH_ESCAPE_PREFIX,
  PathEscapeError,
  resolveInsideCwd,
} from "./workspace-path";

const CD_OUT_RE = /(?:^|[;&|]|&&|\|\|)\s*cd\s+(?:\/|~|\$HOME|"\/|'\/)/;
const ABS_RE =
  /(?:^|[\s"'=<>])(\/(?:etc|usr|var|home|root|tmp|proc|sys|dev)\/[^\s"'`;|&<>]*)/g;
const TRAVERSAL_RE = /(?:^|[\s"'=])(\.\.\/[^\s"'`;|&<>]*)/g;

function escapeMessage(rel: string): { behavior: "deny"; message: string } {
  return { behavior: "deny", message: `${PATH_ESCAPE_PREFIX}${rel}` };
}

/**
 * Extrae candidatos a path del command. No es un parser sh completo:
 * basta para `cat /etc/passwd`, `cd /`, `cat ../../.ssh/id_rsa`.
 */
export function extractBashPaths(command: string): string[] {
  const out: string[] = [];
  for (const re of [ABS_RE, TRAVERSAL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

export function denyIfBashEscapes(
  cwd: string,
  sdkName: string,
  input: Record<string, unknown> | null,
): { behavior: "deny"; message: string } | null {
  if (
    sdkName !== "Bash" &&
    sdkName !== "bash" &&
    sdkName !== "shell" &&
    sdkName !== "Shell"
  ) {
    return null;
  }
  const command =
    input && typeof input.command === "string"
      ? input.command
      : input && typeof input.cmd === "string"
        ? input.cmd
        : "";
  if (!command.trim()) return null;
  if (CD_OUT_RE.test(command)) {
    return escapeMessage("cd /");
  }
  for (const p of extractBashPaths(command)) {
    if (isAbsolute(p) || p.startsWith("..")) {
      try {
        resolveInsideCwd(cwd, p);
      } catch (err) {
        const rel = err instanceof PathEscapeError ? err.relPath : p;
        return escapeMessage(rel);
      }
      // absoluto DENTRO del cwd (el SDK a veces manda paths absolutos): ok
      const rel = relative(cwd, p);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return escapeMessage(p);
      }
    }
  }
  return null;
}
