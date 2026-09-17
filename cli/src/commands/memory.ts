import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { readWorkspaceState, cwdPath } from "../workspace";
import type { MemoryRecord } from "../llm/memory-format";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

function currentWorkspaceId(flag?: string): string | undefined {
  if (flag) return flag;
  const st = readWorkspaceState(cwdPath());
  return st?.workspaceId;
}

export async function memoryCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "list") {
    const wsFlag = rest[0] === "--workspace" ? rest[1] : undefined;
    const workspaceId = currentWorkspaceId(wsFlag);
    const q = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const data = await apiFetch<{ memories: MemoryRecord[] }>(
      `/memories${q}`,
      {},
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "add") {
    let scope: "user" | "workspace" = "workspace";
    let workspaceId: string | undefined;
    const parts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--scope") {
        const v = rest[++i];
        if (v !== "user" && v !== "workspace") {
          throw new Error("Uso: chavez memory add [--scope user|workspace] [--workspace <id>] <fact…>");
        }
        scope = v;
        continue;
      }
      if (a === "--workspace") {
        workspaceId = rest[++i];
        continue;
      }
      parts.push(a);
    }
    const fact = parts.join(" ").trim();
    if (!fact) {
      throw new Error("Uso: chavez memory add [--scope user|workspace] [--workspace <id>] <fact…>");
    }
    if (scope === "workspace") {
      workspaceId = currentWorkspaceId(workspaceId);
      if (!workspaceId) {
        throw new Error(
          "workspaceId is required when scope is workspace (abre el cwd con chavez headless workspace open o pasa --workspace)",
        );
      }
    }
    const data = await apiFetch(
      "/memories",
      {
        method: "POST",
        body: JSON.stringify({ fact, scope, workspaceId }),
      },
      token(),
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "rm") {
    const id = rest[0];
    if (!id) throw new Error("Uso: chavez memory rm <id>");
    const data = await apiFetch(`/memories/${id}`, { method: "DELETE" }, token());
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("Uso: chavez memory list|add|rm");
}
