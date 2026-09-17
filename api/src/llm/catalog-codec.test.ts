import { describe, expect, test } from "bun:test";
import {
  INVALID_PROVIDER_MODEL,
  clampCursorParams,
  hasCursorRouter,
  parseClaudeModels,
  parseCursorModels,
  defaultCursorParams,
} from "./catalog-codec";
import type { CursorCatalog, CursorModelInfo } from "./cursor-types";

describe("parseClaudeModels", () => {
  test("preserves effortLevels and prices", () => {
    const models = parseClaudeModels({
      models: [
        {
          id: "claude-sonnet-4-6",
          label: "Sonnet 4.6",
          inputPricePerMTok: 3,
          outputPricePerMTok: 15,
          effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("claude-sonnet-4-6");
    expect(models[0]!.label).toBe("Sonnet 4.6");
    expect(models[0]!.inputPricePerMTok).toBe(3);
    expect(models[0]!.outputPricePerMTok).toBe(15);
    expect(models[0]!.effortLevels).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("hasCursorRouter", () => {
  test("true when auto-smart has optimize_for values", () => {
    const catalog: CursorCatalog = {
      id: "cursor",
      label: "Cursor",
      models: parseCursorModels({
        models: [
          {
            id: "auto-smart",
            displayName: "Auto",
            parameters: [
              {
                id: "optimize_for",
                values: [
                  { value: "cost" },
                  { value: "balanced" },
                  { value: "intelligence" },
                ],
              },
            ],
          },
        ],
      }),
    };
    expect(hasCursorRouter(catalog)).toBe(true);
  });

  test("false when auto-smart is missing (do not invent Router)", () => {
    const catalog: CursorCatalog = {
      id: "cursor",
      label: "Cursor",
      models: parseCursorModels({
        models: [{ id: "composer-2.5", displayName: "Composer 2.5" }],
      }),
    };
    expect(hasCursorRouter(catalog)).toBe(false);
  });
});

describe("defaultCursorParams", () => {
  test("includes fast for composer-2.5", () => {
    const models = parseCursorModels({
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            {
              id: "fast",
              values: [
                { value: "false" },
                { value: "true", displayName: "Fast" },
              ],
            },
          ],
        },
      ],
    });
    const params = defaultCursorParams(models[0]!);
    expect(params.some((p) => p.id === "fast")).toBe(true);
    expect(params.find((p) => p.id === "fast")?.value).toBe("false");
  });
});

describe("parseCursorModels extras", () => {
  test("does not drop a model because of an extra field", () => {
    const models = parseCursorModels({
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          mystery: true,
        },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("composer-2.5");
    expect(
      (models[0] as CursorModelInfo & { mystery?: boolean }).mystery,
    ).toBeUndefined();
  });
});

describe("clampCursorParams", () => {
  test("drops optimize_for=default and fills balanced if listed", () => {
    const model = parseCursorModels({
      models: [
        {
          id: "auto-smart",
          displayName: "Auto",
          parameters: [
            {
              id: "optimize_for",
              values: [
                { value: "cost" },
                { value: "balanced" },
                { value: "intelligence" },
              ],
            },
          ],
        },
      ],
    })[0]!;
    const clamped = clampCursorParams(model, [
      { id: "optimize_for", value: "default" },
    ]);
    expect(clamped.find((p) => p.id === "optimize_for")?.value).toBe("balanced");
  });
});

describe("INVALID_PROVIDER_MODEL", () => {
  test("names both model and provider", () => {
    const msg = INVALID_PROVIDER_MODEL("claude-sonnet-4-6", "cursor");
    expect(msg).toContain("claude-sonnet-4-6");
    expect(msg).toContain("cursor");
  });
});
