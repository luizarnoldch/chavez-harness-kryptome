/**
 * End-to-end smoke test for phase 1 auth + provider vault.
 * Run with API up: bun run scripts/e2e-phase1.ts
 */
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

const API = process.env.CHAVEZ_API_URL || "http://localhost:3000";
const CLIENT_ID = "chavez-cli";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const authClient = createAuthClient({
    baseURL: API,
    plugins: [deviceAuthorizationClient()],
  });

  console.log("1) device code");
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

  console.log("2) magic link");
  const ml = await fetch(`${API}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "e2e@chavez.dev",
      callbackURL: "/device",
      name: "E2E",
    }),
  });
  if (!ml.ok) throw new Error("magic link failed");
  await sleep(200);
  const linkFile = await Bun.file(`${import.meta.dir}/../.dev-magic-link.txt`).text();
  const url = linkFile.trim().split("\n")[1];
  console.log("   verify url ok");

  console.log("3) verify magic link");
  const verify = await fetch(url, { redirect: "manual" });
  const setCookie = verify.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookieHeader) {
    // fallback single header
    const single = verify.headers.get("set-cookie");
    if (!single) throw new Error("no session cookie from magic link verify");
  }
  const cookies =
    (verify.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ") || verify.headers.get("set-cookie")!.split(";")[0];
  console.log("   session cookie acquired");

  console.log("4) claim + approve device");
  const claim = await fetch(
    `${API}/api/auth/device?user_code=${encodeURIComponent(user_code)}`,
    { headers: { cookie: cookies } }
  );
  if (!claim.ok) throw new Error(`claim failed ${claim.status} ${await claim.text()}`);

  const approveHeaders = new Headers({
    cookie: cookies,
    "content-type": "application/json",
    Origin: API,
    Referer: `${API}/device`,
  });
  const approve = await fetch(`${API}/api/auth/device/approve`, {
    method: "POST",
    headers: approveHeaders,
    body: JSON.stringify({ userCode: user_code.replace(/-/g, "").toUpperCase() }),
  });
  if (!approve.ok) {
    throw new Error(`approve failed ${approve.status} ${await approve.text()}`);
  }
  console.log("   approved");

  console.log("5) poll token");
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
  console.log("   token ok");

  console.log("6) /me");
  const me = await fetch(`${API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log("  ", await me.json());

  console.log("7) link claude credentials");
  const put = await fetch(`${API}/providers/claude/credentials`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      authKind: "oauth_token",
      secret: "sk-ant-oat01-test-token",
    }),
  });
  if (!put.ok) throw new Error(await put.text());

  const list = await fetch(`${API}/providers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log("  ", await list.json());

  const get = await fetch(`${API}/providers/claude/credentials`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const creds = await get.json();
  if (creds.secret !== "sk-ant-oat01-test-token") {
    throw new Error("secret roundtrip failed");
  }
  console.log("   vault roundtrip ok");

  console.log("\nE2E PASS");
}

main().catch((err) => {
  console.error("E2E FAIL", err);
  process.exit(1);
});
