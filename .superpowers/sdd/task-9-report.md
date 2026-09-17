# Task 9 Report — Smoke Gherkin marketplace

## Status
**Completado**

## Commit
```
f8f0ebd test(marketplace): gherkin list/install/uninstall/origin without API runtime
```

## Archivos

| Archivo | Acción |
|---------|--------|
| `cli/src/llm/gherkin-marketplace.test.ts` | Creado — 5 `describe` (listar, skill usuario, MCP proyecto, desinstalar, fallo origen) |
| `cli/scripts/marketplace-smoke.ts` | Creado — install/uninstall github en tmp, verifica nativas |
| `cli/package.json` | Modificado — `"test:marketplace-smoke"` |

## Escenarios Gherkin

1. **Listar** — `mergeMarketplaceView` con catálogo oficial + echo proyecto; filas oficial (github, sequential-thinking, commit, pr-review); `formatMarketplaceList` incluye `oficial` y `proyecto`.
2. **Instalar skill de usuario** — `lookupOfficial("commit")` kind skill, body `# Commit`; `userSkillToSource` → layer `user`; `mergeSkillLayers` + `formatSkillsPrompt` menciona `commit`.
3. **Instalar MCP de proyecto** — gates ask/auto/plan; `planMcpInstall` + `applyPatch` → `.mcp.json` command `npx`; `loadMcpFromDisk` github layer project; sin `child_process`.
4. **Desinstalar** — uninstall github; `planMcpUninstall("chavez-git")` host protected; `HOST_MCP_NAMES` intacto; `DEFAULT_CLAUDE_TOOLS` 6 nativas sin mutación.
5. **Fallo de origen** — `lookupOfficial("nope")` error exacto; `validateMarketplaceEntry` sin command ≠ null; API route sin `child_process`/`createSdkMcpServer`.

## Verificación — evidencia completa

### CLI

```bash
cd cli && bun test src/llm/gherkin-marketplace.test.ts \
  src/llm/marketplace-catalog.test.ts src/llm/marketplace-view.test.ts \
  src/llm/marketplace-mcp-json.test.ts src/llm/marketplace-gate.test.ts \
  src/llm/marketplace-fs.test.ts
```

```
bun test v1.3.14-canary.1 (0d9b296a)

src/llm/marketplace-catalog.test.ts:
(pass) marketplace-catalog > loadOfficialCatalog has exactly 4 ids [0.24ms]
(pass) marketplace-catalog > lookupOfficial github ok with npx command [0.09ms]
(pass) marketplace-catalog > lookupOfficial nope returns exact error [0.03ms]
(pass) marketplace-catalog > validateMarketplaceEntry mcp without command or url returns reason [0.02ms]
(pass) marketplace-catalog > recipesEqual true for github copies, false when args change [1.70ms]

src/llm/marketplace-view.test.ts:
(pass) marketplace-view > catalog only → 4 rows, oficial, not installed, nativeToolsContinue [0.33ms]
(pass) marketplace-view > installed github → installed true, origin still oficial [0.07ms]
(pass) marketplace-view > installed echo → extra proyecto row project:echo [0.04ms]
(pass) marketplace-view > installed commit skill → installed true [0.04ms]
(pass) marketplace-view > installed acme user skill → origin usuario [0.15ms]
(pass) marketplace-view > installed pdf project skill → origin proyecto [0.09ms]
(pass) marketplace-view > host chavez-git does not appear [0.06ms]
(pass) marketplace-view > filterMarketplaceRows git includes github not commit, length ≤ 10 [0.12ms]
(pass) marketplace-view > formatMarketplaceList includes header and oficial [0.07ms]

src/llm/marketplace-mcp-json.test.ts:
(pass) marketplace-mcp-json > install github on empty → upsert, npx command, diff contains github [0.22ms]
(pass) marketplace-mcp-json > reinstall → noop, empty diff [0.04ms]
(pass) marketplace-mcp-json > uninstall key only in .mcp.json → remove, key absent [0.09ms]
(pass) marketplace-mcp-json > uninstall with presentInOtherProjectFiles → disable, key kept if in file [0.06ms]
(pass) marketplace-mcp-json > uninstall elsewhere only → disable, empty mcpServers, disabledServers has name [0.04ms]
(pass) marketplace-mcp-json > uninstall chavez-git → host protected error [0.02ms]
(pass) marketplace-mcp-json > serializeMcpJson ends with newline, omits empty disabledServers [0.02ms]

src/llm/marketplace-gate.test.ts:
(pass) marketplace-gate > plan + userRequested → deny with MARKETPLACE_PLAN_DENIED [0.03ms]
(pass) marketplace-gate > ask → ask
(pass) marketplace-gate > auto + userRequested → allow
(pass) marketplace-gate > auto + not userRequested → deny MARKETPLACE_DENIED [0.01ms]

src/llm/marketplace-fs.test.ts:
(pass) marketplace-fs > planMcpInstall on empty dir → upsert github with npx command [0.59ms]
(pass) marketplace-fs > marketplace-fs.ts does not import child_process [0.04ms]
(pass) marketplace-fs > planMcpInstall unknown id → not found [0.04ms]
(pass) marketplace-fs > planMcpInstall skill id → not found [0.02ms]
(pass) marketplace-fs > install then uninstall github → key removed from .mcp.json [0.94ms]
(pass) marketplace-fs > uninstall echo elsewhere → disable in .mcp.json, settings.json intact [0.21ms]
(pass) marketplace-fs > assertRecipeMatchesCatalog mismatch → MARKETPLACE_RECIPE_MISMATCH [0.04ms]
(pass) marketplace-fs > planMcpUninstall chavez-git → host protected [0.06ms]

src/llm/gherkin-marketplace.test.ts:
(pass) Gherkin: Listar marketplace > mergeMarketplaceView + formatMarketplaceList [0.10ms]
(pass) Gherkin: Instalar skill de usuario > commit skill → user layer → merge → prompt [0.69ms]
(pass) Gherkin: Instalar MCP de proyecto > gate + planMcpInstall + loadMcpFromDisk [0.22ms]
(pass) Gherkin: Instalar MCP de proyecto > marketplace-fs.ts does not import child_process [0.04ms]
(pass) Gherkin: Desinstalar MCP de proyecto > uninstall github; host protected; nativas intactas [0.28ms]
(pass) Gherkin: Fallo de origen > lookup, validate, API route sin runtime [0.10ms]

 39 pass
 0 fail
 94 expect() calls
Ran 39 tests across 6 files. [31.00ms]
```

**Resultado CLI: 39 pass, 0 fail**

### API

```bash
cd api && bun test src/llm/marketplace-no-runtime.test.ts \
  src/llm/marketplace-catalog.test.ts
```

```
bun test v1.3.14-canary.1 (0d9b296a)

src/llm/marketplace-catalog.test.ts:
(pass) marketplace-catalog > loadOfficialCatalog has exactly 4 ids [0.26ms]
(pass) marketplace-catalog > lookupOfficial nope returns exact error [0.09ms]

src/llm/marketplace-no-runtime.test.ts:
(pass) API marketplace has no runtime > does not spawn: src/routes/marketplace.ts [0.10ms]
(pass) API marketplace has no runtime > does not spawn: src/llm/marketplace-catalog.ts [0.04ms]
(pass) API marketplace has no runtime > does not spawn: src/llm/marketplace-constants.ts [0.02ms]
(pass) API marketplace has no runtime > does not spawn: src/llm/marketplace-view.ts [0.02ms]
(pass) API marketplace has no runtime > route does not mention npx [0.04ms]
(pass) API marketplace has no runtime > handlers do not import claude-agent-sdk for marketplace [0.16ms]

 8 pass
 0 fail
 14 expect() calls
Ran 8 tests across 2 files. [15.00ms]
```

**Resultado API: 8 pass, 0 fail**

### Web

```bash
cd web && bun test src/lib/marketplace-display.test.ts
```

```
bun test v1.3.14-canary.1 (0d9b296a)

src/lib/marketplace-display.test.ts:
(pass) marketplace-display > github oficial no instalado [0.08ms]
(pass) marketplace-display > echo proyecto instalado [0.02ms]
(pass) marketplace-display > filter git includes github not commit [0.15ms]

 3 pass
 0 fail
 5 expect() calls
Ran 3 tests across 1 file. [8.00ms]
```

**Resultado Web: 3 pass, 0 fail**

### Smoke script

```bash
cd cli && bun run scripts/marketplace-smoke.ts
```

```
MCP servers: github
marketplace-smoke ok /tmp/marketplace-smoke-Wut5cN
```

Exit code: 0

## Resumen total

| Suite | Pass | Fail |
|-------|------|------|
| CLI (6 archivos) | 39 | 0 |
| API (2 archivos) | 8 | 0 |
| Web (1 archivo) | 3 | 0 |
| **Total** | **50** | **0** |

## Concerns

- Ninguno. Los cinco escenarios Gherkin pasan; API sin runtime confirmado; nativas `DEFAULT_CLAUDE_TOOLS` intactas tras importar `marketplace-fs`; smoke no spawnea procesos.

---

## Final review fixes (2026-09-17)

Commit: `6ea3f8f` — `fix(mcp-skills-marketplace): harden json errors, bind, list merge, recipe check`

| Finding | Fix |
|---------|-----|
| Invalid `.mcp.json` swallowed | `readProjectMcpJson` → `{ error: marketplaceMcpJsonIllegible(...) }`; plan* propagate |
| Web no bind | `MarketplacePanel`: workspace select + `ensureBound()` before MCP RPCs |
| CLI list no merge | `mergeMarketplaceListView()` after GET; NO_DAEMON_ERROR in errors when no daemon |
| Install no recipe check | Daemon `assertRecipeMatchesCatalog` before plan; `recipesEqual` includes `requiredEnv` |
| Approve stale overwrite | Approve re-reads file; `mcpJsonFilesEqual` vs `patch.previous` → `MARKETPLACE_MCP_JSON_CHANGED` |

### Re-run tests (all pass)

- CLI: 29 pass (marketplace-fs, catalog, gherkin, format)
- API: 8 pass
- Web: 3 pass
- TUI: 5 pass

See also `.superpowers/sdd/final-fix-report.md`.
