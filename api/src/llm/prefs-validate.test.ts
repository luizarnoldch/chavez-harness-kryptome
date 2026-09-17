import { describe, expect, test } from "bun:test";
import { INVALID_PROVIDER_MODEL, INVALID_PROVIDER_PARAM } from "./catalog-codec";
import type { ClaudeCatalog } from "./claude-types";
import type { CursorCatalog } from "./cursor-types";
import { defaultsForProvider, validatePreferences } from "./prefs-validate";

const claude: ClaudeCatalog = {
  id: "claude",
  label: "Claude (Anthropic)",
  models: [
    {
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
      effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
  ],
};

const emptyCurrent = {
  activeProvider: null,
  activeModel: null,
  activeEffort: null,
  activeParams: null,
};

const cursorWithRouter: CursorCatalog = {
  id: "cursor",
  label: "Cursor",
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
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      parameters: [
        {
          id: "fast",
          values: [{ value: "false" }, { value: "true" }],
        },
      ],
    },
  ],
};

const cursorWithoutRouter: CursorCatalog = {
  id: "cursor",
  label: "Cursor",
  models: [
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
    },
  ],
};

describe("validatePreferences", () => {
  test("rejects Claude model on Cursor provider", () => {
    expect(() =>
      validatePreferences(
        { activeProvider: "cursor", activeModel: "claude-sonnet-4-6" },
        emptyCurrent,
        { claude, cursor: cursorWithRouter },
      ),
    ).toThrow(INVALID_PROVIDER_MODEL("claude-sonnet-4-6", "cursor"));
  });

  test("rejects Cursor model on Claude provider", () => {
    expect(() =>
      validatePreferences(
        { activeProvider: "claude", activeModel: "composer-2.5" },
        emptyCurrent,
        { claude, cursor: cursorWithRouter },
      ),
    ).toThrow(INVALID_PROVIDER_MODEL("composer-2.5", "claude"));
  });

  test("accepts auto-smart + optimize_for=balanced when Router is in catalog", () => {
    const result = validatePreferences(
      {
        activeProvider: "cursor",
        activeModel: "auto-smart",
        activeParams: [{ id: "optimize_for", value: "balanced" }],
      },
      emptyCurrent,
      { claude, cursor: cursorWithRouter },
    );
    expect(result.activeProvider).toBe("cursor");
    expect(result.activeModel).toBe("auto-smart");
    expect(result.activeParams).toEqual([
      { id: "optimize_for", value: "balanced" },
    ]);
  });

  test("rejects optimize_for=default when catalog only lists cost/balanced/intelligence", () => {
    expect(() =>
      validatePreferences(
        {
          activeProvider: "cursor",
          activeModel: "auto-smart",
          activeParams: [{ id: "optimize_for", value: "default" }],
        },
        emptyCurrent,
        { claude, cursor: cursorWithRouter },
      ),
    ).toThrow(INVALID_PROVIDER_PARAM("optimize_for", "default", "auto-smart"));
  });

  test("rejects auto-smart when catalog has no Router", () => {
    expect(() =>
      validatePreferences(
        { activeProvider: "cursor", activeModel: "auto-smart" },
        emptyCurrent,
        { claude, cursor: cursorWithoutRouter },
      ),
    ).toThrow(INVALID_PROVIDER_MODEL("auto-smart", "cursor"));
  });
});

describe("defaultsForProvider", () => {
  test("cursor defaults are not a Claude model id", () => {
    const d = defaultsForProvider("cursor", {
      claude,
      cursor: cursorWithRouter,
    });
    expect(d.activeModel).not.toBe("claude-sonnet-4-6");
    expect(d.activeModel).toBe("auto-smart");
    expect(d.activeEffort).toBeNull();
  });
});
