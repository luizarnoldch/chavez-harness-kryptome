export type VerifyLineMessage = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

export function toolLine(m: VerifyLineMessage): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const kind = String(meta.kind || "");
  const status = String(meta.status || "running");
  const command = String(meta.command || meta.summary || "");
  if (kind === "verify") return `test · ${status}  ${command}`.trim();
  if (kind === "lint") return `lint · ${status}  ${command}`.trim();
  const name = String(meta.toolName || m.content || "tool");
  return `tool · ${name} · ${status}`;
}

export function verificationBanner(
  messages: VerifyLineMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const v = (m.metadata as { verification?: Record<string, unknown> } | null)
      ?.verification;
    if (!v) continue;
    if (v.status === "failed") {
      return `verify failed · ${String(v.command || "")}  exit=${String(v.exitCode ?? "?")}`;
    }
    if (v.status === "timeout") {
      return `verify timeout · ${String(v.command || "")}`;
    }
    if (v.status === "proposed") {
      return `verify proposed · ${String(v.command || "")}  (plan: not run)`;
    }
    return null;
  }
  return null;
}

export function verificationFailureLog(
  messages: VerifyLineMessage[],
): string | null {
  const banner = verificationBanner(messages);
  if (!banner) return null;
  if (banner.startsWith("verify failed") || banner.startsWith("verify timeout")) {
    return banner;
  }
  return null;
}

export function assistantVerificationLine(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const v = (metadata as { verification?: Record<string, unknown> } | null)
    ?.verification;
  if (!v) return null;
  if (v.status === "failed") {
    return `verify failed · ${String(v.command || "")}  exit=${String(v.exitCode ?? "?")}`;
  }
  if (v.status === "timeout") {
    return `verify timeout · ${String(v.command || "")}`;
  }
  if (v.status === "proposed") {
    return `verify proposed · ${String(v.command || "")}  (plan: not run)`;
  }
  return null;
}
