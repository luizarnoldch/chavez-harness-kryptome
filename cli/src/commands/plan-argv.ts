export const PLAN_ARGV_USAGE =
  "Uso: chavez headless chat plan <list|get|update|current|apply> <chatId> …";

export function parsePlanArgv(rest: string[]): {
  sub: "list" | "get" | "update" | "current" | "apply";
  chatId: string;
  artifactId?: string;
  stdin: boolean;
} {
  const sub = rest[0];
  const chatId = rest[1];
  const allowed = ["list", "get", "update", "current", "apply"] as const;
  if (!allowed.includes(sub as (typeof allowed)[number]) || !chatId) {
    throw new Error(PLAN_ARGV_USAGE);
  }
  return {
    sub: sub as (typeof allowed)[number],
    chatId,
    artifactId: rest[2] && rest[2] !== "--stdin" ? rest[2] : undefined,
    stdin: rest.includes("--stdin"),
  };
}
