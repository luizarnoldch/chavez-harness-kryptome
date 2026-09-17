/** keep-in-sync: cli/src/llm/turn-replay.ts */

export const TOOL_OUTPUT_MAX_CHARS = 8000;
export const REPLAY_ATTACH_PREVIEW_CHARS = 500;
export const REPLAY_MISSING = "—";
export const NO_USAGE_TEXT = "sin datos";
export const REDACT_REPLACEMENT = "***";
export const REPLAY_NO_TURN = "No finished turn to replay";
export const REPLAY_TURN_RUNNING = "Turn is still running — replay is for finished turns";
export const REPLAY_NOT_FOUND = "Turn not found";
export const DUMP_USAGE = "Uso: chavez headless chat dump <chatId> [streamId]";
export const DUMP_HUB_HINT =
  "Replay: chavez headless chat dump <chatId> [streamId]  → traza texto (prompt, attaches, tools, diffs, assistant, usage, modo, modelo). Sin secrets. No re-ejecuta.";
export const TUI_REPLAY_HINT = "[L] replay último turn  [Esc] cierra replay";

export const REPLAY_SECTION_ORDER = [
  "prompt",
  "attaches",
  "tools",
  "diffs",
  "assistant",
  "usage",
] as const;

export type ReplayStatus = "completed" | "error" | "cancelled" | "undone";

export type ReplayAttach = {
  path: string;
  kind: string;
  status: string;
  preview: string;
};

export type ReplayTool = {
  toolCallId: string;
  name: string;
  status: string;
  input: unknown;
  output: string;
  kind?: string;
  createdAt: string;
};

export type ReplayDiff = {
  path: string;
  kind: string;
  status: string;
  additions: number;
  deletions: number;
  preview: string;
  truncated: boolean;
};

export type TurnReplay = {
  chatId: string;
  streamId: string;
  status: ReplayStatus;
  executionMode: string | null;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
  prompt: string;
  attaches: ReplayAttach[];
  tools: ReplayTool[];
  diffs: ReplayDiff[];
  assistant: string;
  error: string | null;
  usageDisplay: string;
};

export type ReplayChatMessage = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
};

export type ReplayDiffRow = {
  streamId?: string | null;
  path?: string | null;
  kind?: string | null;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
  preview?: string | null;
  truncated?: boolean | null;
  body?: string | null;
};

const KEY_NAME =
  /^(api[_-]?key|token|secret|password|authorization|credential|access[_-]?token|ciphertext)$/i;

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9]+/g,
  /ghu_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const ENV_LINE =
  /^([A-Za-z_][A-Za-z0-9_]*?(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|[A-Za-z0-9_]*))\s*=\s*(.+)$/gm;

const VAULT_PATH_RE = /(?:^|[^\w.])(?:~\/)?\.chavez\/[A-Za-z0-9._\-\/]+/g;

const CANONICAL: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "grep",
  Glob: "glob",
  LS: "glob",
  Bash: "bash",
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function iso(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

export function redactReplayText(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), REDACT_REPLACEMENT);
  }
  out = out.replace(ENV_LINE, (full, k, val) => {
    if (String(val).trim() === "" || String(val) === REDACT_REPLACEMENT) return full;
    return `${k}=${REDACT_REPLACEMENT}`;
  });
  out = out.replace(VAULT_PATH_RE, (m) => {
    const prefix = m[0] === "~" || m[0] === "." ? "" : m[0];
    return `${prefix}${REDACT_REPLACEMENT}`;
  });
  return out;
}

export function redactReplayJson(value: unknown): unknown {
  if (typeof value === "string") return redactReplayText(value);
  if (Array.isArray(value)) return value.map(redactReplayJson);
  const obj = rec(value);
  if (obj) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = KEY_NAME.test(k) ? REDACT_REPLACEMENT : redactReplayJson(v);
    }
    return out;
  }
  return value;
}

export function truncateReplayText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export function canonicalReplayToolName(sdkName: string): string {
  return CANONICAL[sdkName] ?? (sdkName.toLowerCase() || "tool");
}

function metaOf(m: ReplayChatMessage): Record<string, unknown> {
  return rec(m.metadata) ?? {};
}

export function streamIdOf(m: ReplayChatMessage): string | null {
  const meta = metaOf(m);
  const raw = meta.streamId;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function isRunningStatus(status: unknown): boolean {
  return status === "running" || status === "awaiting_approval";
}

export function isTurnFinished(
  tools: ReplayChatMessage[],
  assistant: ReplayChatMessage | undefined,
  error: string | null,
): boolean {
  if (tools.some((t) => isRunningStatus(metaOf(t).status))) return false;
  return Boolean(assistant || error);
}

function summarizeInput(input: unknown): string {
  const clean = redactReplayJson(input);
  if (typeof clean === "string") return truncateReplayText(clean, 200);
  const obj = rec(clean);
  if (!obj) return clean == null ? "" : truncateReplayText(JSON.stringify(clean), 200);
  const cmd = obj.command ?? obj.cmd;
  const path = obj.file_path ?? obj.path ?? obj.notebook_path;
  if (typeof cmd === "string") return truncateReplayText(cmd, 200);
  if (typeof path === "string") return path;
  return truncateReplayText(JSON.stringify(obj), 200);
}

function attachPreview(att: Record<string, unknown>): string {
  const kind = String(att.kind || "text");
  if (kind === "image" || kind === "binary") return "";
  const raw =
    typeof att.hydratedText === "string"
      ? att.hydratedText
      : typeof att.preview === "string"
        ? att.preview
        : "";
  const path = String(att.path || "");
  const looksEnv = /(^|\/)\.env(\.|$)/.test(path) || path.endsWith(".pem");
  const text = looksEnv
    ? redactReplayText(raw).replace(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/gm,
        (full, k, v) =>
          !String(v).trim() || v === REDACT_REPLACEMENT
            ? full
            : `${k}=${REDACT_REPLACEMENT}`,
      )
    : redactReplayText(raw);
  return truncateReplayText(text, REPLAY_ATTACH_PREVIEW_CHARS);
}

function usageDisplayFromMeta(meta: unknown): string {
  const m = rec(meta);
  if (!m) return NO_USAGE_TEXT;
  const blob =
    rec(m.usage) ||
    rec(m.tokenUsage) ||
    (m.kind === "turn_usage" ? rec(m.usage) : null) ||
    m;
  const input =
    num(blob.input_tokens) ??
    num(blob.inputTokens) ??
    num(m.input_tokens) ??
    num(m.inputTokens);
  const output =
    num(blob.output_tokens) ??
    num(blob.outputTokens) ??
    num(m.output_tokens) ??
    num(m.outputTokens);
  const cache =
    num(blob.cache_read_input_tokens) ??
    num(blob.cacheReadInputTokens) ??
    num(blob.cacheReadTokens);
  const usd =
    num(blob.total_cost_usd) ??
    num(blob.costUSD) ??
    num(blob.costUsd) ??
    num(m.total_cost_usd);
  const parts: string[] = [];
  if (input != null) parts.push(`in ${input}`);
  if (output != null) parts.push(`out ${output}`);
  if (cache != null) parts.push(`cache ${cache}`);
  if (usd != null) {
    parts.push(usd >= 0.0001 ? `$${usd.toFixed(4)}` : "<$0.0001");
  }
  return parts.length ? `turn: ${parts.join(" · ")}` : NO_USAGE_TEXT;
}

function strField(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export type AssembleInput = {
  chatId: string;
  messages: ReplayChatMessage[];
  diffs?: ReplayDiffRow[];
  streamId?: string | null;
};

export type AssembleOk = { ok: true; replay: TurnReplay };
export type AssembleErr = { ok: false; error: string };
export type AssembleOutput = AssembleOk | AssembleErr;

function collectStreamIds(messages: ReplayChatMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const id = streamIdOf(m);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function precedingUser(
  messages: ReplayChatMessage[],
  firstIdx: number,
): ReplayChatMessage | undefined {
  for (let i = firstIdx - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return undefined;
}

function sliceForStream(
  messages: ReplayChatMessage[],
  streamId: string,
): {
  user?: ReplayChatMessage;
  tools: ReplayChatMessage[];
  assistant?: ReplayChatMessage;
  error: string | null;
} {
  const indexed = messages.map((m, i) => ({ m, i }));
  const own = indexed.filter(({ m }) => streamIdOf(m) === streamId);
  const tools = own.filter(({ m }) => m.role === "tool").map(({ m }) => m);
  const assistant = own.find(({ m }) => m.role === "assistant")?.m;
  const taggedUser = own.find(({ m }) => m.role === "user")?.m;
  const firstOwn = own[0];
  const user =
    taggedUser ??
    (firstOwn ? precedingUser(messages, firstOwn.i) : undefined);
  let error: string | null = null;
  for (const { m } of own) {
    const meta = metaOf(m);
    if (typeof meta.error === "string" && meta.error) error = meta.error;
    if (m.role === "system" && typeof m.content === "string" && /error/i.test(String(meta.kind || ""))) {
      error = m.content;
    }
  }
  return { user, tools, assistant, error };
}

function replayStatus(
  tools: ReplayChatMessage[],
  assistant: ReplayChatMessage | undefined,
  error: string | null,
): ReplayStatus {
  const undone =
    (assistant && metaOf(assistant).undone === true) ||
    tools.some((t) => metaOf(t).undone === true);
  if (undone) return "undone";
  const cancelled =
    metaOf(assistant ?? {}).cancelled === true ||
    error === "Turn cancelled";
  if (cancelled) return "cancelled";
  if (error) return "error";
  return "completed";
}

function mapAttaches(user: ReplayChatMessage | undefined): ReplayAttach[] {
  const meta = user ? metaOf(user) : {};
  const raw = meta.attachments;
  if (!Array.isArray(raw)) return [];
  const out: ReplayAttach[] = [];
  for (const item of raw) {
    const att = rec(item);
    if (!att) continue;
    const path = String(att.path || "");
    if (!path) continue;
    out.push({
      path,
      kind: String(att.kind || "text"),
      status: String(att.status || "ok"),
      preview: attachPreview(att),
    });
  }
  return out;
}

function mapTools(tools: ReplayChatMessage[]): ReplayTool[] {
  return tools.map((t) => {
    const meta = metaOf(t);
    const sdk = String(meta.sdkName || meta.toolName || t.content || "tool");
    const outputRaw =
      typeof meta.output === "string"
        ? meta.output
        : typeof t.content === "string"
          ? t.content
          : "";
    return {
      toolCallId: String(meta.toolCallId || t.id || ""),
      name: canonicalReplayToolName(sdk),
      status: String(meta.status || "done"),
      input: redactReplayJson(meta.input ?? null),
      output: truncateReplayText(redactReplayText(outputRaw), TOOL_OUTPUT_MAX_CHARS),
      kind: typeof meta.kind === "string" ? meta.kind : undefined,
      createdAt: iso(t.createdAt),
    };
  });
}

function mapDiffs(rows: ReplayDiffRow[] | undefined, streamId: string): ReplayDiff[] {
  if (!rows?.length) return [];
  return rows
    .filter((d) => !d.streamId || d.streamId === streamId)
    .filter((d) => d.status !== "rejected")
    .map((d) => ({
      path: String(d.path || ""),
      kind: String(d.kind || "modified"),
      status: String(d.status || "applied"),
      additions: num(d.additions) ?? 0,
      deletions: num(d.deletions) ?? 0,
      preview: truncateReplayText(redactReplayText(String(d.preview || "")), TOOL_OUTPUT_MAX_CHARS),
      truncated: Boolean(d.truncated),
    }))
    .filter((d) => d.path);
}

export function assembleTurnReplay(input: AssembleInput): AssembleOutput {
  const messages = input.messages ?? [];
  const ids = collectStreamIds(messages);
  const wanted = input.streamId?.trim() || ids[ids.length - 1] || null;
  if (!wanted) {
    // Legacy: último user + tools siguientes + assistant, sin streamId.
    const lastUserIdx = [...messages]
      .map((m, i) => ({ m, i }))
      .reverse()
      .find((x) => x.m.role === "user")?.i;
    if (lastUserIdx == null) return { ok: false, error: REPLAY_NO_TURN };
    const user = messages[lastUserIdx]!;
    const rest = messages.slice(lastUserIdx + 1);
    const tools = rest.filter((m) => m.role === "tool");
    const assistant = rest.find((m) => m.role === "assistant");
    if (!isTurnFinished(tools, assistant, null)) {
      return { ok: false, error: REPLAY_TURN_RUNNING };
    }
    return buildReplay({
      chatId: input.chatId,
      streamId: `legacy-${String(user.id || lastUserIdx)}`,
      user,
      tools,
      assistant,
      error: null,
      diffs: input.diffs,
    });
  }
  if (input.streamId?.trim() && !ids.includes(wanted) && !messages.some((m) => streamIdOf(m) === wanted)) {
    return { ok: false, error: REPLAY_NOT_FOUND };
  }
  const slice = sliceForStream(messages, wanted);
  if (!slice.user && !slice.tools.length && !slice.assistant) {
    return { ok: false, error: REPLAY_NOT_FOUND };
  }
  if (!isTurnFinished(slice.tools, slice.assistant, slice.error)) {
    return { ok: false, error: REPLAY_TURN_RUNNING };
  }
  return buildReplay({
    chatId: input.chatId,
    streamId: wanted,
    user: slice.user,
    tools: slice.tools,
    assistant: slice.assistant,
    error: slice.error,
    diffs: input.diffs,
  });
}

function buildReplay(args: {
  chatId: string;
  streamId: string;
  user?: ReplayChatMessage;
  tools: ReplayChatMessage[];
  assistant?: ReplayChatMessage;
  error: string | null;
  diffs?: ReplayDiffRow[];
}): AssembleOk {
  const userMeta = args.user ? metaOf(args.user) : {};
  const asstMeta = args.assistant ? metaOf(args.assistant) : {};
  const replay: TurnReplay = {
    chatId: args.chatId,
    streamId: args.streamId,
    status: replayStatus(args.tools, args.assistant, args.error),
    executionMode: strField(userMeta, "executionMode") ?? strField(asstMeta, "executionMode"),
    provider:
      strField(userMeta, "provider") ??
      strField(asstMeta, "provider") ??
      (typeof rec(asstMeta)?.kind === "string" && asstMeta.kind === "turn_usage"
        ? strField(asstMeta, "provider")
        : null),
    modelId: strField(asstMeta, "modelId") ?? strField(userMeta, "modelId", "model"),
    effort: strField(userMeta, "effort", "activeEffort") ?? strField(asstMeta, "effort"),
    prompt: redactReplayText(String(args.user?.content ?? "")),
    attaches: mapAttaches(args.user),
    tools: mapTools(args.tools),
    diffs: mapDiffs(args.diffs, args.streamId),
    assistant: redactReplayText(String(args.assistant?.content ?? "")),
    error: args.error ? redactReplayText(args.error) : null,
    usageDisplay: usageDisplayFromMeta(args.assistant?.metadata ?? asstMeta),
  };
  return { ok: true, replay };
}

export function formatTurnReplay(replay: TurnReplay): string {
  const lines: string[] = [
    `turn ${replay.streamId}`,
    `status: ${replay.status}`,
    `mode: ${replay.executionMode || REPLAY_MISSING}`,
    `model: ${replay.modelId || REPLAY_MISSING}`,
    `provider: ${replay.provider || REPLAY_MISSING}`,
    "",
    "## prompt",
    replay.prompt,
  ];
  if (replay.attaches.length) {
    lines.push("", "## attaches");
    for (const a of replay.attaches) {
      lines.push(`@ ${a.path}  ${a.kind}  ${a.status}`);
      if (a.preview) {
        for (const pl of a.preview.split("\n")) lines.push(`  ${pl}`);
      }
    }
  }
  if (replay.tools.length) {
    lines.push("", "## tools");
    for (const t of replay.tools) {
      lines.push(`tool · ${t.name} · ${t.status}`);
      const inn = summarizeInput(t.input);
      if (inn) lines.push(`  in: ${inn}`);
      if (t.output) {
        const outLines = t.output.split("\n");
        lines.push(`  out: ${outLines[0] ?? ""}`);
        for (const extra of outLines.slice(1)) lines.push(`  ${extra}`);
      }
    }
  }
  if (replay.diffs.length) {
    lines.push("", "## diffs");
    for (const d of replay.diffs) {
      lines.push(`${d.path}  ${d.kind}  +${d.additions} −${d.deletions}`);
      if (d.preview) {
        for (const pl of d.preview.split("\n")) lines.push(`  ${pl}`);
      }
    }
  }
  lines.push("", "## assistant", replay.assistant);
  if (replay.error) {
    lines.push("", "## error", replay.error);
  }
  lines.push("", "## usage", replay.usageDisplay);
  return lines.join("\n");
}

export function replayToResult(assembled: AssembleOutput): {
  ok: boolean;
  replay?: TurnReplay;
  text?: string;
  error?: string;
} {
  if (!assembled.ok) return { ok: false, error: assembled.error };
  return {
    ok: true,
    replay: assembled.replay,
    text: formatTurnReplay(assembled.replay),
  };
}

export type ReplayResult =
  | { ok: true; replay: TurnReplay; text: string }
  | { ok: false; error: string };
