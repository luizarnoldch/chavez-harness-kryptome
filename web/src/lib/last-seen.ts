export function formatLastSeen(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "nunca";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "nunca";
  const ms = now - t;
  if (ms < 2000) return "ahora";
  if (ms < 60_000) return `hace ${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)}m`;
  return `hace ${Math.floor(ms / 3_600_000)}h`;
}
