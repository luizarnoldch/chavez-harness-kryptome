export const CURSOR_UNLINKED =
  "Cursor no está vinculado — chavez provider link cursor (o Web /providers)";
export const CURSOR_AUTH_ERROR =
  "Cursor authentication failed — re-link: chavez provider link cursor (o Web /providers)";
export const CURSOR_NOT_RUNNABLE =
  "Cursor no es ejecutable (catálogo no disponible). Reintenta o re-vincula.";

export function cursorModelUnavailable(id: string): string {
  return `Model "${id}" is not available for this Cursor account. Choose another from the discovered catalog.`;
}

export function classifyCursorError(err: unknown, modelId: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: string }).code || "")
      : "";
  const lower = msg.toLowerCase();
  if (
    name === "AuthenticationError" ||
    code === "unauthenticated" ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return new Error(CURSOR_AUTH_ERROR);
  }
  if (
    name === "ConfigurationError" ||
    lower.includes("bad model") ||
    lower.includes("unknown model") ||
    (lower.includes("model") &&
      (lower.includes("not available") || lower.includes("not found")))
  ) {
    return new Error(cursorModelUnavailable(modelId));
  }
  return err instanceof Error ? err : new Error(msg);
}
