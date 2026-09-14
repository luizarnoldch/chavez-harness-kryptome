import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { env } from "../lib/config";

const OAUTH_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;
const ANY_ANT_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;

export function extractOAuthToken(text: string): string | null {
  return text.match(OAUTH_TOKEN_RE)?.[0] ?? text.match(ANY_ANT_TOKEN_RE)?.[0] ?? null;
}

function credentialsPath(): string {
  const base = env.server.claudeConfigDir || join(homedir(), ".claude");
  return join(base, ".credentials.json");
}

export function readLocalClaudeAccessToken(): string | null {
  const path = credentialsPath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        claudeAiOauth?: { accessToken?: string };
      };
      const token = raw.claudeAiOauth?.accessToken?.trim();
      if (token) return token;
    } catch {
      // ignore malformed file
    }
  }

  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawnSync(
        ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { stdout: "pipe", stderr: "pipe" }
      );
      if (proc.exitCode === 0) {
        const out = proc.stdout.toString().trim();
        const fromRaw = extractOAuthToken(out);
        if (fromRaw) return fromRaw;
        try {
          const parsed = JSON.parse(out) as {
            claudeAiOauth?: { accessToken?: string };
            accessToken?: string;
          };
          return (
            parsed.claudeAiOauth?.accessToken?.trim() ||
            parsed.accessToken?.trim() ||
            null
          );
        } catch {
          return out || null;
        }
      }
    } catch {
      // keychain unavailable
    }
  }

  return null;
}

function assertClaudeCli(): void {
  const which = Bun.spawnSync(
    process.platform === "win32" ? ["where", "claude"] : ["which", "claude"],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (which.exitCode !== 0) {
    throw new Error(
      "No se encontró el binario `claude` en PATH. Instala Claude Code:\n" +
        "  npm install -g @anthropic-ai/claude-code\n" +
        "Luego vuelve a ejecutar: chavez provider link claude"
    );
  }
}

async function teeStream(
  stream: ReadableStream<Uint8Array> | null,
  write: (chunk: string) => void
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    write(chunk);
  }
  full += decoder.decode();
  return full;
}

/**
 * Runs `claude setup-token`, captures printed OAuth token, falls back to local creds.
 */
export async function obtainClaudeOAuthToken(): Promise<string> {
  assertClaudeCli();

  console.log("Iniciando OAuth de Claude Code (`claude setup-token`)…");
  console.log("Completa el login en el navegador si se abre.\n");

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const proc = Bun.spawn(["claude", "setup-token"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [stdout, stderr] = await Promise.all([
    teeStream(proc.stdout, (c) => process.stdout.write(c)),
    teeStream(proc.stderr, (c) => process.stderr.write(c)),
  ]);
  const exitCode = await proc.exited;
  const combined = `${stdout}\n${stderr}`;

  const printed = extractOAuthToken(combined);
  if (printed) return printed;

  const local = readLocalClaudeAccessToken();
  if (local) {
    console.log("\nToken no impreso en stdout; se usó la credencial local de Claude Code.");
    return local;
  }

  if (exitCode !== 0) {
    throw new Error(
      `claude setup-token terminó con código ${exitCode} y no se obtuvo OAuth token.`
    );
  }

  throw new Error(
    "No se pudo extraer el OAuth token. Vuelve a intentar `chavez provider link claude` " +
      "o verifica que `claude setup-token` imprima un token sk-ant-oat01-…"
  );
}
