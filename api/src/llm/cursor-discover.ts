import { wrapCursorRaw } from "./catalog-codec";

export const CATALOG_TTL_MS = 300_000;

export type CursorListFn = (apiKey: string) => Promise<unknown[]>;

async function defaultList(apiKey: string): Promise<unknown[]> {
  const { Cursor } = await import("@cursor/sdk");
  return Cursor.models.list({ apiKey }) as Promise<unknown[]>;
}

export async function fetchCursorModelsRaw(
  apiKey: string,
  listFn: CursorListFn = defaultList,
): Promise<unknown> {
  const models = await listFn(apiKey);
  return wrapCursorRaw(models);
}

export function catalogIsFresh(fetchedAt: Date, now = new Date()): boolean {
  return now.getTime() - fetchedAt.getTime() < CATALOG_TTL_MS;
}
