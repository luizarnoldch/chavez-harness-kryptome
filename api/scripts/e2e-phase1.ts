/**
 * End-to-end smoke test for dual auth + provider vault.
 * Run with API up: bun run scripts/e2e-phase1.ts
 */
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { z } from "zod";

const e2eEnv = z
  .object({
    CHAVEZ_API_URL: z.string().url().default("http://localhost:25001"),
  })
  .parse({
    CHAVEZ_API_URL: process.env.CHAVEZ_API_URL || undefined,
  });

const API = e2eEnv.CHAVEZ_API_URL;
const CLIENT_ID = "chavez-cli";
const PASSWORD_EMAIL = `e2e-pw-${Date.now()}@chavez.dev`;
const PASSWORD = "test-pass-12345";
const MAGIC_EMAIL = `e2e-ml-${Date.now()}@chavez.dev`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const joined = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (joined) return joined;
  const single = res.headers.get("set-cookie");
  if (!single) throw new Error("no Set-Cookie in response");
  return single.split(";")[0]!;
}

async function main() {
  const authClient = createAuthClient({
    baseURL: API,
    plugins: [deviceAuthorizationClient()],
  });

  console.log("A) password sign-up + /me cookie + vault");
  const signUp = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({
      email: PASSWORD_EMAIL,
      password: PASSWORD,
      name: "E2E Password",
    }),
  });
  if (!signUp.ok) {
    throw new Error(`sign-up failed ${signUp.status} ${await signUp.text()}`);
  }
  const pwCookies = cookieFromResponse(signUp);
  const mePw = await fetch(`${API}/me`, { headers: { cookie: pwCookies } });
  if (!mePw.ok) throw new Error(`/me cookie failed ${mePw.status}`);
  console.log("   ", await mePw.json());

  const putPw = await fetch(`${API}/providers/claude/credentials`, {
    method: "PUT",
    headers: {
      cookie: pwCookies,
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({
      authKind: "api_key",
      secret: "sk-test-password-user",
    }),
  });
  if (!putPw.ok) throw new Error(await putPw.text());
  console.log("   password-user vault ok");

  console.log("B) magic link → set password → sign-in email");
  const ml = await fetch(`${API}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: API },
    body: JSON.stringify({
      email: MAGIC_EMAIL,
      callbackURL: `${API}/device`,
      name: "E2E Magic",
    }),
  });
  if (!ml.ok) throw new Error("magic link failed");
  await sleep(200);
  const linkFile = await Bun.file(
    `${import.meta.dir}/../.dev-magic-link.txt`,
  ).text();
  const url = linkFile.trim().split("\n")[1];
  if (!url) throw new Error("no magic link url in .dev-magic-link.txt");

  const verify = await fetch(url!, { redirect: "manual" });
  const magicCookies = cookieFromResponse(verify);
  console.log("   magic session cookie ok");

  const setPw = await fetch(`${API}/me/password`, {
    method: "POST",
    headers: {
      cookie: magicCookies,
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({ newPassword: PASSWORD }),
  });
  if (!setPw.ok) {
    throw new Error(`set password failed ${setPw.status} ${await setPw.text()}`);
  }
  console.log("   set password on magic account ok");

  const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: API,
    },
    body: JSON.stringify({
      email: MAGIC_EMAIL,
      password: PASSWORD,
    }),
  });
  if (!signIn.ok) {
    throw new Error(`sign-in email failed ${signIn.status} ${await signIn.text()}`);
  }
  const emailCookies = cookieFromResponse(signIn);
  const meEmail = await fetch(`${API}/me`, {
    headers: { cookie: emailCookies },
  });
  if (!meEmail.ok) throw new Error("sign-in /me failed");
  console.log("   magic↔password sync ok", await meEmail.json());

  console.log("C) device flow (magic session) + bearer vault");
  const codeRes = await authClient.device.code({
    client_id: CLIENT_ID,
    scope: "openid profile email",
  });
  if (codeRes.error || !codeRes.data) {
    throw new Error(JSON.stringify(codeRes.error));
  }
  const { device_code, user_code } = codeRes.data as {
    device_code: string;
    user_code: string;
  };
  console.log("   user_code=", user_code);

  const claim = await fetch(
    `${API}/api/auth/device?user_code=${encodeURIComponent(user_code)}`,
    { headers: { cookie: emailCookies } },
  );
  if (!claim.ok) {
    throw new Error(`claim failed ${claim.status} ${await claim.text()}`);
  }

  const approve = await fetch(`${API}/api/auth/device/approve`, {
    method: "POST",
    headers: {
      cookie: emailCookies,
      "content-type": "application/json",
      Origin: API,
      Referer: `${API}/device`,
    },
    body: JSON.stringify({
      userCode: user_code.replace(/-/g, "").toUpperCase(),
    }),
  });
  if (!approve.ok) {
    throw new Error(`approve failed ${approve.status} ${await approve.text()}`);
  }

  let accessToken = "";
  for (let i = 0; i < 10; i++) {
    const tokenRes = await authClient.device.token({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code,
      client_id: CLIENT_ID,
    });
    if (tokenRes.data?.access_token) {
      accessToken = tokenRes.data.access_token;
      break;
    }
    await sleep(1000);
  }
  if (!accessToken) throw new Error("no access token");
  console.log("   bearer ok");

  const put = await fetch(`${API}/providers/cursor/credentials`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      authKind: "api_key",
      secret: "cursor-test-key",
    }),
  });
  if (!put.ok) throw new Error(await put.text());

  const list = await fetch(`${API}/providers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listJson = (await list.json()) as {
    providers?: {
      cursor?: { linked?: boolean; runnable?: boolean; models?: unknown[] };
    };
  };
  if (!listJson.providers?.cursor?.linked) {
    throw new Error("cursor should be linked");
  }
  if (
    listJson.providers.cursor.runnable === true &&
    !(
      Array.isArray(listJson.providers.cursor.models) &&
      listJson.providers.cursor.models.length > 0
    )
  ) {
    throw new Error("runnable without real models");
  }
  if (JSON.stringify(listJson).includes("cursor-test-key")) {
    throw new Error("secret leaked in GET /providers");
  }
  console.log("   cursor linked=", listJson.providers.cursor.linked, "runnable=", listJson.providers.cursor.runnable);

  console.log("\nE2E PASS");
}

main().catch((err) => {
  console.error("E2E FAIL", err);
  process.exit(1);
});
