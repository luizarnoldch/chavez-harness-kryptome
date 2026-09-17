export function formatProviderList(data: {
  activeProvider: string | null;
  activeModel?: string | null;
  activeEffort?: string | null;
  activeParams?: Array<{ id: string; value: string }> | null;
  providers: Record<
    string,
    {
      linked: boolean;
      authKind?: string;
      runnable?: boolean;
      catalogError?: string | null;
      models?: unknown[];
    }
  >;
}): string {
  const params =
    data.activeParams?.map((p) => `${p.id}=${p.value}`).join(",") || "—";
  const lines = [
    `Active: ${data.activeProvider ?? "(none)"} / ${data.activeModel ?? "—"} / effort=${data.activeEffort ?? "—"} / params=${params}`,
  ];
  for (const [name, info] of Object.entries(data.providers)) {
    if (info.linked) {
      const run = info.runnable ? "runnable" : "not-runnable";
      const err = info.catalogError ? ` catalogError=${info.catalogError}` : "";
      const n = Array.isArray(info.models) ? info.models.length : 0;
      lines.push(
        `- ${name}: linked (${info.authKind}) ${run} models=${n}${err}`,
      );
    } else {
      lines.push(`- ${name}: not linked`);
    }
  }
  return lines.join("\n");
}

export function assertNoSecret(haystack: string, secret: string): void {
  if (secret && haystack.includes(secret)) {
    throw new Error("secret leaked");
  }
}
