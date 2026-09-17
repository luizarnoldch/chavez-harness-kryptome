import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

export const CLIENT_ID = "chavez-cli";
export const E2E_PASSWORD = "test-pass-12345";

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const joined = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (joined) return joined;
  const single = res.headers.get("set-cookie");
  if (!single) throw new Error("no Set-Cookie in response");
  return single.split(";")[0]!;
}

export async function signUpEmail(
  api: string,
  email: string,
  name: string,
  password = E2E_PASSWORD,
): Promise<string> {
  const res = await fetch(`${api}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: api,
    },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    throw new Error(`sign-up ${email} failed ${res.status} ${await res.text()}`);
  }
  return cookieFromResponse(res);
}

export async function deviceBearer(api: string, cookie: string): Promise<string> {
  const authClient = createAuthClient({
    baseURL: api,
    plugins: [deviceAuthorizationClient()],
  });
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

  const claim = await fetch(
    `${api}/api/auth/device?user_code=${encodeURIComponent(user_code)}`,
    { headers: { cookie } },
  );
  if (!claim.ok) {
    throw new Error(`claim failed ${claim.status} ${await claim.text()}`);
  }

  const approve = await fetch(`${api}/api/auth/device/approve`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      Origin: api,
      Referer: `${api}/device`,
    },
    body: JSON.stringify({
      userCode: user_code.replace(/-/g, "").toUpperCase(),
    }),
  });
  if (!approve.ok) {
    throw new Error(`approve failed ${approve.status} ${await approve.text()}`);
  }

  for (let i = 0; i < 10; i++) {
    const tokenRes = await authClient.device.token({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code,
      client_id: CLIENT_ID,
    });
    if (tokenRes.data?.access_token) return tokenRes.data.access_token;
    await sleep(1000);
  }
  throw new Error("no access token");
}

export type WsReply = {
  type: string;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  push?: boolean;
};

export async function withWs<T>(
  api: string,
  token: string,
  fn: (
    send: (msg: Record<string, unknown>) => Promise<WsReply>,
    ws: WebSocket,
    pushes: WsReply[],
  ) => Promise<T>,
): Promise<T> {
  const wsUrl = api.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws connection failed"));
    });
  });
  const pending = new Map<string, (v: WsReply) => void>();
  const pushes: WsReply[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      const raw = JSON.parse(String(ev.data)) as WsReply;
      if (raw.push) {
        pushes.push(raw);
        return;
      }
      const p = pending.get(raw.id);
      if (p) {
        pending.delete(raw.id);
        p(raw);
      }
    } catch {
      // ignore
    }
  });
  let n = 0;
  const send = (msg: Record<string, unknown>) => {
    const id = String(msg.id || `e2e-${++n}`);
    const payload = { ...msg, id };
    return new Promise<WsReply>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`ws timeout ${payload.type}`)),
        10000,
      );
      pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      ws.send(JSON.stringify(payload));
    });
  };
  try {
    return await fn(send, ws, pushes);
  } finally {
    ws.close();
  }
}
