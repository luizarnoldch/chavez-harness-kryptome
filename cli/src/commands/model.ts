import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { invalidProviderModel, modelSetText, SLASH_USAGE_MODEL } from "../llm/slash";
import type { PrefsSnapshot } from "../llm/slash-run";

function requireAuth(): void {
  if (!loadConfig().accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
}

export async function modelCommand(args: string[]): Promise<void> {
  requireAuth();
  const data = await apiFetch<PrefsSnapshot>("/providers");
  const provider = data.activeProvider || "claude";
  const ids =
    data.providers?.[provider]?.models?.map((m) => m.id) ??
    data.catalogs?.find((c) => c.id === provider)?.models.map((m) => m.id) ??
    [];
  const raw = args[0];
  if (!raw || raw === "-h" || raw === "--help") {
    console.log(`Provider: ${provider}`);
    console.log(`Model: ${data.activeModel ?? "(none)"}`);
    for (const id of ids) console.log(`- ${id}`);
    if (!raw) return;
    console.log(SLASH_USAGE_MODEL.replace("/model", "chavez model"));
    return;
  }
  if (!ids.includes(raw)) {
    throw new Error(invalidProviderModel(raw, provider));
  }
  const next = await apiFetch<PrefsSnapshot>("/providers/preferences", {
    method: "PUT",
    body: JSON.stringify({ activeModel: raw }),
  });
  console.log(modelSetText(next.activeModel || raw));
}
