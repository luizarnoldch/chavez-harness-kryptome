#!/usr/bin/env bun
/**
 * E2E HTTP memory CRUD + scope isolation.
 * Cap 50 cubierto en memory-constants.test / parse — aquí insertamos 2.
 * Requires API + DB: bun run scripts/e2e-memory.ts
 */
import {
  assert,
  deviceBearer,
  signUpEmail,
  withWs,
} from "./e2e-helpers";

const API = process.env.CHAVEZ_API_URL || "http://localhost:25001";
const bunFact = "el paquete de tests es bun";

async function json(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("Origin", API);
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function bindWorkspace(
  bearer: string,
  path: string,
): Promise<string> {
  return withWs(API, bearer, async (send) => {
    const bind = await send({
      type: "workspace.bind",
      path,
      clientKind: "daemon",
      hostname: "e2e-memory",
    });
    assert(bind.ok, `bind ${path} ${bind.error}`);
    const workspace = (bind.data as { workspace?: { id: string } })?.workspace;
    assert(workspace?.id, "no workspace id");
    return workspace.id;
  });
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`API not up at ${API} (health failed)`);
  }

  const emailA = `e2e-mem-a-${Date.now()}@chavez.dev`;
  const emailB = `e2e-mem-b-${Date.now()}@chavez.dev`;
  const cookieA = await signUpEmail(API, emailA, "Mem A");
  const cookieB = await signUpEmail(API, emailB, "Mem B");
  const bearerA = await deviceBearer(API, cookieA);

  const wsA1 = await bindWorkspace(bearerA, `/tmp/chavez-mem-a1-${Date.now()}`);
  const wsA2 = await bindWorkspace(bearerA, `/tmp/chavez-mem-a2-${Date.now()}`);

  // 1. workspace fact
  const postWs = await json("/memories", {
    method: "POST",
    cookie: cookieA,
    body: JSON.stringify({
      fact: bunFact,
      scope: "workspace",
      workspaceId: wsA1,
    }),
  });
  assert(postWs.status === 201, `POST workspace ${postWs.status} ${JSON.stringify(postWs.body)}`);
  const memWs = (postWs.body as { memory: { id: string; fact: string } }).memory;
  assert(memWs.fact === bunFact, "workspace fact mismatch");

  const getA1 = await json(`/memories?workspaceId=${encodeURIComponent(wsA1)}`, {
    cookie: cookieA,
  });
  assert(getA1.status === 200, `GET wsA1 ${getA1.status}`);
  const listA1 = (getA1.body as { memories: Array<{ fact: string }> }).memories;
  assert(
    listA1.some((m) => m.fact === bunFact),
    "GET wsA1 missing bun fact",
  );

  // 2. user fact + other workspace
  const postUser = await json("/memories", {
    method: "POST",
    cookie: cookieA,
    body: JSON.stringify({
      fact: "responde en español",
      scope: "user",
    }),
  });
  assert(postUser.status === 201, `POST user ${postUser.status}`);
  const memUser = (postUser.body as { memory: { id: string } }).memory;

  const getUserOnly = await json("/memories", { cookie: cookieA });
  assert(getUserOnly.status === 200, "GET user only");
  const userList = (getUserOnly.body as { memories: Array<{ fact: string; scope: string }> })
    .memories;
  assert(
    userList.some((m) => m.fact === "responde en español" && m.scope === "user"),
    "user GET missing español",
  );

  const getA2 = await json(`/memories?workspaceId=${encodeURIComponent(wsA2)}`, {
    cookie: cookieA,
  });
  assert(getA2.status === 200, `GET wsA2 ${getA2.status}`);
  const listA2 = (getA2.body as { memories: Array<{ fact: string }> }).memories;
  assert(
    listA2.some((m) => m.fact === "responde en español"),
    "wsA2 should see user fact",
  );
  assert(
    !listA2.some((m) => m.fact === bunFact),
    "wsA2 must not see wsA1 workspace fact",
  );

  // 3. User B isolation
  const getB = await json("/memories", { cookie: cookieB });
  assert(getB.status === 200, `GET B ${getB.status}`);
  const listB = (getB.body as { memories: unknown[] }).memories;
  assert(listB.length === 0, "B must not see A's memories");

  const delB = await json(`/memories/${memWs.id}`, {
    method: "DELETE",
    cookie: cookieB,
  });
  assert(delB.status === 404, `B DELETE expected 404 got ${delB.status}`);

  // 4. A deletes
  const delA = await json(`/memories/${memWs.id}`, {
    method: "DELETE",
    cookie: cookieA,
  });
  assert(delA.status === 200, `A DELETE ${delA.status}`);
  const getAfter = await json(`/memories?workspaceId=${encodeURIComponent(wsA1)}`, {
    cookie: cookieA,
  });
  const afterList = (getAfter.body as { memories: Array<{ id: string }> }).memories;
  assert(
    !afterList.some((m) => m.id === memWs.id),
    "deleted workspace memory still listed",
  );

  // cleanup user memory
  await json(`/memories/${memUser.id}`, {
    method: "DELETE",
    cookie: cookieA,
  });

  // 5. validation + 2 facts (cap string covered in unit)
  const empty = await json("/memories", {
    method: "POST",
    cookie: cookieA,
    body: JSON.stringify({ fact: "", scope: "user" }),
  });
  assert(empty.status === 400, `empty fact ${empty.status}`);
  assert(
    String((empty.body as { error?: string }).error || "").includes(
      "fact must be 1–2000 characters",
    ),
    "empty fact error string",
  );

  const f1 = await json("/memories", {
    method: "POST",
    cookie: cookieA,
    body: JSON.stringify({ fact: "f-0", scope: "user" }),
  });
  const f2 = await json("/memories", {
    method: "POST",
    cookie: cookieA,
    body: JSON.stringify({ fact: "f-1", scope: "user" }),
  });
  assert(f1.status === 201 && f2.status === 201, "two user facts");

  // 6. 401
  const noAuth = await json("/memories");
  assert(noAuth.status === 401, `no-auth GET ${noAuth.status}`);

  // 7. JSON only — response is object, no file path
  assert(typeof postWs.body === "object" && postWs.body !== null, "JSON response");

  console.log("e2e-memory ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
