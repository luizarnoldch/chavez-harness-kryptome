// keep-in-sync with cli/src/llm/verify-outcome.ts + verify-constants.ts (no cli/ imports in web)

export const VERIFY_TIMEOUT_ERROR = "Verification timed out after 120s";

export type VerificationView = {
  status: string;
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  silentSuccess?: boolean;
};

export function verificationFromMeta(
  meta: Record<string, unknown> | null | undefined,
): VerificationView | null {
  const v = meta?.verification;
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const status = String(rec.status || "");
  if (!status) return null;
  return {
    status,
    kind: rec.kind === "lint" ? "lint" : "verify",
    command: String(rec.command || ""),
    exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
    timedOut: Boolean(rec.timedOut),
    silentSuccess: Boolean(rec.silentSuccess),
  };
}

export function toolKindLabel(kind: unknown, fallbackName: string): string {
  if (kind === "verify") return "test";
  if (kind === "lint") return "lint";
  return fallbackName || "tool";
}

export function verificationBannerText(v: VerificationView): string | null {
  if (v.status === "failed") {
    return `Verificación falló · ${v.command} · exit ${v.exitCode ?? "?"}. El assistant debe explicar el fallo.`;
  }
  if (v.status === "timeout") {
    return `Verificación: timeout de 120s · ${v.command}. El turn se cerró.`;
  }
  if (v.status === "proposed") {
    return `Modo plan: comando propuesto · ${v.command} (no ejecutado; no se escriben coverage ni snapshots).`;
  }
  if (v.status === "skipped" && !v.command) {
    return null;
  }
  return null;
}
