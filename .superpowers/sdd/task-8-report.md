# Task 8 Report — Web marketplace

## Status
**Completado**

## Commit
`feat(web): marketplace catalog with origin and ask confirm for .mcp.json`

## Archivos

### Creados
- `web/src/lib/marketplace-display.ts` — helpers duplicados (keep-in-sync con CLI), sin catálogo
- `web/src/lib/marketplace-display.test.ts` — github oficial, echo proyecto, filter
- `web/src/components/MarketplacePanel.tsx` — tabla, filtro sin cap, install/uninstall, modal ask
- `web/src/pages/marketplace.astro` — layout + `MarketplacePanel client:load`

### Modificados
- `web/src/layouts/BaseLayout.astro` — enlace Marketplace junto a Skills
- `web/src/lib/hooks.ts` — `useMarketplace`, `useInstallSkill`, `useUninstallSkill`, tipos
- `web/src/lib/query-keys.ts` — `marketplace: ["marketplace"]`

### No modificados (no necesarios)
- `web/src/lib/ws-hooks.ts` — MCP RPC desde el panel con `useWs().request`
- `web/src/components/ChatDetailPanel.tsx` — `onPush` marketplace en `MarketplacePanel`
- `web/package.json` — `"test": "bun test"` ya existía

## Comportamiento

1. **Catálogo**: `GET /marketplace` + `workspace.marketplace.snapshot` vía WS cuando hay sesión.
2. **Origen**: badge `oficial` / `proyecto` / `usuario` con clases existentes.
3. **Skills**: POST `/marketplace/install|uninstall`; invalida marketplace + skills.
4. **MCP**: WS `workspace.marketplace.install|uninstall`; sin daemon → `NO_DAEMON_ERROR` tal cual (rojo).
5. **Ask**: modal con path `.mcp.json`, diff, Aprobar/Denegar; `onPush` `marketplace.install.ask`.
6. **Push**: `marketplace.changed` / `skills.updated` → invalida marketplace y refresca snapshot.
7. **Copy**: skills→cuenta, MCP→`.mcp.json`, API no ejecuta MCP.

## Verificación

```bash
cd web && bun test src/lib/marketplace-display.test.ts
```

Resultado: **3 pass, 0 fail**

## Concerns

- Snapshot WS requiere workspace bound (como TUI); sin bind solo se ve catálogo HTTP + error daemon si aplica.
- Usuario debe abrir/bind workspace desde `/workspaces` antes de instalar MCP de proyecto.
- Errores API/WS se muestran sin traducir (404/409/400/`ya resuelto`).
