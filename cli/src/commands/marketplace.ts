import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { ChavezWsClient } from "../ws/client";
import { cwdPath } from "../workspace";
import {
  MARKETPLACE_ASK_PROMPT,
  MARKETPLACE_ASK_WAITING,
  MARKETPLACE_KIND_LAYER,
} from "../llm/marketplace-constants";
import { formatMarketplaceList } from "../llm/marketplace-view";
import type { MarketplaceView } from "../llm/marketplace-constants";
import { parseMarketplaceArgs } from "./marketplace-args";

function token(): string {
  const t = loadConfig().accessToken;
  if (!t) throw new Error("No hay sesión. Ejecuta: chavez login");
  return t;
}

export async function marketplaceCommand(
  args: string[],
  opts: { headless?: boolean } = {},
): Promise<void> {
  const parsed = parseMarketplaceArgs(args);
  if (parsed.action === "list") {
    const data = await apiFetch<MarketplaceView>("/marketplace", {}, token());
    if (parsed.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(formatMarketplaceList(data));
    return;
  }
  if (parsed.action === "install") {
    if (parsed.kind === "skill") {
      const res = await apiFetch(
        "/marketplace/install",
        {
          method: "POST",
          body: JSON.stringify({ kind: "skill", id: parsed.id }),
        },
        token(),
      );
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    await marketplaceMcpRpc("install", { kind: "mcp", id: parsed.id }, opts);
    return;
  }
  if (parsed.action === "uninstall") {
    if (parsed.kind === "skill") {
      const res = await apiFetch(
        "/marketplace/uninstall",
        {
          method: "POST",
          body: JSON.stringify({ kind: "skill", name: parsed.name }),
        },
        token(),
      );
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    await marketplaceMcpRpc(
      "uninstall",
      { kind: "mcp", name: parsed.name },
      opts,
    );
    return;
  }
}

async function marketplaceMcpRpc(
  op: "install" | "uninstall",
  metadata: Record<string, string>,
  opts: { headless?: boolean } = {},
): Promise<void> {
  const t = token();
  const client = new ChavezWsClient(t);
  await client.connect();
  const path = cwdPath();
  const bound = await client.bind(path, "client");
  if (!bound.ok) {
    client.close();
    throw new Error(bound.error || "bind failed");
  }
  const type =
    op === "install"
      ? "workspace.marketplace.install"
      : "workspace.marketplace.uninstall";
  const res = await client.request({ type, metadata });
  if (!res.ok) {
    client.close();
    throw new Error(res.error || "marketplace rpc failed");
  }
  const data = (res.data || {}) as {
    status?: string;
    askRequestId?: string;
    diff?: string;
    message?: string;
    error?: string;
  };
  if (data.status === "awaiting_approval") {
    if (!process.stdin.isTTY || opts.headless) {
      console.error(MARKETPLACE_ASK_WAITING);
      console.error(data.diff || "");
      client.close();
      process.exitCode = 2;
      return;
    }
    console.log(data.diff || "");
    console.log(MARKETPLACE_ASK_PROMPT);
    const answer = await readYesNo();
    const decide = answer
      ? "workspace.marketplace.approve"
      : "workspace.marketplace.deny";
    const done = await client.request({
      type: decide,
      metadata: { requestId: data.askRequestId },
    });
    client.close();
    if (!done.ok) throw new Error(done.error || "ya resuelto");
    console.log(JSON.stringify(done.data, null, 2));
    return;
  }
  client.close();
  console.log(JSON.stringify(data, null, 2));
}

async function readYesNo(): Promise<boolean> {
  const buf = new Uint8Array(8);
  const n = await Bun.stdin.read(buf);
  const s = new TextDecoder()
    .decode(buf.slice(0, n || 0))
    .trim()
    .toLowerCase();
  return s === "y" || s === "yes";
}

void MARKETPLACE_KIND_LAYER;
