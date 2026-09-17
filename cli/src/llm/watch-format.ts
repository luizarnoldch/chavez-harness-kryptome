import {
  ALREADY_RESOLVED_ERROR,
  WATCH_APPROVAL_HINT,
} from "./approval-constants";
import { formatRemaining, remainingApprovalMs } from "./approval-deadline";
import {
  formatApprovalHeadline,
  type ApprovalPrompt,
} from "./approval-prompt";
import { canonicalToolName } from "./tool-names";
import { TOOL_OUTPUT_MAX_CHARS, toolHeadline, truncateToolText } from "./tool-display";
import { VERIFY_TIMEOUT_ERROR, VERIFY_WATCH_CHARS } from "./verify-constants";
import { verificationHeadline } from "./verify-outcome";
import { redactText } from "./redact";
import { truncateThinkingPreview } from "./thinking";
import { NO_USAGE_TEXT } from "./usage-codec";

export type WatchPush = {
  type: string;
  data?: unknown;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function metaOf(data: Record<string, unknown>): Record<string, unknown> {
  const message = rec(data.message);
  return rec(message?.metadata) || rec(data.metadata) || {};
}

function formatAwaitingApproval(
  data: Record<string, unknown>,
  t: { name: string; input?: unknown },
): string {
  const meta = metaOf(data);
  const chatId = String(data.chatId ?? rec(data.message)?.chatId ?? "");
  const id = String(meta.toolCallId ?? data.toolCallId ?? "");
  const prompt = meta.prompt as ApprovalPrompt | undefined;
  const needsNet =
    meta.needsNetwork === true ||
    (prompt && "needsNetwork" in prompt && prompt.needsNetwork === true);
  const head = prompt
    ? formatApprovalHeadline(prompt)
    : toolHeadline(t.name, "awaiting_approval", t.input);
  const statusNet = needsNet ? "  pide red" : "";
  const body =
    prompt && (prompt.kind === "write" || prompt.kind === "edit")
      ? `\n${prompt.diff}`
      : prompt?.kind === "bash"
        ? `\n$ ${prompt.command}`
        : prompt?.kind === "fetch"
          ? `\n${prompt.url}`
          : prompt &&
              (prompt.kind === "git_commit" ||
                prompt.kind === "git_push" ||
                prompt.kind === "git_pr" ||
                prompt.kind === "git_branch")
            ? `\n${formatApprovalHeadline(prompt)}`
            : "";
  const deadline =
    typeof meta.approvalDeadline === "string" ? meta.approvalDeadline : "";
  const left = deadline
    ? `\ntimeout in ${formatRemaining(remainingApprovalMs(deadline))}`
    : "";
  const hint =
    chatId && id
      ? `\n${WATCH_APPROVAL_HINT.replace("<chatId>", chatId).replace("<toolCallId>", id)}`
      : `\n${WATCH_APPROVAL_HINT}`;
  return `${head} · awaiting_approval${statusNet}${body}${left}${hint}`;
}

function verifyFromPayload(data: Record<string, unknown>) {
  const message = rec(data.message);
  const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
  const kind = String(meta.kind || "");
  const command = String(meta.command || meta.summary || "");
  const status = String(meta.status || data.status || "");
  return { kind, command, status, output: meta.output ?? message?.content, meta };
}

function formatVerifyToolLine(data: Record<string, unknown>): string | null {
  const v = verifyFromPayload(data);
  if (v.kind !== "verify" && v.kind !== "lint") return null;
  const label = v.kind === "lint" ? "lint" : "test";
  const head = `${label} · ${v.status || "running"}  ${v.command}`.trim();
  if (v.status === "error" || v.status === "done") {
    const body =
      v.output != null
        ? truncateToolText(String(v.output), VERIFY_WATCH_CHARS)
        : "";
    return body ? `${head}\n${body}` : head;
  }
  return head;
}

function toolFromPayload(data: Record<string, unknown>): {
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
} {
  const message = rec(data.message);
  const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
  const sdkName = String(meta.sdkName || meta.toolName || data.toolName || "tool");
  return {
    name: canonicalToolName(sdkName),
    status: String(meta.status || data.status || "running"),
    input: meta.input,
    output: meta.output ?? message?.content,
  };
}

function finishWatchLine(line: string | null): string | null {
  if (line == null) return null;
  return redactText(line);
}

function toolIndent(data: Record<string, unknown>): string {
  return metaOf(data).parentToolCallId ? "  " : "";
}

function finishToolWatchLine(
  data: Record<string, unknown>,
  line: string | null,
): string | null {
  if (line == null) return null;
  return finishWatchLine(`${toolIndent(data)}${line}`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function formatExtensionToolLine(
  data: Record<string, unknown>,
): string | null {
  const meta = metaOf(data);
  const kind = String(meta.kind || "");
  if (kind !== "mcp" && kind !== "skill") return null;
  const t = toolFromPayload(data);
  const input = rec(meta.input) ?? {};
  if (kind === "skill") {
    const name = String(meta.name || input.name || t.name);
    return `${toolIndent(data)}skill · ${name} · ${t.status}`;
  }
  const server = String(meta.mcpServer || "");
  const tool = String(meta.mcpTool || "");
  const canonical = String(
    meta.canonical || (server && tool ? `mcp:${server}/${tool}` : t.name),
  );
  return `${toolIndent(data)}mcp · ${canonical} · ${t.status}`;
}

export function formatDiffStat(diff: {
  path?: string;
  kind?: string;
  additions?: number;
  deletions?: number;
  status?: string;
}): string {
  const path = diff.path || "?";
  const kind = diff.kind || "modified";
  const add = Number(diff.additions || 0);
  const del = Number(diff.deletions || 0);
  const st = diff.status && diff.status !== "applied" ? ` · ${diff.status}` : "";
  return `diff · ${kind} · ${path}  +${add} −${del}${st}`;
}

/** One compact stdout line. Never dumps more than TOOL_OUTPUT_MAX_CHARS. */
export function formatWatchLine(
  msg: WatchPush,
  opts: { verbose?: boolean } = {},
): string | null {
  const data = rec(msg.data) ?? {};
  const meta = metaOf(data);
  if (msg.type === "chat.mcp.status") {
    const servers = Array.isArray(meta.servers)
      ? meta.servers.map(rec).filter((v): v is Record<string, unknown> => !!v)
      : [];
    const explicitFailed = stringList(meta.failed ?? data.failed);
    const failed =
      explicitFailed.length > 0
        ? explicitFailed
        : servers
            .filter((server) => server.status === "failed")
            .map((server) => String(server.name));
    if (failed.length > 0) {
      return finishWatchLine(
        `mcp · failed: ${failed.join(", ")} · native tools continue`,
      );
    }
    const explicitConnected = stringList(meta.connected ?? data.connected);
    const connected =
      explicitConnected.length > 0
        ? explicitConnected
        : servers
            .filter((server) => server.status === "connected")
            .map((server) => String(server.name));
    return finishWatchLine(`mcp · connected: ${connected.join(", ")}`);
  }
  if (msg.type === "chat.skill.activated") {
    return finishWatchLine(
      `skill · ${String(meta.name || data.name || "")} · ${String(meta.layer || data.layer || "")}`,
    );
  }
  if (msg.type === "chat.subagent.start") {
    return finishWatchLine(
      `subagent · ${String(meta.agentType || data.agentType || meta.subagentId || data.id || "")} · running`,
    );
  }
  if (msg.type === "chat.subagent.end") {
    return finishWatchLine(
      `subagent · ${String(meta.agentType || data.agentType || meta.subagentId || data.id || "")} · ${String(meta.status || data.status || "done")}`,
    );
  }
  if (msg.type === "chat.capability.degraded") {
    return finishWatchLine(
      `degraded · ${String(meta.feature || data.feature || "")} · ${String(data.content || meta.message || data.message || "")}`,
    );
  }
  if (msg.type.startsWith("chat.tool.")) {
    const extensionLine = formatExtensionToolLine(data);
    if (extensionLine) return finishWatchLine(extensionLine);
  }
  if (msg.type === "chat.tool.resolved") {
    const outcome = String(data.outcome || "");
    const id = String(data.toolCallId || "").slice(0, 8);
    if (outcome === "timeout") {
      return finishWatchLine(
        `tool · ${id}… · timeout — Approval timed out after 300s — tool denied`,
      );
    }
    return finishWatchLine(
      `tool · ${id}… · ${ALREADY_RESOLVED_ERROR} (${outcome || "resolved"})`,
    );
  }
  if (msg.type === "chat.tool.start") {
    const t = toolFromPayload(data);
    if (t.status === "awaiting_approval") {
      return finishToolWatchLine(data, formatAwaitingApproval(data, t));
    }
    const verifyLine = formatVerifyToolLine(data);
    if (verifyLine) return finishToolWatchLine(data, verifyLine);
    return finishToolWatchLine(
      data,
      toolHeadline(t.name, t.status || "running", t.input),
    );
  }
  if (msg.type === "chat.tool.result" || msg.type === "chat.tool.update") {
    const t = toolFromPayload(data);
    if (t.status === "awaiting_approval") {
      return finishToolWatchLine(data, formatAwaitingApproval(data, t));
    }
    const verifyLine = formatVerifyToolLine(data);
    if (verifyLine) return finishToolWatchLine(data, verifyLine);
    if (meta.resolution && t.status === "error") {
      return finishToolWatchLine(
        data,
        `tool · ${t.name} · error · ${ALREADY_RESOLVED_ERROR} (${meta.resolution})`,
      );
    }
    const head = `tool · ${t.name} · ${t.status}`;
    if (t.status === "error" && t.output != null) {
      return finishToolWatchLine(
        data,
        `${head}\n${truncateToolText(String(t.output), 500)}`,
      );
    }
    if (t.output != null && t.status === "done") {
      const body = truncateToolText(String(t.output), 500);
      const prUrl =
        t.name === "git_pr"
          ? String(meta.prUrl || "")
          : "";
      const extra = prUrl ? `\ngit · pr ${prUrl}` : "";
      return finishToolWatchLine(data, `${head}\n${body}${extra}`);
    }
    return finishToolWatchLine(data, head);
  }
  if (msg.type === "chat.stream.delta") {
    const delta = String(data.delta ?? data.content ?? "");
    if (!delta) return null;
    return finishWatchLine(`assistant Δ ${truncateToolText(delta, 400)}`);
  }
  if (msg.type === "chat.thinking.delta") {
    const delta = String(data.delta ?? "");
    if (!delta) return null;
    return finishWatchLine(
      `thinking Δ ${truncateThinkingPreview(delta, 120)}`,
    );
  }
  if (msg.type === "chat.thinking.end") {
    return data.omitted ? "thinking · omitido" : "thinking · end";
  }
  if (msg.type === "chat.steer") {
    const outcome = String(data.outcome || "");
    return finishWatchLine(
      `steer · ${outcome} · ${truncateThinkingPreview(String(data.content || ""), 80)}`,
    );
  }
  if (msg.type === "chat.stream.start") return "stream start";
  if (msg.type === "chat.stream.end") {
    const status = String(data.status || "finished");
    if (status === "cancelled") return "stream · cancelled";
    const verification =
      rec(data.verification) ?? rec(rec(data.message)?.metadata)?.verification;
    const vrec = rec(verification);
    if (vrec && vrec.status) {
      const line = verificationHeadline({
        status: String(vrec.status) as never,
        kind: vrec.kind === "lint" ? "lint" : "verify",
        command: String(vrec.command || ""),
        exitCode: typeof vrec.exitCode === "number" ? vrec.exitCode : null,
        timedOut: Boolean(vrec.timedOut),
        source: (vrec.source as never) || "agent",
        truncated: Boolean(vrec.truncated),
        silentSuccess: Boolean(vrec.silentSuccess),
      });
      const extra = vrec.silentSuccess ? "  (not silent — tests failed)" : "";
      return finishWatchLine(`verify · ${line}${extra}`);
    }
    const usage = rec(data.usage);
    const display =
      typeof usage?.display === "string" ? usage.display : "";
    if (display && display !== NO_USAGE_TEXT) {
      return finishWatchLine(`stream end\nusage · ${display}`);
    }
    return "stream end";
  }
  if (msg.type === "chat.stream.error") {
    const err = String(data.error ?? data.content ?? "");
    if (err.includes("timed out") || err === VERIFY_TIMEOUT_ERROR) {
      return finishWatchLine(`verify · timeout  ${VERIFY_TIMEOUT_ERROR}`);
    }
    return finishWatchLine(`stream error  ${err}`);
  }
  if (msg.type === "chat.context.usage") {
    const ctx = rec(data.context) ?? rec(data.metadata) ?? data;
    const pct = ctx.pct ?? 0;
    const level = String(ctx.level || "");
    return `context · ${pct}% · ${level}`;
  }
  if (msg.type === "chat.compact.done") {
    return "compact · contexto compactado";
  }
  if (msg.type === "message.appended") {
    const message = rec(data.message);
    if (!message) return null;
    if (data.updated) return null;
    const meta = rec(message.metadata);
    if (meta?.kind === "compact_marker") return "compact · contexto compactado";
    const role = String(message.role || "");
    if (role === "tool") return null;
    const content = truncateToolText(String(message.content || ""), 400);
    const ignored = Array.isArray(meta?.ignoredAttaches)
      ? (meta!.ignoredAttaches as Array<{ error?: string; path?: string }>)
      : [];
    const attachNotes = ignored
      .map((a) => a.error || `Ignored path (not hydrated): ${a.path}`)
      .join(" | ");
    if (attachNotes) return finishWatchLine(`${role}: ${content}\n⚠ ${attachNotes}`);
    return finishWatchLine(`${role}: ${content}`);
  }
  if (msg.type === "agent.turn.started") return "turn started";
  if (msg.type === "agent.turn.ended") return "turn ended";
  if (msg.type === "chat.diff.upsert") {
    if (data.dropped) {
      const diff = rec(data.diff) ?? {};
      return finishWatchLine(`diff · dropped · ${String(diff.path || "")}`);
    }
    const diff = rec(data.diff) ?? {};
    const head = formatDiffStat({
      path: String(diff.path || ""),
      kind: String(diff.kind || "modified"),
      additions: Number(diff.additions || 0),
      deletions: Number(diff.deletions || 0),
      status: String(diff.status || "applied"),
    });
    if (!opts.verbose) return finishWatchLine(head);
    const preview = String(diff.preview || "");
    return finishWatchLine(preview ? `${head}\n${preview}` : head);
  }
  if (msg.type === "chat.checkpoint.undone") {
    const noop = Boolean(data.noop);
    if (noop) return finishWatchLine(`undo · noop  ${String(data.message || "")}`);
    const restored = Array.isArray(data.restored) ? data.restored.length : 0;
    const warning = data.warning ? `\n${String(data.warning)}` : "";
    return finishWatchLine(
      `undo · restored ${restored} path(s) · ${String(data.commitAction || "none")}${warning}`,
    );
  }
  if (msg.type === "chat.checkpoint.finalized") {
    const cp = rec(data.checkpoint);
    if (!cp) return finishWatchLine("checkpoint finalized");
    if (cp.kind !== "git") return finishWatchLine("checkpoint · no git (undo disabled)");
    return finishWatchLine(
      `checkpoint · git · ${(Array.isArray(cp.paths) ? cp.paths.length : 0)} path(s)`,
    );
  }
  if (msg.type === "workspace.git.snapshot") {
    const snap = rec(data.snapshot) ?? rec(data);
    if (!snap) return null;
    if (snap.isRepo === false) return `git · ${String(snap.message || "not a repo")}`;
    const dirty = Array.isArray(snap.dirty) ? snap.dirty.length : 0;
    return `git · ${String(snap.branch || "detached")} ↑${snap.ahead ?? 0} ↓${snap.behind ?? 0}  dirty=${dirty}`;
  }
  if (msg.type === "github.pr.created") {
    const url = String(data.url || "");
    return url ? `git · pr ${url}` : null;
  }
  return null;
}

export { TOOL_OUTPUT_MAX_CHARS };
