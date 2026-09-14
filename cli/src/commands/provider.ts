import open from "open";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { obtainClaudeOAuthToken } from "../providers/claude-oauth";

type ProviderId = "claude" | "cursor";

type ProvidersResponse = {
  activeProvider: string | null;
  providers: Record<
    string,
    { linked: boolean; authKind?: string; updatedAt?: string }
  >;
};

function requireAuth(): void {
  if (!loadConfig().accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
}

function parseProvider(value?: string): ProviderId {
  if (value !== "claude" && value !== "cursor") {
    throw new Error("Provider inválido. Usa: claude | cursor");
  }
  return value;
}

async function promptSecret(label: string): Promise<string> {
  const value = prompt(label);
  if (!value?.trim()) {
    throw new Error("No se ingresó ningún secreto");
  }
  return value.trim();
}

async function saveCredentials(
  provider: ProviderId,
  authKind: "oauth_token" | "api_key",
  secret: string
): Promise<void> {
  await apiFetch(`/providers/${provider}/credentials`, {
    method: "PUT",
    body: JSON.stringify({ authKind, secret }),
  });
  console.log(`Vinculado ${provider} (${authKind}) en el vault de Chavez.`);
}

async function linkClaude(args: string[]): Promise<void> {
  const useApiKey = args.includes("--api-key");

  if (useApiKey) {
    const secret = await promptSecret(
      "Pega tu Anthropic API key (sk-ant-api…): "
    );
    await saveCredentials("claude", "api_key", secret);
    return;
  }

  const token = await obtainClaudeOAuthToken();
  await saveCredentials("claude", "oauth_token", token);
}

async function linkCursor(args: string[]): Promise<void> {
  const useWeb = args.includes("--web");

  if (useWeb) {
    const config = loadConfig();
    const url = `${config.apiUrl}/providers/link?provider=cursor&token=${encodeURIComponent(config.accessToken!)}`;
    console.log(`Abre: ${url}`);
    try {
      await open(url);
    } catch {
      console.log("(No se pudo abrir el navegador automáticamente)");
    }
    return;
  }

  const secret = await promptSecret("Pega tu Cursor API key: ");
  await saveCredentials("cursor", "api_key", secret);
}

export async function providerCommand(args: string[]): Promise<void> {
  const [action, rawProvider, ...rest] = args;
  requireAuth();

  switch (action) {
    case "list":
    case "status": {
      const data = await apiFetch<ProvidersResponse>("/providers");
      console.log(`Active: ${data.activeProvider ?? "(none)"}`);
      for (const [name, info] of Object.entries(data.providers)) {
        if (info.linked) {
          console.log(
            `- ${name}: linked (${info.authKind}) updated=${info.updatedAt}`
          );
        } else {
          console.log(`- ${name}: not linked`);
        }
      }
      return;
    }
    case "set": {
      const provider = parseProvider(rawProvider);
      await apiFetch("/providers/active", {
        method: "PUT",
        body: JSON.stringify({ provider }),
      });
      console.log(`Active provider = ${provider}`);
      return;
    }
    case "link": {
      const provider = parseProvider(rawProvider);
      if (provider === "claude") {
        await linkClaude(rest);
      } else {
        await linkCursor(rest);
      }
      return;
    }
    case "unlink": {
      const provider = parseProvider(rawProvider);
      await apiFetch(`/providers/${provider}/credentials`, {
        method: "DELETE",
      });
      console.log(`Unlinked ${provider}`);
      return;
    }
    default:
      throw new Error(
        "Uso: chavez provider <list|status|set|link|unlink> [claude|cursor] [--api-key|--web]"
      );
  }
}
