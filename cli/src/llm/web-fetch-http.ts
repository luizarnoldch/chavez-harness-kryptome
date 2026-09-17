import {
  FETCH_BODY_MAX_CHARS,
  FETCH_EMPTY,
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENT,
  fetchBinaryOmitted,
} from "./web-fetch-constants";
import { htmlToText, isHtmlContentType, isTextContentType } from "./web-fetch-html";
import {
  assertFetchUrlSafe,
  type SsrfEnv,
} from "./web-fetch-ssrf";

export type WebFetchResult = {
  ok: boolean;
  url: string;
  status?: number;
  contentType?: string;
  text: string;
  truncated: boolean;
  bytes: number;
};

function truncateBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= FETCH_BODY_MAX_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, FETCH_BODY_MAX_CHARS)}\n[truncated: showing ${FETCH_BODY_MAX_CHARS} of ${text.length} chars]`,
    truncated: true,
  };
}

async function readLimited(res: Response): Promise<{ buf: Uint8Array; overflow: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = new Uint8Array(await res.arrayBuffer());
    return { buf: ab.slice(0, FETCH_MAX_BYTES), overflow: ab.byteLength > FETCH_MAX_BYTES };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > FETCH_MAX_BYTES) {
      const room = FETCH_MAX_BYTES - total;
      if (room > 0) chunks.push(value.slice(0, room));
      total = FETCH_MAX_BYTES;
      overflow = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { buf, overflow };
}

/**
 * GET http(s) desde el proceso actual (daemon). Re-chequea SSRF en cada hop.
 * Nunca sigue un Location a metadata / API origin.
 */
export async function runWebFetch(
  rawUrl: string,
  env: SsrfEnv = {},
): Promise<WebFetchResult> {
  let current = rawUrl;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    const safe = await assertFetchUrlSafe(current, env);
    if (!safe.ok) {
      return { ok: false, url: current, text: safe.message, truncated: false, bytes: 0 };
    }
    const url = safe.url.toString();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent": FETCH_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, url, text: `Fetch failed: ${msg}`, truncated: false, bytes: 0 };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        return {
          ok: false,
          url,
          status: res.status,
          text: `Fetch failed: redirect ${res.status} without Location`,
          truncated: false,
          bytes: 0,
        };
      }
      current = new URL(loc, url).toString();
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    const { buf, overflow } = await readLimited(res);
    const bytes = buf.byteLength;

    if (!isTextContentType(contentType) && !isHtmlContentType(contentType)) {
      return {
        ok: res.ok,
        url,
        status: res.status,
        contentType,
        text: fetchBinaryOmitted(contentType.split(";")[0] || "", bytes),
        truncated: false,
        bytes,
      };
    }

    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const body = isHtmlContentType(contentType) ? htmlToText(raw) : raw;
    const cut = truncateBody(body || (overflow ? "" : ""));
    const text =
      cut.text ||
      (overflow
        ? truncateBody("x".repeat(FETCH_BODY_MAX_CHARS + 1)).text
        : FETCH_EMPTY);
    return {
      ok: res.ok,
      url,
      status: res.status,
      contentType,
      text,
      truncated: cut.truncated || overflow,
      bytes,
    };
  }
  return {
    ok: false,
    url: current,
    text: `Fetch failed: more than ${FETCH_MAX_REDIRECTS} redirects`,
    truncated: false,
    bytes: 0,
  };
}
