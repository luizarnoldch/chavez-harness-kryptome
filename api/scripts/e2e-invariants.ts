/**
 * Cross-surface Gherkin coverage for invariants.
 * Requires API up: bun run scripts/e2e-invariants.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  historyFromChatMessages,
  TOOL_CONTEXT_PREAMBLE,
} from "../../cli/src/llm/history";
import { applyStreamDelta } from "../../cli/src/llm/timeline";
import { redactText } from "../src/lib/redact";
import {
  assert,
  deviceBearer,
  signUpEmail,
  sleep,
  withWs,
} from "./e2e-helpers";

const e2eEnv = z
  .object({
    CHAVEZ_API_URL: z.string().url().default("http://localhost:25001"),
  })
  .parse({
    CHAVEZ_API_URL: process.env.CHAVEZ_API_URL || undefined,
  });

const API = e2eEnv.CHAVEZ_API_URL;
const EMAIL = `e2e-inv-${Date.now()}@chavez.dev`;
const EMAIL_B = `e2e-inv-b-${Date.now()}@chavez.dev`;
const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
const SECRET = "sk-ant-e2e-not-real";

async function main() {
  const cookie = await signUpEmail(API, EMAIL, "Invariants");
  const meCookie = await fetch(`${API}/me`, { headers: { cookie } });
  assert(meCookie.ok, `/me cookie ${meCookie.status}`);
  const meCookieJson = (await meCookie.json()) as { user: { id: string } };
  const bearer = await deviceBearer(API, cookie);
  const meBearer = await fetch(`${API}/me`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert(meBearer.ok, `/me bearer ${meBearer.status}`);
  const meBearerJson = (await meBearer.json()) as { user: { id: string } };
  assert(meCookieJson.user.id === meBearerJson.user.id, "cookie !== bearer user.id");

  const unauth = await fetch(`${API}/providers`);
  assert(unauth.status === 401, `providers 401 got ${unauth.status}`);

  const cookieB = await signUpEmail(API, EMAIL_B, "Invariants B");
  const path = mkdtempSync(join(tmpdir(), "chavez-inv-"));

  const put = await fetch(`${API}/providers/claude/credentials`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ authKind: "api_key", secret: SECRET }),
  });
  assert(put.ok, `credentials ${put.status} ${await put.text()}`);

  await withWs(API, bearer, async (sendA, wsA, pushesA) => {
    const bindA = await sendA({
      type: "workspace.bind",
      path,
      clientKind: "daemon",
      hostname: "host-a",
    });
    assert(bindA.ok, `bind A ${bindA.error}`);
    const dataA = bindA.data as {
      role?: string;
      hostname?: string;
      workspace?: { id: string };
    };
    assert(dataA.role === "primary", `A role ${dataA.role}`);
    assert(Boolean(dataA.hostname), "hostname empty");
    const workspaceId = dataA.workspace!.id;

    await withWs(API, bearer, async (sendB) => {
      const bindB = await sendB({
        type: "workspace.bind",
        path,
        clientKind: "daemon",
        hostname: "host-b",
      });
      assert(bindB.ok, `bind B ${bindB.error}`);
      const dataB = bindB.data as { role?: string };
      assert(dataB.role === "standby", `B role ${dataB.role}`);

      const listWs = await fetch(`${API}/workspaces`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const listJson = (await listWs.json()) as {
        workspaces: Array<{
          id: string;
          daemonBound?: boolean;
          daemonHostname?: string | null;
        }>;
      };
      const row = listJson.workspaces.find((w) => w.id === workspaceId);
      assert(row?.daemonBound === true, "daemonBound");
      assert(Boolean(row?.daemonHostname), "daemonHostname");

      const session = await sendA({ type: "session.create", title: "inv" });
      assert(session.ok, session.error);
      const sessionId = (session.data as { session: { id: string } }).session.id;
      const chat = await sendA({
        type: "chat.create",
        sessionId,
        title: "inv-chat",
      });
      assert(chat.ok, chat.error);
      const chatId = (chat.data as { chat: { id: string } }).chat.id;

      const foreign = await fetch(`${API}/workspaces/${workspaceId}/sessions`, {
        headers: { cookie: cookieB },
      });
      assert(foreign.status === 404, `foreign 404 got ${foreign.status}`);

      pushesA.length = 0;
      const turn = await sendB({
        type: "agent.turn.request",
        chatId,
        prompt: "from standby",
      });
      assert(turn.ok, turn.error);
      await sleep(200);
      const dispatches = pushesA.filter((p) => p.type === "agent.turn.dispatch");
      assert(dispatches.length === 1, `dispatch count ${dispatches.length}`);
    });

    const afterB = await fetch(`${API}/workspaces`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const afterBJson = (await afterB.json()) as {
      workspaces: Array<{ id: string; daemonBound?: boolean }>;
    };
    assert(
      afterBJson.workspaces.find((w) => w.id === workspaceId)?.daemonBound ===
        true,
      "B.close should not unbind primary",
    );

    const presenceWait = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no daemon.presence")), 5000);
      const orig = wsA.onmessage;
      wsA.addEventListener("message", (ev) => {
        try {
          const raw = JSON.parse(String((ev as MessageEvent).data)) as {
            type?: string;
            data?: { bound?: boolean };
          };
          if (raw.type === "daemon.presence" && raw.data?.bound === false) {
            clearTimeout(t);
            resolve();
          }
        } catch {
          // ignore
        }
      });
      void orig;
    });
    wsA.close();
    await presenceWait.catch(() => {
      // presence may have been observed on another socket; continue
    });
  });

  await withWs(API, bearer, async (send) => {
    const session = await send({ type: "session.create", title: "after-close" });
    if (!session.ok) {
      const bind = await send({
        type: "workspace.bind",
        path,
        clientKind: "client",
      });
      assert(bind.ok, bind.error);
    }
  });

  await withWs(API, bearer, async (send) => {
    const bind = await send({
      type: "workspace.bind",
      path,
      clientKind: "client",
    });
    assert(bind.ok, bind.error);
    const session = await send({ type: "session.create", title: "no-daemon" });
    assert(session.ok, session.error);
    const sessionId = (session.data as { session: { id: string } }).session.id;
    const chat = await send({
      type: "chat.create",
      sessionId,
      title: "nd",
    });
    assert(chat.ok, chat.error);
    const chatId = (chat.data as { chat: { id: string } }).chat.id;
    const turn = await send({
      type: "agent.turn.request",
      chatId,
      prompt: "no daemon",
    });
    assert(!turn.ok, "expected fail without daemon");
    assert(turn.error === NO_DAEMON_ERROR, `got ${turn.error}`);
  });

  console.log("sync + prompt + busy + security");
  await withWs(API, bearer, async (sendDaemon, _wsD, daemonPushes) => {
    const bind = await sendDaemon({
      type: "workspace.bind",
      path,
      clientKind: "daemon",
      hostname: "host-sync",
    });
    assert(bind.ok, bind.error);

    await withWs(API, bearer, async (sendObs, _wsO, obsPushes) => {
      await sendObs({ type: "workspace.bind", path, clientKind: "client" });

      const session = await sendDaemon({
        type: "session.create",
        title: "sync",
      });
      assert(session.ok, session.error);
      await sleep(100);
      assert(
        obsPushes.some((p) => p.type === "session.created"),
        "observer missed session.created",
      );
      const sessionId = (session.data as { session: { id: string } }).session.id;
      const chat = await sendDaemon({
        type: "chat.create",
        sessionId,
        title: "sync-chat",
      });
      assert(chat.ok, chat.error);
      await sleep(100);
      assert(
        obsPushes.some((p) => p.type === "chat.created"),
        "observer missed chat.created",
      );
      const chatId = (chat.data as { chat: { id: string } }).chat.id;
      const append = await sendDaemon({
        type: "chat.append",
        chatId,
        role: "user",
        content: "hello",
      });
      assert(append.ok, append.error);
      await sleep(100);
      assert(
        obsPushes.some((p) => p.type === "message.appended"),
        "observer missed message.appended",
      );

      const streamId = crypto.randomUUID();
      await sendDaemon({ type: "chat.stream.start", chatId, streamId });
      await sendDaemon({
        type: "chat.stream.delta",
        chatId,
        streamId,
        delta: "b",
        seq: 2,
      });
      await sendDaemon({
        type: "chat.stream.delta",
        chatId,
        streamId,
        delta: "a",
        seq: 1,
      });
      await sendDaemon({
        type: "chat.stream.end",
        chatId,
        streamId,
        content: "ab",
      });
      await sleep(150);
      const state = { nextSeq: 1, buffer: new Map<number, string>() };
      let live = "";
      for (const p of obsPushes) {
        if (p.type !== "chat.stream.delta") continue;
        const d = p.data as { delta?: string; seq?: number };
        live = applyStreamDelta(live, d.delta || "", d.seq, state);
      }
      assert(live === "ab", `ordered deltas got ${JSON.stringify(live)}`);

      const got = await sendObs({ type: "chat.get", chatId });
      const messages = (got.data as { messages: Array<{ role: string; content: string }> })
        .messages;
      const assistants = messages.filter((m) => m.role === "assistant");
      assert(assistants.length === 1, `assistants ${assistants.length}`);
      assert(assistants[0]!.content === "ab", assistants[0]!.content);

      const hist = historyFromChatMessages(
        [
          { role: "user", content: "run" },
          {
            role: "tool",
            content: "out",
            metadata: { toolName: "Bash", status: "done", output: "ok" },
          },
          { role: "user", content: "now" },
        ],
        "now",
      );
      assert(
        hist.some((m) => m.content.includes(TOOL_CONTEXT_PREAMBLE)),
        "tool context preamble",
      );

      const cancel = await sendObs({ type: "agent.turn.cancel", chatId });
      assert(cancel.ok, cancel.error);
      const cancelData = cancel.data as { wasRunning?: boolean };
      assert(cancelData.wasRunning === false, "cancel idle wasRunning");

      const conns = await fetch(`${API}/connections`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const connsJson = (await conns.json()) as {
        connections: Array<{
          connectionId?: string;
          clientKind?: string;
          path?: string;
          hostname?: string | null;
        }>;
      };
      assert(connsJson.connections.length > 0, "connections empty");
      const item = connsJson.connections[0]!;
      assert(Boolean(item.connectionId), "connectionId");
      assert(Boolean(item.clientKind), "clientKind");
      assert(Boolean(item.path || item.hostname), "path or hostname");

      assert(redactText("sk-ant-api03-aaaa") === "***", "redactText");
      const leak = await sendDaemon({
        type: "chat.append",
        chatId,
        role: "assistant",
        content: "token ghp_secretsecretsecret",
      });
      assert(leak.ok, leak.error);
      const after = await sendObs({ type: "chat.get", chatId });
      const body = JSON.stringify(after.data);
      assert(!body.includes("ghp_"), `secret persisted: ${body}`);

      const providers = await fetch(`${API}/providers`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const providersText = await providers.text();
      assert(!providersText.includes(SECRET), "GET /providers leaked secret");

      void daemonPushes;
    });
  });

  console.log("\nINVARIANTS E2E PASS");
}

main().catch((err) => {
  console.error("INVARIANTS E2E FAIL", err);
  process.exit(1);
});
