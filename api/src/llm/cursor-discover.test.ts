import { describe, expect, test } from "bun:test";
import {
  catalogIsFresh,
  fetchCursorModelsRaw,
  CATALOG_TTL_MS,
} from "./cursor-discover";

describe("fetchCursorModelsRaw", () => {
  test("wraps SDK list and keeps extra fields on the raw item", async () => {
    const raw = await fetchCursorModelsRaw("k", async () => [
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        mystery: true,
        parameters: [
          {
            id: "fast",
            values: [{ value: "false" }, { value: "true" }],
          },
        ],
      },
    ]);
    expect(raw).toEqual({
      provider: "cursor",
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          mystery: true,
          parameters: [
            {
              id: "fast",
              values: [{ value: "false" }, { value: "true" }],
            },
          ],
        },
      ],
    });
    const item = (raw as { models: Array<{ mystery?: boolean }> }).models[0];
    expect(item?.mystery).toBe(true);
  });

  test("propagates list errors (caller must not delete credentials)", async () => {
    await expect(
      fetchCursorModelsRaw("k", async () => {
        throw new Error("Invalid API key");
      }),
    ).rejects.toThrow("Invalid API key");
  });
});

describe("catalogIsFresh", () => {
  test("fresh within TTL, stale after", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    expect(catalogIsFresh(new Date(now.getTime() - 1000), now)).toBe(true);
    expect(catalogIsFresh(new Date(now.getTime() - 301_000), now)).toBe(false);
    expect(CATALOG_TTL_MS).toBe(300_000);
  });
});
