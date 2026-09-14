import { query } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel } from "./catalog";

export type ClaudeAuth = {
  authKind: "oauth_token" | "api_key";
  secret: string;
};

export type RunClaudeTurnInput = {
  prompt: string;
  model: string;
  effort: EffortLevel;
  auth: ClaudeAuth;
  cwd: string;
};

function buildEnv(auth: ClaudeAuth): Record<string, string | undefined> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...rest } =
    process.env;

  if (auth.authKind === "oauth_token") {
    return {
      ...rest,
      CLAUDE_CODE_OAUTH_TOKEN: auth.secret,
      // Explicitly omit API keys so OAuth wins
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    };
  }

  return {
    ...rest,
    ANTHROPIC_API_KEY: auth.secret,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  };
}

export async function runClaudeTurn(input: RunClaudeTurnInput): Promise<string> {
  const env = buildEnv(input.auth);
  // Remove undefined keys for cleaner subprocess env
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }

  const options: Record<string, unknown> = {
    model: input.model,
    cwd: input.cwd,
    env: cleanEnv,
    settingSources: [],
    permissionMode: "bypassPermissions",
  };

  if (input.effort !== "none") {
    options.thinking = { type: "adaptive" };
    options.effort = input.effort;
  }

  let finalResult: string | null = null;
  let apiKeySource: string | undefined;

  for await (const message of query({
    prompt: input.prompt,
    options: options as never,
  })) {
    const msg = message as {
      type?: string;
      subtype?: string;
      apiKeySource?: string;
      result?: string;
    };
    if (msg.type === "system" && msg.subtype === "init") {
      apiKeySource = msg.apiKeySource;
      if (
        input.auth.authKind === "oauth_token" &&
        apiKeySource &&
        apiKeySource !== "none"
      ) {
        console.warn(
          `Aviso: apiKeySource="${apiKeySource}" (esperado "none" para OAuth)`
        );
      }
    }
    if (msg.type === "result" && msg.subtype === "success" && msg.result) {
      finalResult = msg.result;
    }
  }

  if (!finalResult) {
    throw new Error("Claude no devolvió un resultado de éxito");
  }
  return finalResult;
}
