import { apiFetch } from "../api-client";
import { loadConfig } from "../config";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

export async function rulesCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const data = await apiFetch<{ rules: unknown[] }>("/rules", {}, token());
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "add") {
    const title = rest[0];
    const body = rest.slice(1).join(" ");
    if (!title || !body) {
      throw new Error("Uso: chavez rules add <title> <body…>");
    }
    const data = await apiFetch(
      "/rules",
      { method: "POST", body: JSON.stringify({ title, body, enabled: true }) },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "disable" || action === "enable") {
    const id = rest[0];
    if (!id) throw new Error(`Uso: chavez rules ${action} <id>`);
    const data = await apiFetch(
      `/rules/${id}`,
      { method: "PUT", body: JSON.stringify({ enabled: action === "enable" }) },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "rm") {
    const id = rest[0];
    if (!id) throw new Error("Uso: chavez rules rm <id>");
    const data = await apiFetch(`/rules/${id}`, { method: "DELETE" }, token());
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("Uso: chavez rules list|add|enable|disable|rm");
}
