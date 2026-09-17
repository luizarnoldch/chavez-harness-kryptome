import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOfficialCatalog,
  lookupOfficial,
  validateMarketplaceEntry,
} from "./marketplace-catalog";
import { mergeMarketplaceView, formatMarketplaceList } from "./marketplace-view";
import { gateMarketplaceWrite } from "./marketplace-gate";
import {
  applyPatch,
  planMcpInstall,
  planMcpUninstall,
} from "./marketplace-fs";
import { loadMcpFromDisk } from "./mcp-load";
import { userSkillToSource } from "./skills-parse";
import { mergeSkillLayers, formatSkillsPrompt } from "./skills-merge";
import { DEFAULT_CLAUDE_TOOLS } from "./tool-names";
import { HOST_MCP_NAMES } from "./mcp-constants";
import {
  MARKETPLACE_FILE,
  MARKETPLACE_PLAN_DENIED,
  marketplaceHostProtected,
  marketplaceMcpJsonIllegible,
  marketplaceNotFound,
} from "./marketplace-constants";

describe("Gherkin: Listar marketplace", () => {
  test("mergeMarketplaceView + formatMarketplaceList", () => {
    const view = mergeMarketplaceView({
      catalog: loadOfficialCatalog().entries,
      installedMcp: [{ name: "echo", layer: "project", path: ".mcp.json" }],
    });

    const oficial = view.entries.filter((r) => r.origin === "oficial");
    expect(oficial.some((r) => r.name === "github")).toBe(true);
    expect(oficial.some((r) => r.name === "sequential-thinking")).toBe(true);
    expect(oficial.some((r) => r.name === "commit")).toBe(true);
    expect(oficial.some((r) => r.name === "pr-review")).toBe(true);

    const echo = view.entries.find((r) => r.name === "echo");
    expect(echo?.origin).toBe("proyecto");

    const list = formatMarketplaceList(view);
    expect(list).toContain("oficial");
    expect(list).toContain("proyecto");
  });
});

describe("Gherkin: Instalar skill de usuario", () => {
  test("commit skill → user layer → merge → prompt", () => {
    const found = lookupOfficial("commit");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entry.kind).toBe("skill");
    expect(found.entry.body).toContain("# Commit");

    const source = userSkillToSource({
      name: "commit",
      description: found.entry.description,
      body: found.entry.body!,
      enabled: true,
    });
    expect(source.layer).toBe("user");

    const bundle = mergeSkillLayers({
      user: [source],
      project: [],
      local: [],
    });
    expect(bundle.applied.some((s) => s.name === "commit")).toBe(true);

    const prompt = formatSkillsPrompt(bundle);
    expect(prompt).toContain("commit");
  });
});

describe("Gherkin: Instalar MCP de proyecto", () => {
  test("gate + planMcpInstall + loadMcpFromDisk", () => {
    expect(gateMarketplaceWrite("ask", true).decision).toBe("ask");
    expect(gateMarketplaceWrite("auto", true).decision).toBe("allow");
    expect(gateMarketplaceWrite("plan", true).message).toBe(
      MARKETPLACE_PLAN_DENIED,
    );

    const tmp = mkdtempSync(join(tmpdir(), "gherkin-mcp-install-"));
    const patch = planMcpInstall(tmp, "github");
    expect("error" in patch).toBe(false);
    if ("error" in patch) return;
    applyPatch(tmp, patch);

    const raw = readFileSync(join(tmp, MARKETPLACE_FILE), "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { command?: string }>;
    };
    expect(parsed.mcpServers.github?.command).toBe("npx");

    const mcp = loadMcpFromDisk(tmp);
    const github = mcp.servers.find((s) => s.name === "github");
    expect(github?.layer).toBe("project");
  });

  test("marketplace-fs.ts does not import child_process", () => {
    const src = readFileSync(
      join(import.meta.dir, "marketplace-fs.ts"),
      "utf8",
    );
    expect(src.includes("child_process")).toBe(false);
  });
});

describe("Gherkin: Desinstalar MCP de proyecto", () => {
  test("uninstall github; host protected; nativas intactas", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gherkin-mcp-uninstall-"));
    const install = planMcpInstall(tmp, "github");
    if ("error" in install) throw new Error(install.error);
    applyPatch(tmp, install);

    const uninstall = planMcpUninstall(tmp, "github");
    if ("error" in uninstall) throw new Error(uninstall.error);
    applyPatch(tmp, uninstall);

    const mcp = loadMcpFromDisk(tmp);
    expect(mcp.servers.some((s) => s.name === "github")).toBe(false);

    const hostErr = planMcpUninstall(tmp, "chavez-git");
    expect(hostErr).toEqual({
      error: marketplaceHostProtected("chavez-git"),
    });

    expect(HOST_MCP_NAMES).toContain("chavez-git");
    expect(HOST_MCP_NAMES).toContain("chavez-skills");

    void import("./marketplace-fs");
    expect(DEFAULT_CLAUDE_TOOLS).toEqual([
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Bash",
    ]);
  });
});

describe("Gherkin: .mcp.json ilegible", () => {
  test("planMcpInstall on corrupt file → visible error, no patch", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gherkin-mcp-json-"));
    writeFileSync(join(tmp, MARKETPLACE_FILE), "NOT_JSON{{{", "utf8");
    const patch = planMcpInstall(tmp, "github");
    expect("error" in patch).toBe(true);
    if (!("error" in patch)) return;
    expect(patch.error).toContain(".mcp.json is illegible");
    expect(patch.error.startsWith(marketplaceMcpJsonIllegible())).toBe(true);
  });
});

describe("Gherkin: Fallo de origen", () => {
  test("lookup, validate, API route sin runtime", () => {
    const missing = lookupOfficial("nope");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toBe(marketplaceNotFound("nope"));

    const github = lookupOfficial("github");
    expect(github.ok).toBe(true);
    if (!github.ok) return;
    const invalid = validateMarketplaceEntry({
      ...github.entry,
      recipe: { transport: "stdio", requiredEnv: [] },
    });
    expect(invalid).not.toBeNull();
    expect(invalid).toContain("command");

    const apiRoute = readFileSync(
      join(import.meta.dir, "../../../api/src/routes/marketplace.ts"),
      "utf8",
    );
    expect(apiRoute.includes("child_process")).toBe(false);
    expect(apiRoute.includes("createSdkMcpServer")).toBe(false);

    const fsSrc = readFileSync(
      join(import.meta.dir, "marketplace-fs.ts"),
      "utf8",
    );
    expect(fsSrc.includes("child_process")).toBe(false);
  });
});
