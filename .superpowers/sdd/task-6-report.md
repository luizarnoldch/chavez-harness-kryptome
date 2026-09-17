# Task 6 Report — CLI marketplace list/install/uninstall

## Status
**Complete**

## Commit
```
feat(cli): marketplace list/install/uninstall without spawning MCP
```

## Files

| File | Action |
|------|--------|
| `cli/src/commands/marketplace.ts` | Created — `marketplaceCommand`, HTTP skills + WS MCP RPC |
| `cli/src/commands/marketplace-args.ts` | Created — `parseMarketplaceArgs`, `marketplaceUsage` |
| `cli/src/commands/marketplace-format.test.ts` | Created — parser + `formatMarketplaceList` tests |
| `cli/src/index.ts` | Modified — `case "marketplace"`, usage lines |
| `cli/src/commands/headless.ts` | Modified — `marketplace` group, watch integration |
| `cli/src/llm/watch-format-marketplace.ts` | Created — `formatMarketplaceWatchLine` |
| `cli/src/llm/watch-format-marketplace.test.ts` | Created — ask/changed line tests |

## Tests

```bash
cd cli && bun test src/commands/marketplace-format.test.ts \
  src/llm/watch-format-marketplace.test.ts
```

**Result:** 7 pass, 0 fail

## Behavior

- `chavez marketplace list [--json]` — GET `/marketplace`, human or JSON output
- `chavez marketplace install skill <id>` — POST `/marketplace/install`
- `chavez marketplace install mcp <id>` — WS `workspace.marketplace.install` via `ChavezWsClient` with `clientKind: "client"`
- `chavez marketplace uninstall skill|mcp` — HTTP skill or WS MCP uninstall
- Headless: same commands under `chavez headless marketplace …`; `{ headless: true }` skips TTY approval, prints `MARKETPLACE_ASK_WAITING`, exit code 2
- Watch: `marketplace.install.ask` and `marketplace.changed` formatted before generic JSON fallback

## Concerns

- `marketplace.changed` from MCP WS broadcasts `{ workspaceId, view }` without top-level `op`/`name`; watch formatter falls back to `view.name`, `view.message`, or `"changed"` — skill HTTP events with `{ op, name }` format cleanly
- Interactive CLI (`chavez marketplace install mcp …`) still prompts y/n on TTY; headless never does
- `watch-format.ts` not modified; separate `watch-format-marketplace.ts` per brief preference
