import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import type { AgentTurnEvent } from "./claude-runner";
import { classifyCursorError } from "./cursor-errors";
import { emitCursorEvent } from "./cursor-events";
import { canonicalCursorToolName, DEFAULT_CURSOR_TOOLS } from "./cursor-tools";
import type { CursorParamSelection } from "./cursor-types";
import { extractCursorUsageRaw } from "./usage-codec";
import { denyIfIgnored } from "./tool-ignore";
import { denyIfEscapes } from "./tool-sandbox";
import { denyIfBashEscapes } from "./bash-fs";
import { gateMutation } from "./execution-gate";
import { gateNetwork } from "./network-gate";
import { ASK_DENIED, type ExecutionMode } from "./execution-mode";
import { promptWithHistory, type HistoryMessage } from "./history";
import { TURN_CANCELLED } from "./turn-abort";
import { gateVerifyBash } from "./verify-gate";
import { loadMcpFromDisk } from "./mcp-load";
import { loadSkillsFromDisk } from "./skills-load";
import { formatSkillsPrompt } from "./skills-merge";
import { cursorCapsStatic } from "./provider-caps";
import {
  cursorDegradeEvents,
  toCursorMcpServers,
} from "./cursor-mcp-bridge";
import type { SkillsBundle } from "./skills-constants";
import { eventsFromSdkTaskMessage } from "./subagent-events";
import { decideCanUseTool, type AskPermission } from "./can-use-tool";
import type { MemoryApi } from "./memory-api";
import {
  applyMemoryToCursorPrompt,
  formatMemoryPrompt,
  type MemoryRecord,
} from "./memory-format";
import { runMemorySave } from "./memory-mcp";

export type CursorAuth = { authKind: "api_key"; secret: string };

type CursorCreateOpts = {
  apiKey: string;
  model: { id: string; params: Array<{ id: string; value: string }> };
  tools: string[];
  mcpServers?: Record<string, Record<string, unknown>>;
  disallowedTools?: string[];
  local: {
    cwd: string;
    store: JsonlLocalAgentStore;
    settingSources?: string[];
    customTools?: Record<string, CursorCustomTool>;
    sandboxOptions?: { enabled: boolean };
  };
};

type CursorCustomTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

type CursorRun = {
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{
    status: string;
    result?: string | null;
    error?: { message?: string };
  }>;
  cancel: () => Promise<void>;
  steer?: (
    text: string,
  ) => Promise<"complete_delivered" | "revert_to_followup" | string>;
};

type CursorAgent = {
  send: (
    prompt: string,
    options?: {
      model?: CursorCreateOpts["model"];
      onDelta?: (args: {
        update: { type?: string; text?: string };
      }) => void | Promise<void>;
    },
  ) => Promise<CursorRun>;
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

export type CreateCursorAgent = (
  opts: CursorCreateOpts,
) => Promise<CursorAgent>;

export type RunCursorTurnInput = {
  prompt: string;
  history?: HistoryMessage[];
  model: string;
  params?: CursorParamSelection[] | null;
  auth: CursorAuth;
  cwd: string;
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
  signal?: AbortSignal;
  createAgent?: CreateCursorAgent;
  executionMode?: ExecutionMode;
  onAskPermission?: AskPermission;
  onRunReady?: (handle: CursorRunHandle) => void;
  userSkills?: Array<{
    name: string;
    description: string;
    body: string;
    enabled: boolean;
  }>;
  memories?: MemoryRecord[];
  memoryApi?: MemoryApi;
  workspaceId?: string | null;
};

export type CursorRunHandle = {
  cancel: () => Promise<void>;
  steer?: (
    text: string,
  ) => Promise<"complete_delivered" | "revert_to_followup">;
};

function storeDir(cwd: string): string {
  const slug = Buffer.from(cwd).toString("hex").slice(0, 24);
  const dir = join(tmpdir(), "chavez-cursor", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function gateCursorTool(
  cwd: string,
  mode: ExecutionMode | undefined,
  name: string,
  args: Record<string, unknown> | null,
): { allow: boolean; message?: string } {
  const escaped = denyIfEscapes(cwd, name, args);
  if (escaped) return { allow: false, message: escaped.message };
  const ignored = denyIfIgnored(cwd, name, args);
  if (ignored) return { allow: false, message: ignored.message };
  const bashName =
    name === "shell" || name === "Shell" || canonicalCursorToolName(name) === "bash"
      ? "Bash"
      : name;
  const bashFs = denyIfBashEscapes(cwd, bashName, args);
  if (bashFs) return { allow: false, message: bashFs.message };
  if (!mode) return { allow: true };
  if (canonicalCursorToolName(name) === "bash") {
    const verifyGate = gateVerifyBash({
      mode,
      sdkName: "Bash",
      toolInput: args || {},
    });
    if (verifyGate.decision === "deny") {
      return { allow: false, message: verifyGate.message };
    }
    if (verifyGate.decision === "ask") {
      return { allow: false, message: ASK_DENIED };
    }
    if (verifyGate.decision === "allow") {
      const net = gateNetwork(mode, "Bash", args);
      if (net.action === "deny") {
        return { allow: false, message: net.message };
      }
      if (net.action === "ask") {
        return { allow: false, message: ASK_DENIED };
      }
      return { allow: true };
    }
  }
  const g = gateMutation(mode, bashName, args || {});
  if (g.decision === "deny") return { allow: false, message: g.message };
  const net = gateNetwork(mode, bashName, args);
  if (net.action === "deny") {
    return { allow: false, message: net.message };
  }
  if (net.action === "ask" || g.decision === "ask") {
    return { allow: false, message: ASK_DENIED };
  }
  return { allow: true };
}

export async function runCursorTurn(
  input: RunCursorTurnInput,
): Promise<string> {
  const parsedMcp = loadMcpFromDisk(input.cwd);
  const skills = loadSkillsFromDisk(input.cwd, input.userSkills ?? []);
  const caps = cursorCapsStatic();
  const skillsAvailable = caps.skills && input.executionMode !== "plan";
  const effectiveCaps = { ...caps, skills: skillsAvailable };
  const skillsPrompt = formatSkillsPrompt(skills).replace(
    /\n\nCall tool skill[^\n]*$/,
    skillsAvailable
      ? "$&"
      : "\n\nCursor cannot load full skill bodies in plan mode; use only these descriptions.",
  );
  const memoryPrompt = formatMemoryPrompt(input.memories);
  const prompt = applyMemoryToCursorPrompt(
    promptWithHistory(
      [skillsPrompt, input.prompt].filter(Boolean).join("\n\n"),
      input.history ?? [],
    ),
    memoryPrompt,
  );
  const store = new JsonlLocalAgentStore(storeDir(input.cwd));

  const modelSel = {
    id: input.model,
    params: (input.params ?? []).map((p) => ({ id: p.id, value: p.value })),
  };

  let agent: CursorAgent | null = null;
  let run: CursorRun | null = null;

  const onAbort = () => {
    void run?.cancel();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const create: CreateCursorAgent =
      input.createAgent ??
      (async (opts) =>
        Agent.create(opts as Parameters<typeof Agent.create>[0]));
    if (caps.mcp && parsedMcp.servers.length) {
      await input.onEvent?.({
        kind: "mcp_status",
        servers: parsedMcp.servers.map((server) => ({
          name: server.name,
          status: "pending",
          transport: server.config.transport,
          layer: server.layer,
        })),
      });
    }
    for (const event of cursorDegradeEvents(effectiveCaps, skills)) {
      await input.onEvent?.(event);
    }

    // Nunca pasar cloud. Nunca repos / autoCreatePR.
    const sandboxEnabled = input.executionMode !== "ask";
    const memoryCustomTools = input.memoryApi
      ? cursorMemoryTools({
          api: input.memoryApi,
          workspaceId: input.workspaceId ?? null,
        })
      : null;
    const skillTools = skillsAvailable
      ? { skill: cursorSkillTool(skills, input.onEvent) }
      : {};
    const customTools = {
      ...skillTools,
      ...(memoryCustomTools ?? {}),
    };
    agent = await create({
      apiKey: input.auth.secret,
      model: modelSel,
      tools: [
        ...DEFAULT_CURSOR_TOOLS,
        ...(caps.mcp ? ["mcp"] : []),
        ...(caps.subagents ? ["task"] : []),
      ],
      ...(caps.mcp
        ? { mcpServers: toCursorMcpServers(parsedMcp.servers) }
        : {}),
      ...(input.executionMode === "plan"
        ? { disallowedTools: ["edit", "write", "shell", "mcp"] }
        : {}),
      local: {
        cwd: input.cwd,
        store,
        settingSources: [],
        sandboxOptions: { enabled: sandboxEnabled },
        ...(Object.keys(customTools).length
          ? { customTools }
          : {}),
      },
    });

    run = await agent.send(prompt, {
      model: modelSel,
      onDelta: async ({ update }) => {
        if (update.type === "text-delta" && update.text) {
          await input.onEvent?.({ kind: "stream_delta", text: update.text });
        }
      },
    });
    input.onRunReady?.({
      cancel: () => run!.cancel(),
      steer: run.steer
        ? async (text) => {
            const outcome = await run!.steer!(text);
            return outcome === "complete_delivered"
              ? "complete_delivered"
              : "revert_to_followup";
          }
        : undefined,
    });

    if (input.signal?.aborted) {
      await run.cancel();
    }

    for await (const event of run.stream()) {
      if (input.signal?.aborted) {
        await run.cancel();
        break;
      }
      const ev = event as {
        type?: string;
        name?: string;
        args?: unknown;
        status?: string;
        text?: string;
      };
      if (ev.type === "thinking" && typeof ev.text === "string" && ev.text) {
        await input.onEvent?.({ kind: "thinking_delta", text: ev.text });
      }
      if (ev.type === "tool_call" && ev.status === "running") {
        const args =
          ev.args && typeof ev.args === "object" && !Array.isArray(ev.args)
            ? (ev.args as Record<string, unknown>)
            : null;
        const rawName = String(ev.name || "tool");
        const sdkName =
          rawName === "shell" || rawName === "Shell" ? "Bash" : rawName;
        const decision = await decideCanUseTool({
          cwd: input.cwd,
          executionMode: input.executionMode,
          toolName: sdkName,
          toolInput: args || {},
          ask: input.onAskPermission
            ? async ({ needsNetwork }) =>
                input.onAskPermission!({
                  toolCallId: crypto.randomUUID(),
                  toolName: sdkName,
                  input: args || {},
                  signal: input.signal ?? new AbortController().signal,
                  needsNetwork,
                })
            : undefined,
        });
        if (decision.behavior !== "allow") {
          await input.onEvent?.({
            kind: "tool_result",
            toolCallId: crypto.randomUUID(),
            toolName: canonicalCursorToolName(rawName),
            status: "error",
            output: decision.message,
          });
          await run.cancel();
          throw new Error(decision.message || "Tool denied");
        }
      }
      for (const taskEvent of eventsFromSdkTaskMessage(
        ev as Record<string, unknown>,
      )) {
        await input.onEvent?.(taskEvent);
      }
      await emitCursorEvent(ev, input.onEvent);
    }

    const result = await run.wait();
    if (result.status === "cancelled") {
      throw new Error(TURN_CANCELLED);
    }
    if (result.status === "error") {
      throw classifyCursorError(
        new Error(result.error?.message || "Cursor run error"),
        input.model,
      );
    }
    const text = result.result ?? "";
    try {
      const raw = extractCursorUsageRaw(result);
      if (raw) {
        await input.onEvent?.({ kind: "usage", provider: "cursor", raw });
      }
    } catch {
      // usage optional
    }
    await input.onEvent?.({ kind: "result", text });
    return text;
  } catch (err) {
    if (input.signal?.aborted) throw new Error(TURN_CANCELLED);
    throw classifyCursorError(err, input.model);
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    try {
      await agent?.[Symbol.asyncDispose]?.();
    } catch {
      agent?.close?.();
    }
  }
}

function cursorSkillTool(
  bundle: SkillsBundle,
  onEvent: RunCursorTurnInput["onEvent"],
): CursorCustomTool {
  return {
    description: "Load a Chavez skill's full instructions by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async execute(args) {
      const name = String(args.name || "");
      const skill = bundle.applied.find((candidate) => candidate.name === name);
      if (!skill) {
        return `Unknown skill "${name}". Available: ${bundle.applied
          .map((candidate) => candidate.name)
          .join(", ") || "(none)"}`;
      }
      await onEvent?.({
        kind: "skill_activated",
        name: skill.name,
        layer: skill.layer,
        source: skill.path,
      });
      return `# ${skill.name}\nlayer: ${skill.layer}\n${skill.description}\n\n${skill.body}`;
    },
  };
}

function cursorMemoryTools(ctx: {
  api: MemoryApi;
  workspaceId: string | null;
}): Record<string, CursorCustomTool> {
  return {
    memory_save: {
      description:
        "Save a durable fact. workspace = this repo; user = every workspace. Never write it to a file.",
      inputSchema: {
        type: "object",
        properties: {
          fact: { type: "string" },
          scope: { type: "string", enum: ["user", "workspace"] },
          title: { type: "string" },
        },
        required: ["fact"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      async execute(args) {
        try {
          const row = await runMemorySave(ctx, {
            fact: String(args.fact ?? ""),
            scope:
              args.scope === "user" || args.scope === "workspace"
                ? args.scope
                : undefined,
            title:
              args.title == null ? undefined : String(args.title),
          });
          return `saved ${row.scope} memory ${row.id}: ${row.title}`;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
    memory_list: {
      description: "List user + workspace memories visible in this turn.",
      inputSchema: { type: "object", properties: {} },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      async execute() {
        try {
          const rows = await ctx.api.list(ctx.workspaceId);
          if (!rows.length) return "0 recuerdos";
          return rows
            .map((r) => `[${r.scope} ${r.id}] ${r.title}: ${r.fact}`)
            .join("\n");
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
    memory_forget: {
      description: "Delete a memory by id. Use memory_list if the id is unknown.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      async execute(args) {
        try {
          await ctx.api.forget(String(args.id));
          return `deleted ${args.id}`;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
  };
}
