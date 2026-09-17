#!/usr/bin/env bun
/**
 * Long-lived WS keeper + agent runner for headless workspace open.
 * Usage: bun run src/ws/daemon.ts <absolutePath>
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { apiFetch } from "../api-client";
import { loadConfig } from "../config";
import { env } from "../lib/config";
import { ASK_APPROVAL_TIMEOUT_MS, parseExecutionMode } from "../llm/execution-mode";
import { loadOfficialCatalog } from "../llm/marketplace-catalog";
import {
  MARKETPLACE_ASK_WAITING,
  MARKETPLACE_DENIED,
  marketplaceInstalled,
  marketplaceUninstalled,
} from "../llm/marketplace-constants";
import { gateMarketplaceWrite } from "../llm/marketplace-gate";
import {
  applyPatch,
  planMcpInstall,
  planMcpUninstall,
} from "../llm/marketplace-fs";
import type { McpJsonPatch } from "../llm/marketplace-mcp-json";
import { mergeMarketplaceView } from "../llm/marketplace-view";
import { loadMcpFromDisk } from "../llm/mcp-load";
import { loadSkillsFromDisk } from "../llm/skills-load";
import { skillsMetadata } from "../llm/skills-merge";
import { completeWorkspace } from "../llm/fs-complete";
import { listWorkspaceDir } from "../llm/fs-tree";
import { searchWorkspace } from "../llm/fs-search";
import { previewFile } from "../llm/fs-preview";
import { runGitAction, type GitRpcAction } from "../llm/handle-git-rpc";
import { handleToolResolutionPush } from "../llm/handle-tool-resolution";
import { handleCompactDispatch } from "../llm/compact-dispatch";
import { publishAgentTurn } from "../llm/publish-turn";
import { handleUndoDispatch } from "../llm/run-undo";
import { abortAllTurns } from "../llm/turn-abort";
import { cancelSession, steerSession } from "../llm/turn-session";
import { STEER_KIND } from "../llm/steer";
import { TURN_BUSY_ERROR } from "../llm/undo-constants";
import { ChavezWsClient, type WsPushMessage } from "./client";
import { writeWorkspaceState, readWorkspaceState } from "../workspace";
import { ensureLocalRulesGitExcluded } from "../llm/rules-git-exclude";
import type { DispatchUserRule } from "../llm/rules-inject";
import {
  loadLocalRules,
  loadProjectRules,
  localMachineRulesPath,
  writeLocalMachineRules,
} from "../llm/rules-load";
import { toRuleRef } from "../llm/rules-merge";
import { workspaceHash } from "../workspace";
import {
  getEffectiveCwd,
  initEffectiveCwd,
} from "../llm/effective-cwd";
import { handleWorktreeRpc } from "../llm/handle-worktree-rpc";
import {
  DAEMON_STANDBY_NOTE,
  HEARTBEAT_INTERVAL_MS,
} from "./presence-constants";
import { createDaemonPty, handlePtyPush } from "../pty/daemon-handlers";

function log(line: string) {
  const file = env.server.wsDaemonLog;
  if (file) {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // ignore
    }
  }
  console.error(line);
}

const pathArg = process.argv[2];
if (!pathArg) {
  console.error("path required");
  process.exit(1);
}

const path = pathArg.replace(/\\/g, "/").replace(/\/+$/, "");
const config = loadConfig();
if (!config.accessToken) {
  console.error("Not logged in");
  process.exit(1);
}

const previous = readWorkspaceState(path);
initEffectiveCwd(path, previous?.cwd);

log(`starting path=${path}`);
const client = new ChavezWsClient(config.accessToken);
const daemonId = randomUUID();
let daemonRole: string | undefined;
let ourConnectionId: string | undefined;
let turnBusy = false;
let undoBusy = false;
let dispatchChain = Promise.resolve();

type MarketplaceAsk = {
  requestId: string;
  patch: McpJsonPatch;
  action: "install" | "uninstall";
  name: string;
  kind: "mcp";
  deadline: number;
  resolve: (v: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const marketplaceAsk = new Map<string, MarketplaceAsk>();

function settleAsk(requestId: string, value: unknown) {
  const a = marketplaceAsk.get(requestId);
  if (!a) return false;
  clearTimeout(a.timer);
  marketplaceAsk.delete(requestId);
  a.resolve(value);
  return true;
}

async function replyMarketplace(
  requestId: string | undefined,
  payload: Record<string, unknown>,
) {
  if (!requestId) return;
  await client.request({
    type: "workspace.marketplace.result",
    requestId,
    metadata: payload,
  });
}

client.enableAutoReconnect({
  path,
  clientKind: "daemon",
  hostname: hostname(),
  daemonId,
});

client.onClose(({ userInitiated }) => {
  if (userInitiated) return;
  abortAllTurns();
  turnBusy = false;
  log("socket dropped — in-flight turn interrupted, will reconnect");
});

client.onStatus((status) => {
  if (status === "bound") {
    log(`reconnected daemonId=${daemonId}`);
  }
});

client.onRebind((res) => {
  const data = (res.data || {}) as {
    role?: string;
    primaryConnectionId?: string;
  };
  if (typeof data.role === "string") daemonRole = data.role;
  if (typeof data.primaryConnectionId === "string") {
    ourConnectionId = data.primaryConnectionId;
  }
});

await client.connect();
log("connected");
const bound = await client.bind(path, "daemon", { daemonId });
if (!bound.ok) {
  log(`bind failed: ${bound.error}`);
  console.error(bound.error || "bind failed");
  process.exit(1);
}

const boundData = (bound.data || {}) as {
  workspace?: { id: string };
  role?: string;
  hostname?: string;
  primaryConnectionId?: string;
  daemonId?: string;
};
daemonRole = boundData.role;
ourConnectionId = boundData.primaryConnectionId;
const workspace = boundData.workspace;
writeWorkspaceState({
  path,
  pid: process.pid,
  openedAt: previous?.openedAt || new Date().toISOString(),
  workspaceId: workspace?.id,
  daemonId,
  cwd: getEffectiveCwd(),
});
log(
  `bound daemon workspaceId=${workspace?.id} pid=${process.pid} role=${boundData.role} hostname=${boundData.hostname} daemonId=${daemonId} cwd=${getEffectiveCwd()}`,
);
try {
  ensureLocalRulesGitExcluded(path);
} catch {
  // exclude is best-effort
}

if (boundData.role === "standby") {
  console.error(DAEMON_STANDBY_NOTE);
}

console.error(`workspace open daemon pid=${process.pid} path=${path}`);

const getCwd = () => getEffectiveCwd() || path;
const ptyManager = createDaemonPty({ client, getCwd });

client.onClose(() => {
  void ptyManager.killAll("daemon disconnected").catch((err) => {
    log(
      `PTY disconnect cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
});

client.onPush(async (msg: WsPushMessage) => {
  if (await handlePtyPush(ptyManager, client, msg, getCwd)) return;

  async function replyFs(
    type: "fs.tree.result" | "fs.search.result" | "fs.preview.result",
    requestId: string,
    metadata: Record<string, unknown>,
  ) {
    await client.request({
      type,
      requestId,
      hostname: hostname(),
      path,
      metadata,
    });
  }

  if (msg.type === "workspace.worktree.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      payload?: Record<string, unknown>;
    };
    const result = await handleWorktreeRpc({
      bindPath: path,
      action: String(data.action || "list"),
      payload: data.payload,
      turnBusy,
    });
    if (result.ok && result.snapshot) {
      const st = readWorkspaceState(path);
      writeWorkspaceState({
        path,
        pid: process.pid,
        openedAt: st?.openedAt || previous?.openedAt || new Date().toISOString(),
        workspaceId: workspace?.id,
        daemonId,
        cwd: result.snapshot.cwd,
      });
    }
    await client.request({
      type: "workspace.worktree.result",
      requestId: data.requestId,
      metadata: result as unknown as Record<string, unknown>,
      status: result.ok ? "done" : "error",
    });
    return;
  }

  const effectiveRoot = getEffectiveCwd() || path;

  if (msg.type === "fs.complete.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      query?: string;
      path?: string;
    };
    if (!data.requestId) return;
    // cwd = getEffectiveCwd()
    const candidates = completeWorkspace(effectiveRoot, data.query || "", 10);
    await client.request({
      type: "fs.complete.result",
      requestId: data.requestId,
      hostname: hostname(),
      path,
      metadata: { cwd: effectiveRoot, candidates },
    });
    return;
  }
  if (msg.type === "fs.tree.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      path?: string;
      workspacePath?: string;
    };
    if (!data.requestId) return;
    try {
      const tree = listWorkspaceDir(data.workspacePath || effectiveRoot, data.path || ".");
      await replyFs("fs.tree.result", data.requestId, {
        cwd: tree.cwd,
        path: tree.path,
        entries: tree.entries,
        truncated: tree.truncated,
      });
    } catch (err) {
      await replyFs("fs.tree.result", data.requestId, {
        cwd: effectiveRoot,
        path: data.path || ".",
        entries: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === "fs.search.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      query?: string;
      workspacePath?: string;
    };
    if (!data.requestId) return;
    try {
      const found = searchWorkspace(data.workspacePath || effectiveRoot, data.query || "");
      await replyFs("fs.search.result", data.requestId, {
        cwd: found.cwd,
        query: found.query,
        matches: found.matches,
        truncated: found.truncated,
      });
    } catch (err) {
      await replyFs("fs.search.result", data.requestId, {
        cwd: effectiveRoot,
        query: String(data.query || ""),
        matches: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === "fs.preview.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      path?: string;
      workspacePath?: string;
    };
    if (!data.requestId) return;
    try {
      const prev = previewFile(data.workspacePath || effectiveRoot, data.path || "");
      await replyFs("fs.preview.result", data.requestId, { ...prev });
    } catch (err) {
      await replyFs("fs.preview.result", data.requestId, {
        cwd: effectiveRoot,
        path: data.path || "",
        kind: "binary",
        status: "forbidden",
        byteSize: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (handleToolResolutionPush(msg)) {
    const data = (msg.data || {}) as { toolCallId?: string };
    log(`${msg.type} toolCallId=${data.toolCallId ?? "?"}`);
    return;
  }
  if (msg.type === "agent.turn.cancel") {
    const cancelData = (msg.data || {}) as { chatId?: string };
    const okCancel = cancelData.chatId
      ? cancelSession(cancelData.chatId)
      : false;
    log(`cancel chat=${cancelData.chatId} ok=${okCancel}`);
    return;
  }
  if (msg.type === "agent.turn.steer.dispatch") {
    const data = (msg.data || {}) as {
      chatId?: string;
      content?: string;
      requestId?: string;
    };
    if (!data.chatId || !data.requestId) return;
    try {
      const ack = await steerSession(data.chatId, data.content || "");
      await client.request({
        type: "chat.append",
        chatId: data.chatId,
        role: "user",
        content: ack.content,
        metadata: {
          kind: STEER_KIND,
          outcome: ack.outcome,
        },
      });
      await client.request({
        type: "agent.turn.steer.result",
        id: data.requestId,
        chatId: data.chatId,
        content: ack.content,
        status: ack.outcome,
        metadata: { outcome: ack.outcome, reason: ack.reason },
      });
    } catch (err) {
      await client.request({
        type: "agent.turn.steer.result",
        id: data.requestId,
        chatId: data.chatId,
        content: data.content,
        status: "error",
        metadata: {
          outcome: "revert_to_followup",
          reason: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return;
  }
  if (msg.type === "agent.turn.undo.dispatch") {
    if (turnBusy || undoBusy) {
      const data = (msg.data || {}) as { requestId?: string; chatId?: string };
      if (data.requestId) {
        await client.request({
          type: "agent.turn.undo.result",
          requestId: data.requestId,
          chatId: data.chatId,
          status: "error",
          metadata: { error: TURN_BUSY_ERROR, chatId: data.chatId },
        });
      }
      return;
    }
    undoBusy = true;
    try {
      await handleUndoDispatch({
        client,
        cwd: effectiveRoot,
        data: (msg.data || {}) as Parameters<typeof handleUndoDispatch>[0]["data"],
      });
    } finally {
      undoBusy = false;
    }
    return;
  }
  if (msg.type === "workspace.rules.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      payload?: { content?: string };
      workspaceId?: string;
    };
    const cwd = data.path || path;
    try {
      ensureLocalRulesGitExcluded(cwd);
      if (data.action === "local.set") {
        writeLocalMachineRules(cwd, String(data.payload?.content ?? ""));
      }
      const project = loadProjectRules(cwd).map(toRuleRef);
      const local = loadLocalRules(cwd).map(toRuleRef);
      const machine = localMachineRulesPath(cwd);
      let localContent = "";
      try {
        localContent = existsSync(machine) ? readFileSync(machine, "utf8") : "";
      } catch {
        localContent = "";
      }
      const snapshot = {
        project,
        local,
        localContent,
        localPath: `~/.chavez/workspaces/${workspaceHash(cwd)}/rules.local.md`,
      };
      await client.request({
        type: "workspace.rules.result",
        requestId: data.requestId,
        metadata: {
          requestId: data.requestId,
          snapshot,
        },
      });
    } catch (err) {
      await client.request({
        type: "workspace.rules.result",
        requestId: data.requestId,
        status: "error",
        metadata: {
          requestId: data.requestId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return;
  }
  if (msg.type === "workspace.git.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      payload?: Record<string, unknown>;
    };
    if (!data.requestId) return;
    const result = await runGitAction({
      cwd: effectiveRoot,
      action: data.action as GitRpcAction,
      payload: data.payload || {},
      getGitHubToken: async () => {
        try {
          const creds = await apiFetch<{ secret: string }>(
            "/providers/github/credentials",
            {},
            config.accessToken,
          );
          return creds.secret;
        } catch {
          return null;
        }
      },
    });
    await client.request({
      type: "workspace.git.result",
      requestId: data.requestId,
      metadata: result as unknown as Record<string, unknown>,
      status: result.ok ? "done" : "error",
    });
    return;
  }
  if (
    msg.type === "workspace.mcp.dispatch" ||
    msg.type === "workspace.skills.dispatch" ||
    msg.type === "workspace.ext.dispatch"
  ) {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      userSkills?: Array<{
        name: string;
        description: string;
        body: string;
        enabled: boolean;
      }>;
    };
    if (!data.requestId) return;
    const cwd = effectiveRoot;
    const isMcp =
      data.action === "mcp.snapshot" ||
      (data.action === "snapshot" && msg.type === "workspace.mcp.dispatch");
    const resultType =
      msg.type === "workspace.ext.dispatch"
        ? "workspace.ext.result"
        : isMcp
          ? "workspace.mcp.result"
          : "workspace.skills.result";
    try {
      const snapshot = isMcp
        ? (() => {
            const parsed = loadMcpFromDisk(cwd);
            return {
              servers: parsed.servers.map((server) => ({
                name: server.name,
                status: "pending",
                transport: server.config.transport,
                layer: server.layer,
              })),
              errors: parsed.errors,
              collisions: parsed.collisions,
              failed: parsed.errors.map((error) => error.path),
              nativeToolsContinue: true,
            };
          })()
        : skillsMetadata(
            loadSkillsFromDisk(cwd, data.userSkills ?? []),
          );
      await client.request({
        type: resultType,
        requestId: data.requestId,
        metadata: snapshot as Record<string, unknown>,
      });
    } catch (err) {
      await client.request({
        type: resultType,
        requestId: data.requestId,
        status: "error",
        metadata: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return;
  }
  if (msg.type === "workspace.marketplace.dispatch") {
    const data = (msg.data || {}) as {
      requestId?: string;
      action?: string;
      path?: string;
      payload?: Record<string, unknown>;
      executionMode?: "plan" | "auto" | "ask";
      userSkills?: Array<{
        name: string;
        description: string;
        body: string;
        enabled: boolean;
        catalogId?: string | null;
      }>;
    };
    const cwd = data.path || path;
    const requestId = data.requestId;
    try {
      if (data.action === "snapshot") {
        const catalog = loadOfficialCatalog();
        const mcp = loadMcpFromDisk(cwd);
        const skills = loadSkillsFromDisk(cwd, data.userSkills ?? []);
        const view = mergeMarketplaceView({
          catalog: catalog.entries,
          catalogErrors: catalog.errors,
          installedMcp: mcp.servers.map((s) => ({
            name: s.name,
            layer: s.layer,
            path: s.path,
          })),
          installedSkills: [
            ...skills.user.map((s) => ({ name: s.name, layer: "user" as const })),
            ...skills.project.map((s) => ({ name: s.name, layer: "project" as const })),
            ...skills.local.map((s) => ({ name: s.name, layer: "local" as const })),
          ],
        });
        await replyMarketplace(requestId, view as unknown as Record<string, unknown>);
        return;
      }

      if (data.action === "approve") {
        const id = String(data.payload?.requestId || "");
        const a = marketplaceAsk.get(id);
        if (!a) {
          await replyMarketplace(requestId, { error: "ya resuelto" });
          return;
        }
        applyPatch(cwd, a.patch);
        const name = a.name;
        const action = a.action;
        settleAsk(id, { ok: true });
        await replyMarketplace(requestId, {
          ok: true,
          status: "applied",
          message:
            action === "install"
              ? marketplaceInstalled("mcp", name)
              : marketplaceUninstalled("mcp", name),
        });
        return;
      }

      if (data.action === "deny") {
        const id = String(data.payload?.requestId || "");
        const a = marketplaceAsk.get(id);
        if (!a) {
          await replyMarketplace(requestId, { error: "ya resuelto" });
          return;
        }
        settleAsk(id, { ok: false, error: MARKETPLACE_DENIED });
        await replyMarketplace(requestId, { ok: false, error: MARKETPLACE_DENIED });
        return;
      }

      const mode =
        data.executionMode === "plan" ||
        data.executionMode === "auto" ||
        data.executionMode === "ask"
          ? data.executionMode
          : "ask";
      const gate = gateMarketplaceWrite(mode, true);
      const op = data.action === "uninstall" ? "uninstall" : "install";
      const patch =
        op === "install"
          ? planMcpInstall(cwd, String(data.payload?.id || ""))
          : planMcpUninstall(cwd, String(data.payload?.name || ""));
      if ("error" in patch) {
        await replyMarketplace(requestId, { error: patch.error });
        return;
      }
      if (patch.action === "noop") {
        await replyMarketplace(requestId, {
          ok: true,
          status: "installed",
          message: marketplaceInstalled(
            "mcp",
            String(data.payload?.id || data.payload?.name || ""),
          ),
        });
        return;
      }
      if (gate.decision === "deny") {
        await replyMarketplace(requestId, { error: gate.message });
        return;
      }
      if (gate.decision === "allow") {
        applyPatch(cwd, patch);
        await replyMarketplace(requestId, {
          ok: true,
          status: "applied",
          diff: patch.diff,
          message:
            op === "install"
              ? marketplaceInstalled("mcp", String(data.payload?.id))
              : marketplaceUninstalled("mcp", String(data.payload?.name)),
        });
        return;
      }

      const askId = randomUUID();
      const deadline = new Date(Date.now() + ASK_APPROVAL_TIMEOUT_MS).toISOString();
      log(MARKETPLACE_ASK_WAITING);
      const timer = setTimeout(() => {
        marketplaceAsk.delete(askId);
      }, ASK_APPROVAL_TIMEOUT_MS);
      marketplaceAsk.set(askId, {
        requestId: askId,
        patch,
        action: op,
        name: String(data.payload?.id || data.payload?.name || ""),
        kind: "mcp",
        deadline: Date.parse(deadline),
        resolve: () => {},
        timer,
      });
      await replyMarketplace(requestId, {
        status: "awaiting_approval",
        askRequestId: askId,
        kind: "mcp",
        action: op,
        name: String(data.payload?.id || data.payload?.name || ""),
        path: patch.path,
        diff: patch.diff,
        approvalDeadline: deadline,
        message: MARKETPLACE_ASK_WAITING,
      });
    } catch (err) {
      await replyMarketplace(requestId, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === "chat.compact.dispatch") {
    await handleCompactDispatch({
      client: client as never,
      data: (msg.data || {}) as {
        chatId?: string;
        requestId?: string;
        path?: string;
        trigger?: "manual" | "overflow";
      },
      cwd: effectiveRoot,
      token: config.accessToken,
      isBusy: () => turnBusy,
      setBusy: (v) => {
        turnBusy = v;
      },
    });
    return;
  }
  if (msg.type !== "agent.turn.dispatch") return;
  const data = (msg.data || {}) as {
    chatId?: string;
    prompt?: string;
    path?: string;
    planBrief?: string;
    executionMode?: string;
    metadata?: Record<string, unknown>;
    mentions?: string[];
    attachments?: unknown[];
    retryOfStreamId?: string;
    daemonConnectionId?: string;
    userRules?: DispatchUserRule[];
    userRulesEnabled?: boolean;
    userSkills?: Array<{
      name: string;
      description: string;
      body: string;
      enabled: boolean;
    }>;
    queueId?: string;
    skipUserAppend?: boolean;
    memories?: unknown[];
    workspaceId?: string;
    requesterConnectionId?: string;
    ci?: boolean;
    source?: string;
  };
  dispatchChain = dispatchChain
    .then(async () => {
      if (!data.chatId || !data.prompt) {
        log("dispatch missing chatId/prompt");
        return;
      }
      if (daemonRole === "standby") {
        log("standby — ignoring dispatch");
        return;
      }
      if (
        data.daemonConnectionId &&
        ourConnectionId &&
        data.daemonConnectionId !== ourConnectionId
      ) {
        log("dispatch for another daemon — ignoring");
        return;
      }
      if (turnBusy) {
        log("turn already running — rejecting dispatch");
        await client.request({
          type: "chat.stream.error",
          chatId: data.chatId,
          streamId: randomUUID(),
          content: TURN_BUSY_ERROR,
        });
        return;
      }
      turnBusy = true;
      log(`turn start chat=${data.chatId}`);
      try {
        await publishAgentTurn({
          client,
          chatId: data.chatId,
          prompt: data.prompt,
          cwd: getEffectiveCwd() || path,
          token: config.accessToken!,
          mentions: data.mentions,
          attachments: data.attachments,
          retryOfStreamId: data.retryOfStreamId,
          executionMode: parseExecutionMode(data.executionMode),
          metadata: data.metadata,
          planBrief: data.planBrief,
          userRules: data.userRules,
          userRulesEnabled: data.userRulesEnabled,
          userSkills: data.userSkills,
          skipUserAppend: Boolean(data.skipUserAppend),
          queueId: data.queueId,
          memories: data.memories as Parameters<
            typeof publishAgentTurn
          >[0]["memories"],
          workspaceId: data.workspaceId ?? workspace?.id ?? null,
          ptyManager,
          ptyAllowed: data.ci !== true && data.source !== "ci",
          ownerConnectionId: data.requesterConnectionId || "",
          ci: data.ci === true || data.source === "ci",
        });
        log(`turn ok chat=${data.chatId}`);
      } catch (err) {
        log(`turn fail: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        turnBusy = false;
      }
    })
    .catch((err) => {
      log(`dispatch chain: ${err instanceof Error ? err.message : String(err)}`);
    });
});

const shutdown = async () => {
  try {
    await ptyManager.killAll("daemon shutdown");
    ptyManager.stopSweeper();
  } catch {
    // still exit
  }
  try {
    client.close();
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {
  void client
    .request({ type: "daemon.heartbeat", daemonId })
    .then((res) => {
      if (res.ok && res.data && typeof res.data === "object") {
        const data = res.data as { role?: string };
        if (typeof data.role === "string") daemonRole = data.role;
      }
    })
    .catch((err) => {
      log(`heartbeat fail: ${err instanceof Error ? err.message : String(err)}`);
    });
}, HEARTBEAT_INTERVAL_MS);

await new Promise(() => {});
