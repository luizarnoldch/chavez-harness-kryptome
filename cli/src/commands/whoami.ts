import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { cwdPath } from "../workspace";
import { formatProviderList } from "./provider-format";

export async function whoamiCommand(): Promise<void> {
  const config = loadConfig();
  if (!config.accessToken) {
    throw new Error("No hay sesión. Ejecuta: chavez login");
  }
  const me = await apiFetch<{
    user: { id: string; email: string; name: string };
  }>("/me");
  console.log(`cwd: ${cwdPath()}`);
  console.log(`API: ${config.apiUrl}`);
  console.log(`User: ${me.user.email} (${me.user.id})`);
  console.log(`Name: ${me.user.name}`);
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
  console.log(formatProviderList(providers));
}
