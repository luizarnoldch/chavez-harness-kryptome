#!/usr/bin/env bun
/**
 * E2E: GitHub vault isolation per userId. Requires API + DB.
 * Usage: bun run scripts/e2e-git-vault.ts
 */
import { signUpEmail, assert } from "./e2e-helpers";

const API = process.env.CHAVEZ_API_URL || "http://localhost:25001";

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

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`API not up at ${API} (health failed)`);
  }

  const emailA = `e2e-git-a-${Date.now()}@chavez.dev`;
  const emailB = `e2e-git-b-${Date.now()}@chavez.dev`;
  const cookieA = await signUpEmail(API, emailA, "Git A");
  const cookieB = await signUpEmail(API, emailB, "Git B");

  const putA = await json("/providers/github/credentials", {
    method: "PUT",
    cookie: cookieA,
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_aaa" }),
  });
  assert(putA.status === 200, `A PUT ${putA.status}`);
  console.log("linked ok");

  const getA = await json("/providers/github/credentials", { cookie: cookieA });
  assert(getA.status === 200, `A GET ${getA.status}`);
  assert(
    (getA.body as { secret?: string }).secret === "ghp_aaa",
    "A secret mismatch",
  );

  const getBempty = await json("/providers/github/credentials", {
    cookie: cookieB,
  });
  assert(getBempty.status === 404, `B GET expected 404 got ${getBempty.status}`);

  const putB = await json("/providers/github/credentials", {
    method: "PUT",
    cookie: cookieB,
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_bbb" }),
  });
  assert(putB.status === 200, `B PUT ${putB.status}`);

  const getA2 = await json("/providers/github/credentials", { cookie: cookieA });
  assert(
    (getA2.body as { secret?: string }).secret === "ghp_aaa",
    "A leaked B token",
  );

  const noAuthGet = await json("/providers/github/credentials");
  assert(noAuthGet.status === 401, `no-auth GET ${noAuthGet.status}`);
  const noAuthPut = await json("/providers/github/credentials", {
    method: "PUT",
    body: JSON.stringify({ authKind: "api_key", secret: "ghp_ccc" }),
  });
  assert(noAuthPut.status === 401, `no-auth PUT ${noAuthPut.status}`);

  const active = await json("/providers/active", {
    method: "PUT",
    cookie: cookieA,
    body: JSON.stringify({ provider: "github" }),
  });
  assert(active.status === 400, `active github ${active.status}`);

  const list = await json("/providers", { cookie: cookieA });
  assert(list.status === 200, `list ${list.status}`);
  const body = list.body as {
    activeProvider?: string | null;
    providers?: { github?: { linked?: boolean; runnable?: boolean } };
  };
  assert(body.providers?.github?.linked === true, "github not linked in list");
  assert(body.providers?.github?.runnable === false, "github should not be runnable");
  assert(body.activeProvider !== "github", "activeProvider is github");

  console.log("e2e-git-vault ok");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
