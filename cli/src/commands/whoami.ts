import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { cwdPath } from "../workspace";

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
}
