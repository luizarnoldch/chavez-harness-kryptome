import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { cwdPath } from "../workspace";
import {
  NO_USAGE_TEXT,
  assertNoSecrets,
} from "../llm/usage-codec";
import { formatProviderList } from "./provider-format";
import { formatOnboardingHint } from "../onboarding/print";
import type { OnboardingSnapshot } from "../onboarding/status";

export type WhoamiUsageRow = {
  chatId: string;
  createdAt?: string | Date;
  provider?: string;
  display: string;
};

export function formatWhoamiUsage(recent: WhoamiUsageRow[] | undefined): string {
  if (!recent?.length) return `Usage reciente: ${NO_USAGE_TEXT}`;
  const lines = ["Usage reciente:"];
  for (const row of recent) {
    const id = row.chatId.slice(0, 8);
    const prov = row.provider || "";
    lines.push(`  ${id} ${prov} ${row.display}`.trimEnd());
  }
  const text = lines.join("\n");
  assertNoSecrets(text);
  return text;
}

export async function whoamiCommand(): Promise<void> {
  const config = loadConfig();
  if (!config.accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
  const me = await apiFetch<{
    user: { id: string; email: string; name: string };
  }>("/me");
  let usageBlock = `Usage reciente: ${NO_USAGE_TEXT}`;
  try {
    const data = await apiFetch<{ recent?: WhoamiUsageRow[] }>("/me/usage");
    usageBlock = formatWhoamiUsage(data.recent);
  } catch {
    usageBlock = `Usage reciente: ${NO_USAGE_TEXT}`;
  }
  const providers = await apiFetch<{
    activeProvider: string | null;
    activeModel: string | null;
    activeEffort: string | null;
    activeParams?: Array<{ id: string; value: string }> | null;
    providers: Record<
      string,
      { linked: boolean; runnable?: boolean; authKind?: string }
    >;
  }>("/providers");
  const out = [
    `cwd: ${cwdPath()}`,
    `API: ${config.apiUrl}`,
    `User: ${me.user.email} (${me.user.id})`,
    `Name: ${me.user.name}`,
    usageBlock,
    formatProviderList(providers),
  ].join("\n");
  assertNoSecrets(out);
  if (config.accessToken && out.includes(config.accessToken)) {
    throw new Error("whoami leaked accessToken");
  }
  console.log(out);
  try {
    const snap = await apiFetch<OnboardingSnapshot>("/me/onboarding");
    const hint = formatOnboardingHint(snap);
    if (hint) {
      console.log("");
      console.log(hint);
    }
  } catch {
    // whoami de identidad no depende del wizard
  }
}
