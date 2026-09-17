import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import type { AgentTurnEvent } from "./claude-runner";
import { classifyCursorError } from "./cursor-errors";
import { emitCursorEvent } from "./cursor-events";
import { DEFAULT_CURSOR_TOOLS } from "./cursor-tools";
import type { CursorParamSelection } from "./cursor-types";
import { denyIfIgnored } from "./tool-ignore";
import { denyIfEscapes } from "./tool-sandbox";
import { gateMutation } from "./execution-gate";
import type { ExecutionMode } from "./execution-mode";
import { promptWithHistory, type HistoryMessage } from "./history";

export type CursorAuth = { authKind: "api_key"; secret: string };

type CursorCreateOpts = {
  apiKey: string;
  model: { id: string; params: Array<{ id: string; value: string }> };
  tools: string[];
  local: { cwd: string; store: JsonlLocalAgentStore };
};

type CursorRun = {
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{
    status: string;
    result?: string | null;
    error?: { message?: string };
  }>;
  cancel: () => Promise<void>;
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

export type CreateCursorAgent = (opts: CursorCreateOpts) => Promise<CursorAgent>;

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
};

export type CursorRunHandle = {
  cancel: () => Promise<void>;
};

function storeDir(cwd: string): string {
  const slug = Buffer.from(cwd).toString("hex").slice(0, 24);
  const dir = join(tmpdir(), "chavez-cursor", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gateCursorTool(
  cwd: string,
  mode: ExecutionMode | undefined,
  name: string,
  args: Record<string, unknown> | null,
): { allow: boolean; message?: string } {
  const escaped = denyIfEscapes(cwd, name, args);
  if (escaped) return { allow: false, message: escaped.message };
  const ignored = denyIfIgnored(cwd, name, args);
  if (ignored) return { allow: false, message: ignored.message };
  if (!mode) return { allow: true };
  const g = gateMutation(mode, name);
  if (g.decision === "deny") return { allow: false, message: g.message };
  return { allow: true };
}

export async function runCursorTurn(
  input: RunCursorTurnInput,
): Promise<string> {
  const prompt = promptWithHistory(input.prompt, input.history ?? []);
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
      (async (opts) => Agent.create(opts as Parameters<typeof Agent.create>[0]));

    // Nunca pasar cloud. Nunca repos / autoCreatePR.
    agent = await create({
      apiKey: input.auth.secret,
      model: modelSel,
      tools: [...DEFAULT_CURSOR_TOOLS],
      local: { cwd: input.cwd, store },
    });

    run = await agent.send(prompt, {
      model: modelSel,
      onDelta: async ({ update }) => {
        if (update.type === "text-delta" && update.text) {
          await input.onEvent?.({ kind: "stream_delta", text: update.text });
        }
      },
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
      };
      if (ev.type === "tool_call" && ev.status === "running") {
        const args =
          ev.args && typeof ev.args === "object" && !Array.isArray(ev.args)
            ? (ev.args as Record<string, unknown>)
            : null;
        const gated = gateCursorTool(
          input.cwd,
          input.executionMode,
          String(ev.name || "tool"),
          args,
        );
        if (!gated.allow) {
          await run.cancel();
          throw new Error(gated.message || "Tool denied");
        }
      }
      await emitCursorEvent(ev, input.onEvent);
    }

    const result = await run.wait();
    if (result.status === "cancelled") {
      throw new Error("Turn cancelled");
    }
    if (result.status === "error") {
      throw classifyCursorError(
        new Error(result.error?.message || "Cursor run error"),
        input.model,
      );
    }
    const text = result.result ?? "";
    await input.onEvent?.({ kind: "result", text });
    return text;
  } catch (err) {
    if (input.signal?.aborted) throw new Error("Turn cancelled");
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
