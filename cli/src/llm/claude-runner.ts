import { query } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel } from "./catalog";
import { promptWithHistory, type HistoryMessage } from "./history";

export type ClaudeAuth = {
  authKind: "oauth_token" | "api_key";
  secret: string;
};

export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | {
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      output: string;
      status?: string;
    }
  | { kind: "result"; text: string };

export type RunClaudeTurnInput = {
  prompt: string;
  /** Prior user/assistant/system turns from DB (not including current prompt). */
  history?: HistoryMessage[];
  model: string;
  effort: EffortLevel;
  auth: ClaudeAuth;
  cwd: string;
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
};

function buildEnv(auth: ClaudeAuth): Record<string, string | undefined> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...rest } =
    process.env;

  if (auth.authKind === "oauth_token") {
    return {
      ...rest,
      CLAUDE_CODE_OAUTH_TOKEN: auth.secret,
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

async function emitBlocks(
  blocks: unknown,
  onEvent?: RunClaudeTurnInput["onEvent"],
) {
  if (!onEvent || !Array.isArray(blocks)) return;
  for (const block of blocks) {
    const b = asRecord(block);
    if (!b) continue;
    const type = String(b.type || "");
    if (type === "text" && typeof b.text === "string" && b.text) {
      await onEvent({ kind: "stream_delta", text: b.text });
    }
    if (type === "tool_use") {
      await onEvent({
        kind: "tool_start",
        toolCallId: String(b.id || crypto.randomUUID()),
        toolName: String(b.name || "tool"),
        input: b.input,
      });
    }
    if (type === "tool_result") {
      const content =
        typeof b.content === "string"
          ? b.content
          : JSON.stringify(b.content ?? "");
      await onEvent({
        kind: "tool_result",
        toolCallId: String(b.tool_use_id || b.id || crypto.randomUUID()),
        output: content,
        status: b.is_error ? "error" : "done",
      });
    }
  }
}

/**
 * Run one Claude Agent SDK turn. Emits stream/tool events via onEvent when possible;
 * always returns the final successful result text.
 */
export async function runClaudeTurn(input: RunClaudeTurnInput): Promise<string> {
  const env = buildEnv(input.auth);
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

  const prompt = promptWithHistory(input.prompt, input.history ?? []);

  for await (const message of query({
    prompt,
    options: options as never,
  })) {
    const msg = message as Record<string, unknown>;
    const type = String(msg.type || "");
    const subtype = msg.subtype != null ? String(msg.subtype) : "";

    if (type === "system" && subtype === "init") {
      apiKeySource =
        typeof msg.apiKeySource === "string" ? msg.apiKeySource : undefined;
      if (
        input.auth.authKind === "oauth_token" &&
        apiKeySource &&
        apiKeySource !== "none"
      ) {
        console.warn(
          `Aviso: apiKeySource="${apiKeySource}" (esperado "none" para OAuth)`,
        );
      }
    }

    if (type === "assistant") {
      const messageObj = asRecord(msg.message);
      await emitBlocks(messageObj?.content ?? msg.content, input.onEvent);
    }

    if (type === "user") {
      const messageObj = asRecord(msg.message);
      await emitBlocks(messageObj?.content ?? msg.content, input.onEvent);
    }

    if (type === "stream_event") {
      const event = asRecord(msg.event);
      const delta = asRecord(event?.delta);
      if (delta && typeof delta.text === "string" && delta.text) {
        await input.onEvent?.({ kind: "stream_delta", text: delta.text });
      }
    }

    if (type === "result" && subtype === "success" && typeof msg.result === "string") {
      finalResult = msg.result;
      await input.onEvent?.({ kind: "result", text: msg.result });
    }
  }

  if (!finalResult) {
    throw new Error("Claude no devolvió un resultado de éxito");
  }
  return finalResult;
}
