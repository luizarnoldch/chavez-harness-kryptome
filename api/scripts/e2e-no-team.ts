/**
 * Plan 33 — no org / no membership / cross-user vault isolation.
 * Run with API up: bun run scripts/e2e-no-team.ts
 */
import {
  CREDENTIALS_NOT_LINKED,
  FORBIDDEN_HTTP_PATHS,
  FORBIDDEN_STATUS,
  NOT_FOUND_CHAT,
  NOT_FOUND_SESSION,
  NOT_FOUND_WORKSPACE,
  SHARE_NOT_FOUND,
  SHARE_READONLY_BANNER,
  UNAUTHORIZED,
} from "../src/lib/no-team";

const API = process.env.CHAVEZ_API_URL || "http://localhost:25001";
const PASSWORD = "test-pass-12345";
const stamp = Date.now();

function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const joined = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (joined) return joined;
  const single = res.headers.get("set-cookie");
  if (!single) throw new Error("no Set-Cookie in response");
  return single.split(";")[0]!;
}

function bearerFromCookie(cookie: string): string {
  const part = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.toLowerCase().includes("session_token="));
  if (!part) throw new Error("no session_token in cookie");
  const raw = part.slice(part.indexOf("=") + 1);
  return decodeURIComponent(raw);
}

async function signUp(email: string, name: string) {
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: API },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  if (!res.ok) throw new Error(`sign-up ${email} ${res.status} ${await res.text()}`);
  const cookie = cookieFromResponse(res);
  const meRes = await fetch(`${API}/me`, { headers: { cookie } });
  if (!meRes.ok) throw new Error(`/me ${meRes.status}`);
  const me = (await meRes.json()) as {
    user: { id: string; email: string; name: string; role?: unknown; orgId?: unknown };
  };
  if (me.user.role !== undefined || me.user.orgId !== undefined) {
    throw new Error("/me leaked org role");
  }
  if (!me.user.id || me.user.email !== email) throw new Error("bad /me");
  return { cookie, bearer: bearerFromCookie(cookie), me: me.user };
}

async function json(
  path: string,
  init: RequestInit & { cookie?: string; bearer?: string } = {},
) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

type WsReply = { type: string; id: string; ok: boolean; data?: unknown; error?: string };

async function withWs<T>(
  bearer: string,
  fn: (rpc: (payload: Record<string, unknown>) => Promise<WsReply>) => Promise<T>,
): Promise<T> {
  const url = `${API.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(bearer)}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
  const pending = new Map<string, (v: WsReply) => void>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as WsReply & { push?: boolean };
    if (msg.push) return;
    const wait = pending.get(msg.id);
    if (wait) wait(msg);
  });
  const rpc = (payload: Record<string, unknown>) =>
    new Promise<WsReply>((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ ...payload, id }));
      setTimeout(() => reject(new Error(`rpc timeout ${payload.type}`)), 10_000);
    });
  try {
    return await fn(rpc);
  } finally {
    ws.close();
  }
}

function expectStatus(label: string, got: number, want: number) {
  if (got !== want) throw new Error(`${label}: status ${got} want ${want}`);
}

function expectError(label: string, data: unknown, error: string) {
  const body = data as { error?: string };
  if (!body || body.error !== error) {
    throw new Error(`${label}: body ${JSON.stringify(data)} want error=${error}`);
  }
  if (JSON.stringify(data).includes("userId")) {
    throw new Error(`${label}: 404 leaked userId`);
  }
}

async function main() {
  console.log("0) forbidden team routes are absent (404 not 401/403)");
  for (const path of FORBIDDEN_HTTP_PATHS) {
    const r = await json(path);
    if (r.status !== 404) {
      throw new Error(`${path} status ${r.status} — team route must not exist`);
    }
    if (r.status === FORBIDDEN_STATUS) {
      throw new Error(`${path} returned 403 — membership must not exist`);
    }
  }

  console.log("1) sign-up A and B");
  const A = await signUp(`e2e-nta-${stamp}@chavez.dev`, "NoTeam A");
  const B = await signUp(`e2e-ntb-${stamp}@chavez.dev`, "NoTeam B");
  if (A.me.id === B.me.id) throw new Error("A and B are the same user");

  const unauth = await json("/me");
  expectStatus("GET /me unauth", unauth.status, 401);
  expectError("GET /me unauth", unauth.data, UNAUTHORIZED);

  console.log("2) vault isolation (claude always; github if linked)");
  const putA = await json("/providers/claude/credentials", {
    method: "PUT",
    cookie: A.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "sk-ant-USER-A-SECRET" }),
  });
  expectStatus("PUT claude A", putA.status, 200);

  const putB = await json("/providers/claude/credentials", {
    method: "PUT",
    cookie: B.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "sk-ant-USER-B-SECRET" }),
  });
  expectStatus("PUT claude B", putB.status, 200);

  const credA = await json("/providers/claude/credentials", { cookie: A.cookie });
  const credBviaA = await json("/providers/claude/credentials", { cookie: B.cookie });
  const secretA = (credA.data as { secret?: string }).secret;
  const secretB = (credBviaA.data as { secret?: string }).secret;
  if (secretA !== "sk-ant-USER-A-SECRET") throw new Error("A vault mismatch");
  if (secretB !== "sk-ant-USER-B-SECRET") throw new Error("B vault mismatch");
  if (secretB === secretA) throw new Error("B received A's secret");

  const credAwithB = await json("/providers/claude/credentials", {
    bearer: B.bearer,
  });
  const s = (credAwithB.data as { secret?: string }).secret;
  if (s === "sk-ant-USER-A-SECRET") {
    throw new Error("Bearer B opened Claude vault of A");
  }

  const ghA = await json("/providers/github/credentials", {
    method: "PUT",
    cookie: A.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_USER_A_PAT_VALUE" }),
  });
  const ghB = await json("/providers/github/credentials", {
    method: "PUT",
    cookie: B.cookie,
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_USER_B_PAT_VALUE" }),
  });
  if (ghA.status === 200 && ghB.status === 200) {
    const gotB = await json("/providers/github/credentials", { bearer: B.bearer });
    const gotAwithB = (gotB.data as { secret?: string }).secret;
    if (gotAwithB === "ghp_USER_A_PAT_VALUE") {
      throw new Error("token of B opened GitHub PAT of A");
    }
    const gotA = await json("/providers/github/credentials", { cookie: A.cookie });
    if ((gotA.data as { secret?: string }).secret !== "ghp_USER_A_PAT_VALUE") {
      throw new Error("A github vault mismatch");
    }
  } else if (ghA.status === 404) {
    const err = (ghA.data as { error?: string }).error;
    if (err !== "Unknown provider" && err !== CREDENTIALS_NOT_LINKED) {
      throw new Error(`unexpected github PUT ${ghA.status} ${ghA.text}`);
    }
    console.log("   github provider not landed — Claude isolation still holds");
  } else {
    throw new Error(`github PUT A ${ghA.status} ${ghA.text}`);
  }

  console.log("3) workspaces are not shared for write");
  const pathA = `/tmp/chavez-no-team-a-${stamp}`;
  const pathB = `/tmp/chavez-no-team-b-${stamp}`;
  const createdA = await withWs(A.bearer, async (rpc) => {
    const bind = await rpc({ type: "workspace.bind", path: pathA, clientKind: "daemon" });
    if (!bind.ok) throw new Error(`bind A ${bind.error}`);
    const workspace = (bind.data as { workspace: { id: string; userId: string; path: string } }).workspace;
    if (workspace.userId && workspace.userId !== A.me.id) {
      throw new Error("workspace A userId mismatch");
    }
    const sess = await rpc({ type: "session.create", title: "S-A" });
    if (!sess.ok) throw new Error(`session A ${sess.error}`);
    const session = (sess.data as { session: { id: string } }).session;
    const chat = await rpc({
      type: "chat.create",
      sessionId: session.id,
      title: "C-A",
    });
    if (!chat.ok) throw new Error(`chat A ${chat.error}`);
    const chatRow = (chat.data as { chat: { id: string } }).chat;
    return { workspaceId: workspace.id, sessionId: session.id, chatId: chatRow.id };
  });

  const createdB = await withWs(B.bearer, async (rpc) => {
    const samePath = await rpc({
      type: "workspace.bind",
      path: pathA,
      clientKind: "client",
    });
    if (!samePath.ok) throw new Error(`bind B same path ${samePath.error}`);
    const wsBsame = (samePath.data as { workspace: { id: string } }).workspace;
    if (wsBsame.id === createdA.workspaceId) {
      throw new Error("B bound A's workspace row — shared write");
    }
    const bind = await rpc({ type: "workspace.bind", path: pathB, clientKind: "daemon" });
    if (!bind.ok) throw new Error(`bind B ${bind.error}`);
    return (bind.data as { workspace: { id: string } }).workspace.id;
  });
  if (createdB === createdA.workspaceId) throw new Error("A and B share workspace id");

  const listB = await json("/workspaces", { cookie: B.cookie });
  expectStatus("GET /workspaces B", listB.status, 200);
  const workspacesB = (listB.data as { workspaces: Array<{ id: string; path: string }> }).workspaces;
  if (workspacesB.some((w) => w.id === createdA.workspaceId)) {
    throw new Error("B listed A's workspace");
  }
  if (workspacesB.some((w) => w.path === pathA && w.id === createdA.workspaceId)) {
    throw new Error("B listed A's workspace path as shared");
  }

  const foreignWs = await json(`/workspaces/${createdA.workspaceId}/sessions`, {
    cookie: B.cookie,
  });
  expectStatus("B GET workspace A", foreignWs.status, 404);
  expectError("B GET workspace A", foreignWs.data, NOT_FOUND_WORKSPACE);
  if (foreignWs.status === FORBIDDEN_STATUS) throw new Error("got 403 — no membership");

  const foreignSess = await json(`/sessions/${createdA.sessionId}`, { cookie: B.cookie });
  expectStatus("B GET session A", foreignSess.status, 404);
  expectError("B GET session A", foreignSess.data, NOT_FOUND_SESSION);

  const foreignChat = await json(`/chats/${createdA.chatId}`, { cookie: B.cookie });
  expectStatus("B GET chat A", foreignChat.status, 404);
  expectError("B GET chat A", foreignChat.data, NOT_FOUND_CHAT);

  const connB = await json("/connections", { cookie: B.cookie });
  const conns = (connB.data as { connections: Array<{ workspaceId?: string }> }).connections ?? [];
  if (conns.some((c) => c.workspaceId === createdA.workspaceId)) {
    throw new Error("B listed A's daemon connection");
  }

  console.log("4) token of B does not run tools/PRs on A's chat");
  await withWs(B.bearer, async (rpc) => {
    const list = await rpc({ type: "chat.list", sessionId: createdA.sessionId });
    if (list.ok && Array.isArray((list.data as { chats?: unknown[] }).chats) && (list.data as { chats: unknown[] }).chats.length) {
      throw new Error("B listed A's chats");
    }
    if (list.ok) throw new Error("chat.list of foreign session must fail");
    if (list.error !== NOT_FOUND_SESSION) {
      throw new Error(`chat.list foreign: ${list.error}`);
    }
    const get = await rpc({ type: "chat.get", chatId: createdA.chatId });
    if (get.ok) throw new Error("B chat.get A's chat");
    if (get.error !== NOT_FOUND_CHAT) throw new Error(`chat.get foreign ${get.error}`);
    const tool = await rpc({
      type: "chat.tool.start",
      chatId: createdA.chatId,
      toolCallId: "tc-x",
      toolName: "bash",
    });
    if (tool.ok) throw new Error("B started a tool on A's chat");
    if (tool.error !== NOT_FOUND_CHAT) throw new Error(`tool.start foreign ${tool.error}`);
    const turn = await rpc({
      type: "agent.turn.request",
      chatId: createdA.chatId,
      prompt: "open a PR",
    });
    if (turn.ok) throw new Error("B dispatched a turn on A's chat");
    if (turn.error !== NOT_FOUND_CHAT) {
      throw new Error(`turn.request foreign ${turn.error}`);
    }
    const pr = await rpc({
      type: "workspace.git.pr",
      title: "should not open",
    });
    if (pr.ok) throw new Error("B opened a PR RPC without A's daemon/vault");
  });

  console.log("5) share link is not membership");
  const createShare = await json(`/chats/${createdA.chatId}/share`, {
    method: "POST",
    cookie: A.cookie,
  });
  if (createShare.status === 404) {
    const anon = await json(`/share/not-a-real-token`);
    if (anon.status !== 404) {
      throw new Error(`GET /share/missing status ${anon.status}`);
    }
    const asSession = await json("/me", { bearer: "not-a-real-token" });
    expectStatus("share token as Bearer", asSession.status, 401);
    expectError("share token as Bearer", asSession.data, UNAUTHORIZED);
    console.log("   share routes not landed — absent link is still not membership");
  } else if (createShare.status === 200 || createShare.status === 201) {
    const token = (createShare.data as { token?: string }).token;
    if (!token) throw new Error("share create missing token");
    const pub = await json(`/share/${token}`);
    expectStatus("GET share anon", pub.status, 200);
    const body = pub.data as {
      banner?: string;
      userId?: unknown;
      members?: unknown;
      secret?: unknown;
    };
    if (body.banner !== SHARE_READONLY_BANNER) {
      throw new Error("share banner mismatch");
    }
    if (body.userId || body.members || body.secret) {
      throw new Error("share payload looks like membership/vault");
    }
    if (pub.setCookie.length) throw new Error("share set a session cookie");
    const meWithShare = await json("/me", { bearer: token });
    expectStatus("share token is not a session", meWithShare.status, 401);
    const wsShare = await fetch(`${API}/ws?token=${encodeURIComponent(token)}`);
    if (wsShare.status !== 401) {
      throw new Error(`share token opened WS (${wsShare.status})`);
    }
    const bSeesChat = await json(`/chats/${createdA.chatId}`, { cookie: B.cookie });
    expectStatus("B still 404 after opening share", bSeesChat.status, 404);
    expectError("B still 404 after opening share", bSeesChat.data, NOT_FOUND_CHAT);
    const bVault = await json("/providers/claude/credentials", { cookie: B.cookie });
    if ((bVault.data as { secret?: string }).secret === "sk-ant-USER-A-SECRET") {
      throw new Error("opening share leaked A's vault to B");
    }
    const ask = await withWs(B.bearer, (rpc) =>
      rpc({
        type: "agent.turn.request",
        chatId: createdA.chatId,
        prompt: "hi",
      }),
    );
    if (ask.ok) throw new Error("B asked on A's chat via share");
    const missing = await json("/share/revoked-or-random");
    expectStatus("bad share token", missing.status, 404);
    expectError("bad share token", missing.data, SHARE_NOT_FOUND);
  } else if (createShare.status === 401) {
    throw new Error("owner could not POST share (unexpected 401)");
  } else {
    throw new Error(`POST share ${createShare.status} ${createShare.text}`);
  }

  console.log("\nNO-TEAM INVARIANT PASS");
}

main().catch((err) => {
  console.error("NO-TEAM INVARIANT FAIL", err);
  process.exit(1);
});
