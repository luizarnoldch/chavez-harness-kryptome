/**
 * Invariants auth: same account cookie+device-code, 401 vs 404, Bearer hub.
 * Requires API up: bun run scripts/e2e-invariants-auth.ts
 */
import { z } from "zod";
import {
  assert,
  deviceBearer,
  signUpEmail,
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
const EMAIL_A = `e2e-inv-a-${Date.now()}@chavez.dev`;
const EMAIL_B = `e2e-inv-b-${Date.now()}@chavez.dev`;

async function main() {
  console.log("1) sign-up A + /me cookie");
  const cookieA = await signUpEmail(API, EMAIL_A, "Invariants A");
  const meA = await fetch(`${API}/me`, { headers: { cookie: cookieA } });
  assert(meA.ok, `/me cookie A failed ${meA.status}`);
  const meAJson = (await meA.json()) as { user: { id: string; email: string } };
  assert(meAJson.user?.id, "missing user.id");
  assert(meAJson.user.email === EMAIL_A, "email mismatch");
  const userIdA = meAJson.user.id;

  console.log("2) device-code Bearer same user.id");
  const bearer = await deviceBearer(API, cookieA);
  const meBearer = await fetch(`${API}/me`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert(meBearer.ok, `/me bearer failed ${meBearer.status}`);
  const meBearerJson = (await meBearer.json()) as { user: { id: string } };
  assert(meBearerJson.user.id === userIdA, "cookie user.id !== bearer user.id");

  console.log("3) PUT credentials with Bearer + GET /providers");
  const put = await fetch(`${API}/providers/claude/credentials`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      authKind: "api_key",
      secret: "sk-ant-e2e-not-real",
    }),
  });
  assert(put.ok, `PUT credentials ${put.status} ${await put.text()}`);
  const list = await fetch(`${API}/providers`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert(list.ok, `GET /providers ${list.status}`);
  const listJson = (await list.json()) as {
    providers?: { claude?: { linked?: boolean } };
  };
  assert(listJson.providers?.claude?.linked === true, "claude should be linked");

  console.log("4) unauthenticated 401");
  for (const path of ["/me", "/providers", "/workspaces", "/connections"]) {
    const res = await fetch(`${API}${path}`);
    assert(res.status === 401, `${path} expected 401 got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert(body.error === "Unauthorized", `${path} body ${JSON.stringify(body)}`);
  }
  const wsUnauth = await fetch(`${API}/ws`);
  assert(wsUnauth.status === 401, `GET /ws expected 401 got ${wsUnauth.status}`);

  console.log("5) user B 404 on A's resources");
  const cookieB = await signUpEmail(API, EMAIL_B, "Invariants B");

  const created = await withWs(API, bearer, async (send) => {
    const bind = await send({
      type: "workspace.bind",
      path: `/tmp/chavez-inv-a-${Date.now()}`,
      clientKind: "daemon",
      hostname: "e2e-host",
    });
    assert(bind.ok, `bind failed ${bind.error}`);
    const workspace = (bind.data as { workspace?: { id: string; path: string } })
      ?.workspace;
    assert(workspace?.id, "no workspace id");
    const session = await send({ type: "session.create", title: "inv-a" });
    assert(session.ok, `session.create ${session.error}`);
    const sessionId = (session.data as { session: { id: string } }).session.id;
    const chat = await send({
      type: "chat.create",
      sessionId,
      title: "inv-chat",
    });
    assert(chat.ok, `chat.create ${chat.error}`);
    const chatId = (chat.data as { chat: { id: string } }).chat.id;
    return { workspaceId: workspace.id, path: workspace.path, chatId };
  });

  const sessionsB = await fetch(
    `${API}/workspaces/${created.workspaceId}/sessions`,
    { headers: { cookie: cookieB } },
  );
  assert(sessionsB.status === 404, `expected 404 got ${sessionsB.status}`);
  const sessionsBody = await sessionsB.text();
  assert(
    sessionsBody.includes("Workspace not found"),
    `404 body ${sessionsBody}`,
  );
  assert(!sessionsBody.includes(EMAIL_A), "404 leaked email of A");
  assert(!sessionsBody.includes(userIdA), "404 leaked userId of A");

  const chatB = await fetch(`${API}/chats/${created.chatId}`, {
    headers: { cookie: cookieB },
  });
  assert(chatB.status === 404, `chat expected 404 got ${chatB.status}`);
  const chatBody = (await chatB.json()) as { error?: string };
  assert(chatBody.error === "Chat not found", JSON.stringify(chatBody));

  console.log("6) GET /workspaces B does not list A's path");
  const listB = await fetch(`${API}/workspaces`, {
    headers: { cookie: cookieB },
  });
  assert(listB.ok, `GET /workspaces B ${listB.status}`);
  const listBJson = (await listB.json()) as {
    workspaces?: Array<{ path?: string }>;
  };
  const paths = (listBJson.workspaces ?? []).map((w) => w.path);
  assert(!paths.includes(created.path), `B listed A's path ${created.path}`);

  console.log("\nINVARIANTS AUTH PASS");
}

main().catch((err) => {
  console.error("INVARIANTS AUTH FAIL", err);
  process.exit(1);
});
