import { apiFetch } from "../api-client";
import type { MemoryRecord, SaveMemoryInput } from "./memory-format";

export type MemoryApi = {
  list: (workspaceId: string | null) => Promise<MemoryRecord[]>;
  save: (input: SaveMemoryInput) => Promise<MemoryRecord>;
  forget: (id: string) => Promise<void>;
};

export function createMemoryHttpApi(
  token: string | undefined,
  fallbackWorkspaceId: string | null,
): MemoryApi {
  return {
    async list(workspaceId) {
      const id = workspaceId ?? fallbackWorkspaceId;
      const q = id ? `?workspaceId=${encodeURIComponent(id)}` : "";
      const data = await apiFetch<{ memories: MemoryRecord[] }>(
        `/memories${q}`,
        {},
        token,
      );
      return data.memories ?? [];
    },
    async save(input) {
      const body = {
        ...input,
        workspaceId: input.workspaceId ?? fallbackWorkspaceId,
      };
      const data = await apiFetch<{ memory: MemoryRecord }>(
        "/memories",
        { method: "POST", body: JSON.stringify(body) },
        token,
      );
      return data.memory;
    },
    async forget(id) {
      await apiFetch(`/memories/${id}`, { method: "DELETE" }, token);
    },
  };
}
