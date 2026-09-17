import { describe, expect, test } from "bun:test";
import { publicProviderPayload } from "../llm/provider-payload";

describe("publicProviderPayload", () => {
  test("cursor raw keeps mystery; parsed models do not explode", () => {
    const raw = {
      provider: "cursor",
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          mystery: true,
        },
      ],
    };
    const payload = publicProviderPayload({
      kind: "cursor",
      linked: true,
      raw,
      lastError: null,
    });
    expect(
      (payload.raw as { models: Array<{ mystery?: boolean }> }).models[0]
        ?.mystery,
    ).toBe(true);
    expect(payload.models[0]?.id).toBe("composer-2.5");
    expect(payload.runnable).toBe(true);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("stub");
  });

  test("linked cursor with null raw and lastError is not runnable", () => {
    const payload = publicProviderPayload({
      kind: "cursor",
      linked: true,
      raw: null,
      lastError: "Invalid API key",
    });
    expect(payload.runnable).toBe(false);
    expect(payload.catalogError).toBe("Invalid API key");
    expect(payload.models).toEqual([]);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("stub");
  });

  test("claude models have effortLevels, not parameters", () => {
    const payload = publicProviderPayload({
      kind: "claude",
      linked: true,
      raw: {
        provider: "claude",
        models: [
          {
            id: "claude-sonnet-4-6",
            label: "Sonnet 4.6",
            inputPricePerMTok: 3,
            outputPricePerMTok: 15,
            effortLevels: ["none", "low", "medium", "high"],
          },
        ],
      },
      lastError: null,
    });
    const m = payload.models[0] as {
      effortLevels?: string[];
      parameters?: unknown;
    };
    expect(m.effortLevels).toContain("medium");
    expect(m.parameters).toBeUndefined();
  });

  test("stringified payload does not include a secret the helper never received", () => {
    const payload = publicProviderPayload({
      kind: "cursor",
      linked: true,
      raw: { provider: "cursor", models: [] },
      lastError: null,
    });
    expect(JSON.stringify(payload)).not.toContain("sk-secret-value");
  });
});
