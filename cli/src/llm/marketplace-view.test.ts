import { describe, expect, test } from "bun:test";
import {
  filterMarketplaceRows,
  formatMarketplaceList,
  mergeMarketplaceView,
} from "./marketplace-view";

describe("marketplace-view", () => {
  test("catalog only → 4 rows, oficial, not installed, nativeToolsContinue", () => {
    const view = mergeMarketplaceView({});
    expect(view.entries).toHaveLength(4);
    expect(view.entries.every((r) => r.origin === "oficial")).toBe(true);
    expect(view.entries.every((r) => r.installed === false)).toBe(true);
    expect(view.nativeToolsContinue).toBe(true);
  });

  test("installed github → installed true, origin still oficial", () => {
    const view = mergeMarketplaceView({
      installedMcp: [{ name: "github", layer: "project", path: ".mcp.json" }],
    });
    const github = view.entries.find((r) => r.name === "github");
    expect(github?.installed).toBe(true);
    expect(github?.origin).toBe("oficial");
  });

  test("installed echo → extra proyecto row project:echo", () => {
    const view = mergeMarketplaceView({
      installedMcp: [{ name: "echo", layer: "project", path: ".mcp.json" }],
    });
    const echo = view.entries.find((r) => r.id === "project:echo");
    expect(echo?.origin).toBe("proyecto");
  });

  test("installed commit skill → installed true", () => {
    const view = mergeMarketplaceView({
      installedSkills: [{ name: "commit", layer: "user", catalogId: "commit" }],
    });
    const commit = view.entries.find((r) => r.name === "commit");
    expect(commit?.installed).toBe(true);
  });

  test("installed acme user skill → origin usuario", () => {
    const view = mergeMarketplaceView({
      installedSkills: [{ name: "acme", layer: "user" }],
    });
    const acme = view.entries.find((r) => r.name === "acme");
    expect(acme?.origin).toBe("usuario");
  });

  test("installed pdf project skill → origin proyecto", () => {
    const view = mergeMarketplaceView({
      installedSkills: [{ name: "pdf", layer: "project" }],
    });
    const pdf = view.entries.find((r) => r.name === "pdf");
    expect(pdf?.origin).toBe("proyecto");
  });

  test("host chavez-git does not appear", () => {
    const view = mergeMarketplaceView({
      installedMcp: [{ name: "chavez-git", layer: "host", path: "" }],
    });
    expect(view.entries.some((r) => r.name === "chavez-git")).toBe(false);
  });

  test("filterMarketplaceRows git includes github not commit, length ≤ 10", () => {
    const view = mergeMarketplaceView({});
    const filtered = filterMarketplaceRows(view.entries, "git", 10);
    expect(filtered.some((r) => r.name === "github")).toBe(true);
    expect(filtered.some((r) => r.name === "commit")).toBe(false);
    expect(filtered.length).toBeLessThanOrEqual(10);
  });

  test("formatMarketplaceList includes header and oficial", () => {
    const view = mergeMarketplaceView({});
    const text = formatMarketplaceList(view);
    expect(text).toContain("kind  origin     installed  name");
    expect(text).toContain("oficial");
  });
});
