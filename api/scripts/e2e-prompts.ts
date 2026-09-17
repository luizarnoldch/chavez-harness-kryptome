/**
 * E2E: account-scoped /prompts CRUD. Skip cleanly if API is down.
 * Run: bun run scripts/e2e-prompts.ts
 */
const API = process.env.CHAVEZ_API_URL || "http://localhost:25001";
const PASSWORD = "test-pass-12345";

function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const joined = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (joined) return joined;
  const single = res.headers.get("set-cookie");
  if (!single) throw new Error("no Set-Cookie in response");
  return single.split(";")[0]!;
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed ${res.status} ${await res.text()}`);
  }
  return cookieFromResponse(res);
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.log("skip e2e-prompts: API down");
    process.exit(0);
  }

  const email1 = `e2e-prompts-${Date.now()}@chavez.dev`;
  const cookie1 = await signUp(email1, "E2E Prompts");

  const unauth = await fetch(`${API}/prompts`, { headers: { Origin: API } });
  if (unauth.status !== 401) {
    throw new Error(`expected 401 without cookie, got ${unauth.status}`);
  }

  const empty = await fetch(`${API}/prompts`, {
    headers: { cookie: cookie1, Origin: API },
  });
  if (!empty.ok) throw new Error(`GET /prompts ${empty.status}`);
  const emptyJson = (await empty.json()) as { prompts: unknown[] };
  if (!Array.isArray(emptyJson.prompts) || emptyJson.prompts.length !== 0) {
    throw new Error("expected empty prompts for new user");
  }

  const created = await fetch(`${API}/prompts`, {
    method: "POST",
    headers: {
      cookie: cookie1,
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({ name: "review", body: "Review this PR" }),
  });
  if (created.status !== 201) {
    throw new Error(`POST /prompts ${created.status} ${await created.text()}`);
  }
  const createdJson = (await created.json()) as {
    prompt: { name: string; chatId?: string; streamId?: string };
  };
  if (createdJson.prompt.name !== "review") {
    throw new Error(`expected name review, got ${createdJson.prompt.name}`);
  }
  if ("chatId" in createdJson.prompt || "streamId" in createdJson.prompt) {
    throw new Error("save must not include chatId/streamId");
  }

  const listed = await fetch(`${API}/prompts`, {
    headers: { cookie: cookie1, Origin: API },
  });
  const listedJson = (await listed.json()) as {
    prompts: Array<{ name: string }>;
  };
  if (!listedJson.prompts.some((p) => p.name === "review")) {
    throw new Error("GET /prompts missing review");
  }

  const email2 = `e2e-prompts-b-${Date.now()}@chavez.dev`;
  const cookie2 = await signUp(email2, "E2E Prompts B");
  const other = await fetch(`${API}/prompts`, {
    headers: { cookie: cookie2, Origin: API },
  });
  const otherJson = (await other.json()) as { prompts: Array<{ name: string }> };
  if (otherJson.prompts.some((p) => p.name === "review")) {
    throw new Error("other user must not see review");
  }

  const dup = await fetch(`${API}/prompts`, {
    method: "POST",
    headers: {
      cookie: cookie1,
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({ name: "review", body: "dup" }),
  });
  if (dup.status !== 409) {
    throw new Error(`expected 409 duplicate, got ${dup.status}`);
  }
  const dupJson = (await dup.json()) as { error: string };
  if (dupJson.error !== "Prompt name already exists: review") {
    throw new Error(`unexpected 409 body: ${dupJson.error}`);
  }

  const getOne = await fetch(`${API}/prompts/review`, {
    headers: { cookie: cookie1, Origin: API },
  });
  if (!getOne.ok) throw new Error(`GET /prompts/review ${getOne.status}`);
  const getJson = (await getOne.json()) as { prompt: { body: string } };
  if (getJson.prompt.body !== "Review this PR") {
    throw new Error("body mismatch on get");
  }

  const del = await fetch(`${API}/prompts/review`, {
    method: "DELETE",
    headers: { cookie: cookie1, Origin: API },
  });
  if (!del.ok) throw new Error(`DELETE ${del.status}`);
  const gone = await fetch(`${API}/prompts/review`, {
    headers: { cookie: cookie1, Origin: API },
  });
  if (gone.status !== 404) throw new Error(`expected 404 after delete`);
  const goneJson = (await gone.json()) as { error: string };
  if (goneJson.error !== "Prompt not found: review") {
    throw new Error(`unexpected 404 body: ${goneJson.error}`);
  }

  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${API}/prompts`, {
      method: "POST",
      headers: {
        cookie: cookie1,
        "content-type": "application/json",
        Origin: API,
      },
      body: JSON.stringify({
        name: `cap-${i}`,
        body: `body ${i}`,
      }),
    });
    if (res.status !== 201) {
      throw new Error(`cap seed ${i} failed ${res.status} ${await res.text()}`);
    }
  }
  const over = await fetch(`${API}/prompts`, {
    method: "POST",
    headers: {
      cookie: cookie1,
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({ name: "cap-overflow", body: "x" }),
  });
  if (over.status !== 400) {
    throw new Error(`expected 400 at cap, got ${over.status}`);
  }
  const overJson = (await over.json()) as { error: string };
  if (overJson.error !== "Maximum 50 saved prompts") {
    throw new Error(`unexpected cap error: ${overJson.error}`);
  }

  for (let i = 0; i < 50; i++) {
    await fetch(`${API}/prompts/cap-${i}`, {
      method: "DELETE",
      headers: { cookie: cookie1, Origin: API },
    });
  }

  console.log("e2e-prompts ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
