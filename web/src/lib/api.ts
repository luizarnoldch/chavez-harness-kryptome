import { env } from "./config";

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, data: unknown, message?: string) {
    super(
      message ||
        (typeof data === "object" &&
        data &&
        "error" in data &&
        typeof (data as { error: unknown }).error === "string"
          ? (data as { error: string }).error
          : `Request failed (${status})`),
    );
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export function apiUrl(path: string): string {
  const base = env.public.apiUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export async function apiJson<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      credentials: "include",
      headers,
    });
  } catch (err) {
    throw new ApiError(
      0,
      null,
      err instanceof Error ? err.message : "Network error — ¿está la API arriba?",
    );
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }

  return data as T;
}

/** @deprecated Prefer apiJson; kept for gradual migration */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  try {
    const data = await apiJson<T>(path, init);
    return { ok: true, status: 200, data };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, status: err.status, data: err.data as T };
    }
    throw err;
  }
}

export function authHeaders(token?: string | null): HeadersInit {
  const headers: HeadersInit = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}
