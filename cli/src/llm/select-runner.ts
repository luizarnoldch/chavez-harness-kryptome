export type RunnerKind = "claude" | "cursor";

export function selectRunner(p: {
  activeProvider: string | null;
  providers: Record<
    string,
    { linked?: boolean; runnable?: boolean; catalogError?: string | null }
  >;
}): { kind: RunnerKind } {
  const active = p.activeProvider || "claude";
  if (active === "claude") {
    if (!p.providers.claude?.linked) {
      throw new Error("Claude no está vinculado — chavez provider link claude");
    }
    return { kind: "claude" };
  }
  if (active === "cursor") {
    if (!p.providers.cursor?.linked) {
      throw new Error(
        "Cursor no está vinculado — chavez provider link cursor (o Web /providers)",
      );
    }
    if (!p.providers.cursor.runnable) {
      throw new Error(
        "Cursor no es ejecutable (catálogo no disponible). Reintenta o re-vincula.",
      );
    }
    return { kind: "cursor" };
  }
  throw new Error(
    `Provider activo "${active}" no ejecuta agente en daemon (claude|cursor)`,
  );
}
