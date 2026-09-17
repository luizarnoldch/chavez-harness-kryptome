import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { publishAgentTurn } from "../llm/publish-turn";
import {
  clearWorkspaceState,
  cwdPath,
  isPidAlive,
  readWorkspaceState,
  writeWorkspaceState,
} from "../workspace";
import { ChavezWsClient } from "../ws/client";
import { resolveCiMode } from "./args";
import {
  CI_BUSY,
  CI_SESSION_TITLE,
  CI_SOURCE,
  CI_TIMEOUT,
  NO_SESSION_CI,
} from "./constants";
import { CiCliError, askCiError } from "./errors";
import { pushToCiEvent } from "./events";
import { formatCiPush, printCiLine } from "./format";
import { ciExitCode, foldCiEvents } from "./outcome";
import { collectCiSecrets, redactCiLog } from "./redact-log";
import type { CiEvent, CiTurnOutcome } from "./types";

export function selectRunnerMode(input: {
  existingPid?: number;
  existingAlive: boolean;
  selfPid: number;
}): "in-process" | "client-wait" {
  if (
    input.existingAlive &&
    input.existingPid != null &&
    input.existingPid !== input.selfPid
  ) {
    return "client-wait";
  }
  return "in-process";
}

export type RunCiInput = {
  prompt: string;
  chatId?: string | null;
  sessionId?: string | null;
  modeFlag?: "auto" | "plan" | "ask";
  timeoutMs: number;
  cwd?: string;
  token?: string;
  now?: () => number;
  publish?: typeof publishAgentTurn;
  fetchProviders?: () => Promise<{
    activeExecutionMode?: string | null;
    activeProvider?: string | null;
  }>;
  putMode?: (mode: "auto" | "plan") => Promise<void>;
};

async function readStdinPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function resolvePrompt(args: {
  prompt: string;
  readStdin: boolean;
}): Promise<string> {
  if (args.prompt.trim()) return args.prompt.trim();
  if (args.readStdin) return readStdinPrompt();
  return "";
}

type ProvidersSnap = {
  activeExecutionMode?: string | null;
  activeProvider?: string | null;
  providers?: Record<string, { linked?: boolean }>;
};

export async function prepareCiMode(
  input: RunCiInput,
): Promise<"auto" | "plan"> {
  const snap: ProvidersSnap = input.fetchProviders
    ? await input.fetchProviders()
    : await apiFetch<ProvidersSnap>("/providers");
  const resolved = resolveCiMode({
    flag: input.modeFlag,
    envMode: process.env.CHAVEZ_EXECUTION_MODE,
    prefsMode: snap.activeExecutionMode,
  });
  if (!resolved.ok) throw askCiError();
  if (resolved.putPrefs) {
    const put =
      input.putMode ??
      (async (mode: "auto" | "plan") => {
        try {
          await apiFetch("/providers/preferences", {
            method: "PUT",
            body: JSON.stringify({ activeExecutionMode: mode }),
          });
        } catch {
          // Older APIs may not expose this preference yet.
        }
      });
    await put(resolved.mode);
  }
  return resolved.mode;
}

export type WaitForTurn = Promise<CiTurnOutcome> & {
  fail: (error: string) => void;
};

export function waitForTurn(input: {
  client: ChavezWsClient;
  chatId: string;
  timeoutMs: number;
  onLine?: (line: string) => void;
}): WaitForTurn {
  const events: CiEvent[] = [];
  let settled = false;
  let settle: (value: CiTurnOutcome) => void = () => {};
  const done = new Promise<CiTurnOutcome>((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });
  const unsubscribe = input.client.onPush((message) => {
    const data = (message.data || {}) as { chatId?: string };
    if (data.chatId && data.chatId !== input.chatId) return;
    const line = formatCiPush({ type: message.type, data: message.data });
    if (line) input.onLine?.(line);
    const event = pushToCiEvent({
      type: message.type,
      data: message.data,
    });
    if (event) events.push(event);
    if (
      message.type === "chat.stream.end" ||
      message.type === "chat.stream.error" ||
      message.type === "agent.turn.ended"
    ) {
      settle(foldCiEvents(events));
    }
  });
  const timer = setTimeout(() => {
    settle(foldCiEvents([...events, { kind: "timeout" }]));
  }, input.timeoutMs);
  const wrapped = done.finally(() => {
    clearTimeout(timer);
    unsubscribe();
  }) as WaitForTurn;
  wrapped.fail = (error: string) => {
    settle(
      foldCiEvents([
        ...events,
        error === CI_TIMEOUT
          ? { kind: "timeout" }
          : { kind: "stream_error", error },
      ]),
    );
  };
  return wrapped;
}

async function ensureChat(
  client: ChavezWsClient,
  input: RunCiInput,
): Promise<string> {
  if (input.chatId) return input.chatId;
  let sessionId = input.sessionId;
  if (!sessionId) {
    const created = await client.request({
      type: "session.create",
      title: CI_SESSION_TITLE,
    });
    if (!created.ok) {
      throw new CiCliError(created.error || "session.create failed");
    }
    sessionId = (created.data as { session?: { id: string } })?.session?.id;
    if (!sessionId) throw new CiCliError("session.create failed");
  }
  const created = await client.request({
    type: "chat.create",
    sessionId,
    title: input.prompt.trim().slice(0, 80) || CI_SESSION_TITLE,
  });
  if (!created.ok) {
    throw new CiCliError(created.error || "chat.create failed");
  }
  const chatId = (created.data as { chat?: { id: string } })?.chat?.id;
  if (!chatId) throw new CiCliError("chat.create failed");
  return chatId;
}

export async function runCiTurn(input: RunCiInput): Promise<{
  outcome: CiTurnOutcome;
  exitCode: number;
  chatId: string;
}> {
  const token = input.token ?? loadConfig().accessToken;
  if (!token) throw new CiCliError(NO_SESSION_CI, 1);
  const cwd = input.cwd ?? cwdPath();
  const executionMode = await prepareCiMode(input);

  const existing = readWorkspaceState(cwd);
  const mode = selectRunnerMode({
    existingPid: existing?.pid,
    existingAlive: Boolean(existing && isPidAlive(existing.pid)),
    selfPid: process.pid,
  });

  const client = new ChavezWsClient(token);
  let wroteState = false;
  const secrets = collectCiSecrets();
  const onLine = (line: string) => printCiLine("stdout", line, secrets);

  try {
    await client.connect();
    const bound = await client.bind(
      cwd,
      mode === "in-process" ? "daemon" : "client",
    );
    if (!bound.ok) throw new CiCliError(bound.error || "bind failed");
    const workspace = (bound.data as { workspace?: { id: string } })?.workspace;
    if (mode === "in-process") {
      writeWorkspaceState({
        path: cwd,
        pid: process.pid,
        openedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
        workspaceId: workspace?.id,
      });
      wroteState = true;
    }

    const chatId = await ensureChat(client, input);
    const waiting = waitForTurn({
      client,
      chatId,
      timeoutMs: input.timeoutMs,
      onLine,
    });

    if (mode === "client-wait") {
      const response = await client.request(
        {
          type: "agent.turn.request",
          chatId,
          prompt: input.prompt,
          enqueue: false,
          metadata: { ci: true, source: CI_SOURCE },
        },
        30_000,
      );
      if (!response.ok) {
        const error = response.error || "agent.turn.request failed";
        if (error === "ask no válido en no-interactivo") {
          waiting.fail(error);
          throw askCiError();
        }
        if (/Turn already running|not queued/i.test(error)) {
          waiting.fail(CI_BUSY);
          const outcome = foldCiEvents([{ kind: "busy" }]);
          return { outcome, exitCode: ciExitCode(outcome), chatId };
        }
        waiting.fail(error);
        throw new CiCliError(error, 1);
      }
      const responseData = (response.data || {}) as {
        queued?: boolean;
        queueId?: string;
      };
      const dispatched = responseData.queued !== true;
      if (responseData.queued) {
        if (responseData.queueId) {
          await client
            .request({
              type: "agent.queue.cancel",
              queueId: responseData.queueId,
            })
            .catch(() => {});
        }
        waiting.fail(CI_BUSY);
        const outcome = foldCiEvents([{ kind: "busy" }]);
        return { outcome, exitCode: ciExitCode(outcome), chatId };
      }
      const outcome = await waiting;
      if (outcome.timedOut) {
        if (responseData.queueId && !dispatched) {
          await client
            .request({
              type: "agent.queue.cancel",
              queueId: responseData.queueId,
            })
            .catch(() => {});
        }
        if (dispatched) {
          await client
            .request({ type: "agent.turn.cancel", chatId })
            .catch(() => {});
        }
      }
      return { outcome, exitCode: ciExitCode(outcome), chatId };
    }

    const publish = input.publish ?? publishAgentTurn;
    const abortController = new AbortController();
    let timedOut = false;
    void waiting.then((outcome) => {
      if (outcome.timedOut) {
        timedOut = true;
        abortController.abort();
      }
    });
    try {
      await publish({
        client,
        chatId,
        prompt: input.prompt,
        cwd,
        token,
        skipUserAppend: false,
        executionMode,
        source: CI_SOURCE,
        signal: abortController.signal,
        abortController,
      });
    } catch (error) {
      const message = redactCiLog(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      if (!timedOut) {
        printCiLine("stderr", message, secrets);
        waiting.fail(message);
      }
    }
    const outcome = await waiting;
    return { outcome, exitCode: ciExitCode(outcome), chatId };
  } finally {
    if (wroteState) clearWorkspaceState(cwd);
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  }
}
