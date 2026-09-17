/**
 * Non-interactive check: providers catalog + optional Claude turn.
 * Usage: bun run scripts/llm-smoke.ts
 */
import { loadConfig } from "../cli/src/config";
import { apiFetch } from "../cli/src/api-client";
import { runClaudeTurn } from "../cli/src/llm/claude-runner";
import { parseExecutionMode } from "../cli/src/llm/execution-mode";
import { cwdPath } from "../cli/src/workspace";

const config = loadConfig();
if (!config.accessToken) {
  console.error("Need chavez login");
  process.exit(1);
}

const info = await apiFetch<{
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeExecutionMode: string | null;
  providers: Record<
    string,
    { linked: boolean; models?: { id: string; label: string }[] }
  >;
}>("/providers");

console.log("activeProvider", info.activeProvider);
console.log("activeModel", info.activeModel);
console.log("activeEffort", info.activeEffort);
console.log("activeExecutionMode", info.activeExecutionMode);
console.log(
  "claude models",
  info.providers.claude?.models?.map((m) => m.id).join(", ")
);
console.log("claude linked", info.providers.claude?.linked);

if (info.activeProvider === "cursor") {
  console.log(
    "active provider is cursor; use cli/scripts/cursor-provider-smoke.ts",
  );
  process.exit(0);
}

if (!info.providers.claude?.linked) {
  console.log("SKIP LLM turn (claude not linked)");
  process.exit(0);
}

const creds = await apiFetch<{
  authKind: "oauth_token" | "api_key";
  secret: string;
}>("/providers/claude/credentials");

console.log("authKind", creds.authKind, "calling Claude…");
const text = await runClaudeTurn({
  prompt: "Responde solo con la palabra: pong",
  model: info.activeModel || "claude-sonnet-4-6",
  effort: (info.activeEffort as "none" | "low" | "medium" | "high") || "low",
  auth: { authKind: creds.authKind, secret: creds.secret },
  cwd: cwdPath(),
  executionMode: parseExecutionMode(info.activeExecutionMode),
});
console.log("assistant:", text.slice(0, 200));
console.log("LLM SMOKE PASS");
