import type { CiEvent } from "./types";

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

type CiTurnVerification = "failed" | "timeout" | "passed" | "skipped" | null;

function readVerification(
  data: Record<string, unknown>,
): CiTurnVerification {
  const message = rec(data.message);
  const metadata =
    rec(message?.metadata) ?? rec(data.metadata) ?? rec(data.verification);
  const status =
    metadata && typeof metadata.status === "string" ? metadata.status : null;
  const nested = rec(data.verification) ?? rec(metadata?.verification);
  const verificationStatus =
    (nested && String(nested.status || "")) || status;
  if (
    verificationStatus === "failed" ||
    verificationStatus === "timeout" ||
    verificationStatus === "passed" ||
    verificationStatus === "skipped"
  ) {
    return verificationStatus;
  }
  return null;
}

export function pushToCiEvent(msg: {
  type: string;
  data?: unknown;
}): CiEvent | null {
  const data = rec(msg.data) ?? {};
  if (msg.type === "chat.stream.delta") {
    const text = String(data.delta ?? data.content ?? "");
    return text ? { kind: "assistant_delta", text } : null;
  }
  if (msg.type === "chat.stream.end") {
    return {
      kind: "stream_end",
      content: String(data.content ?? rec(data.message)?.content ?? ""),
      verificationStatus: readVerification(data),
    };
  }
  if (msg.type === "chat.stream.error") {
    return {
      kind: "stream_error",
      error: String(
        data.error ??
          data.content ??
          rec(data.message)?.content ??
          "stream error",
      ),
    };
  }
  if (msg.type === "agent.turn.ended") {
    return { kind: "turn_ended", status: String(data.status ?? "") };
  }
  if (
    msg.type === "chat.tool.start" ||
    msg.type === "chat.tool.result" ||
    msg.type === "chat.tool.update"
  ) {
    const message = rec(data.message);
    const metadata = rec(message?.metadata) ?? rec(data.metadata) ?? {};
    return {
      kind: "tool",
      name: String(metadata.toolName || data.toolName || "tool"),
      status: String(
        metadata.status ||
          data.status ||
          (msg.type === "chat.tool.start" ? "running" : "done"),
      ),
      output:
        metadata.output != null ? String(metadata.output) : undefined,
    };
  }
  return null;
}
