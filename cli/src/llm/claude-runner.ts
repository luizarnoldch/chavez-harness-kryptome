import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel } from "./catalog";
import { buildCanUseTool, type AskPermission } from "./can-use-tool";
import {
  PLAN_MODE_PREAMBLE,
  sdkPermissionModeFor,
  type ExecutionMode,
} from "./execution-mode";
import { TurnDiffCollector } from "./turn-diff-collector";
import {
  attachmentsPromptBlock,
  type HydratedAttachment,
} from "./hydrate-attachments";
import { promptWithHistory, type HistoryMessage } from "./history";
import type { PromptStream } from "./prompt-stream";
import { TURN_CANCELLED } from "./turn-abort";
import { eventsFromSdkMessage, sdkResultError } from "./sdk-tool-events";
import { DEFAULT_CLAUDE_TOOLS } from "./tool-names";
import type { AgentTurnEvent } from "./agent-events";
import {
  GIT_AUTO_PREAMBLE,
  GIT_MCP_SERVER,
  GIT_PLAN_PREAMBLE,
} from "./git-constants";
import { allowedGitMcpTools } from "./git-names";
import { createGitMcpServer } from "./git-mcp";
import { applyRulesToClaudeOptions } from "./rules-inject";
import type { RulesBundle } from "./rules-merge";
import { extractClaudeUsageRaw } from "./usage-codec";
import { VERIFY_PLAN_HINT, VERIFY_PREAMBLE } from "./verify-constants";
import { loadMcpFromDisk, toClaudeMcpServers } from "./mcp-load";
import {
  MCP_PREAMBLE,
  SKILLS_MCP_SERVER,
  type McpServerRuntimeStatus,
} from "./mcp-constants";
import { loadSkillsFromDisk } from "./skills-load";
import { allowedSkillsMcpTools, createSkillsMcpServer } from "./skills-mcp";
import { formatSkillsPrompt } from "./skills-merge";
import type { SkillsBundle } from "./skills-constants";
import {
  SUBAGENT_PLAN_PREAMBLE,
} from "./subagent-constants";
import { createSubagentBudget } from "./subagent-budget";
import type { MemoryApi } from "./memory-api";
import {
  applyMemoryToClaudeOptions,
  formatMemoryPrompt,
  type MemoryRecord,
} from "./memory-format";
import {
  allowedMemoryMcpTools,
  createMemoryMcpServer,
  mergeMemoryMcpServer,
} from "./memory-mcp";
import { applyWebFetchToQueryOptions } from "./web-fetch-mcp";
import { WEB_FETCH_MCP_SERVER } from "./web-fetch-constants";
import type { PtyManager } from "../pty/manager";
import { createPtyMcpServer } from "../pty/mcp";
import {
  PTY_MCP_FULL,
  PTY_MCP_SERVER,
  PTY_PREAMBLE,
} from "../pty/constants";

export type { AgentTurnEvent } from "./agent-events";

export function sdkSandbox(cwd: string): Record<string, unknown> {
  return {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
    },
    filesystem: {
      allowWrite: [cwd],
    },
  };
}

export function classifyClaudeMessage(msg: unknown): AgentTurnEvent[] {
  return eventsFromSdkMessage(msg as Record<string, unknown>);
}

export async function emitClaudeResultUsage(
  msg: unknown,
  onEvent?: RunClaudeTurnInput["onEvent"],
): Promise<void> {
  try {
    const raw = extractClaudeUsageRaw(msg);
    if (raw) await onEvent?.({ kind: "usage", provider: "claude", raw });
  } catch {
    // ignore
  }
}

export type ClaudeAuth = {
  authKind: "oauth_token" | "api_key";
  secret: string;
};

export type { AskPermission } from "./can-use-tool";

export type RunClaudeTurnInput = {
  prompt: string;
  /** Prior user/assistant/system turns from DB (not including current prompt). */
  history?: HistoryMessage[];
  model: string;
  effort: EffortLevel;
  auth: ClaudeAuth;
  cwd: string;
  executionMode?: ExecutionMode;
  collector?: TurnDiffCollector;
  onAskPermission?: AskPermission;
  attachments?: HydratedAttachment[];
  attachmentsText?: string;
  abortController?: AbortController;
  promptStream?: PromptStream;
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
  getGitHubToken?: () => Promise<string | null>;
  appendSystemPrompt?: string;
  memories?: MemoryRecord[];
  memoryApi?: MemoryApi;
  workspaceId?: string | null;
  mcpServers?: Record<string, unknown>;
  verifyPactCommand?: string | null;
  rulesBundle?: RulesBundle;
  userSkills?: Array<{
    name: string;
    description: string;
    body: string;
    enabled: boolean;
  }>;
  mcpServersExtra?: Record<string, unknown>;
  ci?: boolean;
  ptyAllowed?: boolean;
  ptyManager?: PtyManager;
  ownerConnectionId?: string;
  chatId?: string;
};

export type ClaudeMcpOptionsInput = Pick<
  RunClaudeTurnInput,
  "cwd" | "executionMode" | "userSkills" | "mcpServersExtra"
>;

export function buildClaudeMcpOptions(input: ClaudeMcpOptionsInput): {
  options: {
    mcpServers: Record<string, unknown>;
    allowedTools: string[];
    strictMcpConfig: true;
    settingSources: [];
  };
  appendSystemPrompt: string;
  projectServerNames: string[];
  bundle: SkillsBundle;
} {
  const parsed = loadMcpFromDisk(input.cwd);
  const bundle = loadSkillsFromDisk(input.cwd, input.userSkills ?? []);
  const projectServers = toClaudeMcpServers(parsed.servers);
  const skillsServer = createSkillsMcpServer(bundle);
  const pendingServers = parsed.servers.length
    ? `MCP servers pending: ${parsed.servers.map((s) => s.name).join(", ")}`
    : "";
  const appendSystemPrompt = [
    MCP_PREAMBLE,
    pendingServers,
    formatSkillsPrompt(bundle),
    input.executionMode === "plan" ? SUBAGENT_PLAN_PREAMBLE : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    options: {
      mcpServers: {
        ...projectServers,
        ...(input.mcpServersExtra ?? {}),
        [SKILLS_MCP_SERVER]: skillsServer,
      },
      allowedTools: [
        ...DEFAULT_CLAUDE_TOOLS,
        ...allowedSkillsMcpTools(),
        "Task",
        ...allowedGitMcpTools(),
      ],
      strictMcpConfig: true,
      settingSources: [],
    },
    appendSystemPrompt,
    projectServerNames: parsed.servers.map((s) => s.name),
    bundle,
  };
}

export function shouldRetryWithoutProjectMcp(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bmcp\b/i.test(message);
}

export function buildClaudeAppendSystemPrompt(
  input: Pick<
    RunClaudeTurnInput,
    "appendSystemPrompt" | "executionMode" | "verifyPactCommand"
  >,
): string {
  const rulesPrompt = input.appendSystemPrompt || "";
  const pactLine =
    input.verifyPactCommand &&
    !rulesPrompt.includes("Workspace verification command")
      ? `Workspace verification command (use this exact command after edits; do not invent another): \`${input.verifyPactCommand}\``
      : "";
  const verifyBlock = [
    VERIFY_PREAMBLE,
    pactLine,
    input.executionMode === "plan" ? VERIFY_PLAN_HINT : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [rulesPrompt, verifyBlock].filter(Boolean).join("\n\n");
}

function buildPrompt(
  input: RunClaudeTurnInput,
): string | AsyncIterable<SDKUserMessage> {
  const attachBlock =
    input.attachmentsText ||
    attachmentsPromptBlock(input.attachments ?? []);
  const text = promptWithHistory(
    input.prompt,
    input.history ?? [],
    attachBlock || undefined,
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

export function buildClaudeEnv(auth: ClaudeAuth): Record<string, string> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...rest } =
    process.env;

  const raw: Record<string, string | undefined> =
    auth.authKind === "oauth_token"
      ? {
          ...rest,
          CLAUDE_CODE_OAUTH_TOKEN: auth.secret,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
        }
      : {
          ...rest,
          ANTHROPIC_API_KEY: auth.secret,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
        };

  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

/**
 * Run one Claude Agent SDK turn. Emits stream/tool events via onEvent when possible;
 * always returns the final successful result text.
 */
export async function runClaudeTurn(input: RunClaudeTurnInput): Promise<string> {
  const cleanEnv = buildClaudeEnv(input.auth);
  const executionMode = input.executionMode ?? "ask";
  const ptyEnabled = Boolean(
    !input.ci &&
      input.ptyAllowed !== false &&
      input.ptyManager &&
      input.ownerConnectionId &&
      input.chatId,
  );

  const gitServer = createGitMcpServer({
    cwd: input.cwd,
    mode: executionMode,
    getGitHubToken: input.getGitHubToken ?? (async () => null),
  });
  const memoryServer = input.memoryApi
    ? createMemoryMcpServer({
        api: input.memoryApi,
        workspaceId: input.workspaceId ?? null,
      })
    : null;
  const mcp = buildClaudeMcpOptions({
    cwd: input.cwd,
    executionMode,
    userSkills: input.userSkills,
    mcpServersExtra: {
      ...(input.mcpServersExtra ?? {}),
      ...(input.mcpServers ?? {}),
      [GIT_MCP_SERVER]: gitServer,
      ...(memoryServer ? mergeMemoryMcpServer({}, memoryServer) : {}),
      ...(ptyEnabled
        ? {
            [PTY_MCP_SERVER]: createPtyMcpServer({
              manager: input.ptyManager!,
              getCwd: () => input.cwd,
              ownerConnectionId: input.ownerConnectionId!,
              chatId: input.chatId!,
            }),
          }
        : {}),
    },
  });
  if (ptyEnabled) {
    mcp.options.allowedTools = [
      ...new Set([...mcp.options.allowedTools, PTY_MCP_FULL]),
    ];
  }
  const budget = createSubagentBudget();

  // appendSystemPrompt from publish may already include joined rules+memory.
  // Fallback: format memories when appendSystemPrompt is absent.
  const memoryPrompt =
    input.appendSystemPrompt ?? formatMemoryPrompt(input.memories);
  let options: Record<string, unknown> = applyRulesToClaudeOptions(
    {
      model: input.model,
      cwd: input.cwd,
      env: cleanEnv,
      tools: [...DEFAULT_CLAUDE_TOOLS, "Task"],
      ...mcp.options,
      permissionMode: sdkPermissionModeFor(executionMode),
      permissionPrompts: "host",
      sandbox: sdkSandbox(input.cwd),
      includePartialMessages: true,
      abortController: input.abortController,
      canUseTool: buildCanUseTool({
        cwd: input.cwd,
        executionMode,
        collector: input.collector ?? new TurnDiffCollector("local", input.cwd),
        onAskPermission: input.onAskPermission,
        rulesBundle: input.rulesBundle,
        subagentBudget: budget,
        ci: input.ci,
      }),
    },
    undefined,
  );
  options = applyMemoryToClaudeOptions(
    options,
    [
      buildClaudeAppendSystemPrompt({
        ...input,
        appendSystemPrompt: memoryPrompt,
      }),
      mcp.appendSystemPrompt,
      ptyEnabled ? PTY_PREAMBLE : "",
    ]
      .filter(Boolean)
      .join("\n\n") || undefined,
  );
  if (memoryServer) {
    options.mcpServers = mergeMemoryMcpServer(
      (options.mcpServers ?? input.mcpServers) as
        | Record<string, unknown>
        | undefined,
      memoryServer,
    );
    const extra = allowedMemoryMcpTools();
    const prevTools = Array.isArray(options.allowedTools)
      ? (options.allowedTools as string[])
      : Array.isArray(options.tools)
        ? (options.tools as string[])
        : [];
    const merged = [...new Set([...prevTools, ...extra])];
    if (Array.isArray(options.allowedTools) || prevTools.length) {
      options.allowedTools = merged;
    }
    if (Array.isArray(options.tools)) {
      options.tools = [
        ...new Set([...(options.tools as string[]), ...extra]),
      ];
    }
  }

  options = applyWebFetchToQueryOptions(options);

  if (input.effort !== "none") {
    options.thinking = { type: "adaptive" };
    options.effort = input.effort;
  }

  let finalResult: string | null = null;
  let apiKeySource: string | undefined;
  let initialized = false;
  const seenToolStarts = new Set<string>();

  const extras =
    executionMode === "plan"
      ? `${PLAN_MODE_PREAMBLE}\n\n${GIT_PLAN_PREAMBLE}`
      : executionMode === "auto"
        ? GIT_AUTO_PREAMBLE
        : "";
  const userPrompt = extras ? `${extras}\n\n${input.prompt}` : input.prompt;
  const promptInput = { ...input, prompt: userPrompt };

  const runOnce = async (
    runOptions: Record<string, unknown>,
    usePromptStream: boolean,
  ): Promise<void> => {
    const prompt =
      usePromptStream && input.promptStream
        ? (input.promptStream.iterate(
            promptWithHistory(
              userPrompt,
              input.history ?? [],
              input.attachmentsText ||
                attachmentsPromptBlock(input.attachments ?? []) ||
                undefined,
            ),
          ) as AsyncIterable<SDKUserMessage>)
        : buildPrompt(promptInput);
    const q = query({ prompt, options: runOptions as never });
    const onAbort = () => {
      void q.interrupt().catch(() => {});
      q.close();
    };
    input.abortController?.signal.addEventListener("abort", onAbort, {
      once: true,
    });
    if (input.abortController?.signal.aborted) onAbort();

    try {
      for await (const message of q) {
        if (input.abortController?.signal.aborted) {
          throw new Error(TURN_CANCELLED);
        }
        const msg = message as Record<string, unknown>;
        const type = String(msg.type || "");
        const subtype = msg.subtype != null ? String(msg.subtype) : "";

        if (type === "system" && subtype === "init") {
          initialized = true;
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

        if (type === "result") {
          await emitClaudeResultUsage(msg, input.onEvent);
        }

        if (type === "result" && subtype && subtype !== "success") {
          const errText = String(
            (msg as { errors?: unknown; error?: unknown; result?: unknown })
              .error ??
              (msg as { result?: unknown }).result ??
              subtype,
          );
          throw new Error(errText || "Claude result error");
        }

        const failed = sdkResultError(msg);
        if (failed) throw new Error(failed);

        for (const ev of classifyClaudeMessage(msg)) {
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
    } finally {
      input.abortController?.signal.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        // Query may already be closed by the abort handler.
      }
    }
  };

  try {
    await runOnce(options, true);
  } catch (error) {
    if (input.abortController?.signal.aborted) {
      throw new Error(TURN_CANCELLED);
    }
    if (
      initialized ||
      !mcp.projectServerNames.length ||
      !shouldRetryWithoutProjectMcp(error)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await input.onEvent?.({
      kind: "mcp_status",
      servers: [
        {
          name: "unknown",
          status: "failed",
          transport: "stdio",
          error: message,
          layer: "project",
        } satisfies McpServerRuntimeStatus,
      ],
    });
    finalResult = null;
    const allServers = options.mcpServers as Record<string, unknown>;
    const hostServers = Object.fromEntries(
      [GIT_MCP_SERVER, SKILLS_MCP_SERVER, WEB_FETCH_MCP_SERVER, PTY_MCP_SERVER]
        .filter((name) => allServers[name] != null)
        .map((name) => [name, allServers[name]]),
    );
    await runOnce({ ...options, mcpServers: hostServers }, false);
  } finally {
    input.promptStream?.close();
  }

  if (input.abortController?.signal.aborted) {
    throw new Error(TURN_CANCELLED);
  }

  if (!finalResult) {
    throw new Error("Claude no devolvió un resultado de éxito");
  }
  return finalResult;
}
