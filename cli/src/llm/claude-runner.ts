import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel } from "./catalog";
import { decideCanUseTool } from "./can-use-tool";
import {
  PLAN_MODE_PREAMBLE,
  sdkPermissionModeFor,
  type ExecutionMode,
} from "./execution-mode";
import {
  attachmentsPromptBlock,
  type HydratedAttachment,
} from "./hydrate-attachments";
import { promptWithHistory, type HistoryMessage } from "./history";
import { eventsFromSdkMessage, sdkResultError } from "./sdk-tool-events";
import { DEFAULT_CLAUDE_TOOLS } from "./tool-names";
import type { AgentTurnEvent } from "./agent-events";

export type { AgentTurnEvent } from "./agent-events";

export type ClaudeAuth = {
  authKind: "oauth_token" | "api_key";
  secret: string;
};

export type AskPermission = (req: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<"approve" | "deny" | "timeout" | "cancelled">;

export type RunClaudeTurnInput = {
  prompt: string;
  /** Prior user/assistant/system turns from DB (not including current prompt). */
  history?: HistoryMessage[];
  model: string;
  effort: EffortLevel;
  auth: ClaudeAuth;
  cwd: string;
  executionMode: ExecutionMode;
  onAskPermission?: AskPermission;
  attachments?: HydratedAttachment[];
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
};

function buildPrompt(
  input: RunClaudeTurnInput,
): string | AsyncIterable<SDKUserMessage> {
  const attachBlock = attachmentsPromptBlock(input.attachments ?? []);
  const text = promptWithHistory(
    attachBlock ? `${attachBlock}\n\n${input.prompt}` : input.prompt,
    input.history ?? [],
  );
  const images = (input.attachments ?? []).filter(
    (a) =>
      a.kind === "image" &&
      a.status === "ok" &&
      a.imageBase64 &&
      a.mediaType,
  );
  if (!images.length) return text;
  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp",
              data: img.imageBase64!,
            },
          })),
          { type: "text" as const, text },
        ],
      },
    };
  }
  return gen();
}

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
    tools: [...DEFAULT_CLAUDE_TOOLS],
    allowedTools: [...DEFAULT_CLAUDE_TOOLS],
    permissionMode: sdkPermissionModeFor(input.executionMode),
    permissionPrompts: "host",
    canUseTool: async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolOpts: { signal: AbortSignal; toolUseID?: string },
    ) => {
      return decideCanUseTool({
        cwd: input.cwd,
        executionMode: input.executionMode,
        toolName,
        toolInput,
        ask: async () => {
          if (!input.onAskPermission) return "deny";
          return input.onAskPermission({
            toolCallId: String(toolOpts?.toolUseID || crypto.randomUUID()),
            toolName,
            input: toolInput,
            signal: toolOpts?.signal ?? new AbortController().signal,
          });
        },
      });
    },
  };

  if (input.effort !== "none") {
    options.thinking = { type: "adaptive" };
    options.effort = input.effort;
  }

  let finalResult: string | null = null;
  let apiKeySource: string | undefined;
  const seenToolStarts = new Set<string>();

  const userPrompt =
    input.executionMode === "plan"
      ? `${PLAN_MODE_PREAMBLE}\n\n${input.prompt}`
      : input.prompt;
  const prompt = buildPrompt({ ...input, prompt: userPrompt });

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

    const failed = sdkResultError(msg);
    if (failed) throw new Error(failed);

    for (const ev of eventsFromSdkMessage(msg)) {
      if (ev.kind === "tool_start") {
        if (seenToolStarts.has(ev.toolCallId)) continue;
        seenToolStarts.add(ev.toolCallId);
      }
      if (ev.kind === "result") {
        finalResult = ev.text;
      }
      await input.onEvent?.(ev);
    }
  }

  if (!finalResult) {
    throw new Error("Claude no devolvió un resultado de éxito");
  }
  return finalResult;
}
