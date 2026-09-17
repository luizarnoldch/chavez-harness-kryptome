import { hostname } from "node:os";
import { loadConfig } from "../config";
import { cwdPath } from "../workspace";

export type WsRequest = {
  type: string;
  id: string;
  path?: string;
  title?: string;
  sessionId?: string;
  chatId?: string;
  role?: string;
  content?: string;
  clientKind?: "client" | "daemon";
  metadata?: Record<string, unknown>;
  streamId?: string;
  toolCallId?: string;
  toolName?: string;
  prompt?: string;
  delta?: string;
  status?: string;
  query?: string;
  hostname?: string;
  requestId?: string;
  mentions?: string[];
  attachments?: unknown[];
  retryOfStreamId?: string;
  checkpoint?: Record<string, unknown>;
  limit?: number;
  seq?: number;
  diffId?: string;
  diff?: Record<string, unknown>;
};

export type WsResponse = {
  type: string;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type WsPushMessage = {
  type: string;
  push: true;
  eventId: string;
  data?: unknown;
};

function wsUrl(token: string): string {
  const config = loadConfig();
  const base = config.apiUrl.replace(/^http/, "ws");
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

function isPush(msg: unknown): msg is WsPushMessage {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as WsPushMessage).push === true &&
    typeof (msg as WsPushMessage).type === "string"
  );
}

export class ChavezWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (v: WsResponse) => void; reject: (e: Error) => void }
  >();
  private reqCounter = 0;
  private pushHandlers = new Set<(msg: WsPushMessage) => void>();

  constructor(private token: string) {}

  onPush(handler: (msg: WsPushMessage) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const url = wsUrl(this.token);
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10000);
      this.ws!.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws!.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("WS connection failed"));
      });
    });
    this.ws.addEventListener("message", (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as unknown;
        if (isPush(raw)) {
          for (const h of this.pushHandlers) h(raw);
          return;
        }
        const msg = raw as WsResponse;
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        // ignore
      }
    });
    this.ws.addEventListener("close", () => {
      for (const [, p] of this.pending) {
        p.reject(new Error("WebSocket closed"));
      }
      this.pending.clear();
      this.ws = null;
    });
  }

  async request(
    partial: Omit<WsRequest, "id"> & { id?: string },
    timeoutMs = 15000,
  ): Promise<WsResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const id = partial.id || `req-${++this.reqCounter}`;
    const payload: WsRequest = { ...partial, id };
    const result = new Promise<WsResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`WS request timeout: ${payload.type}`));
        }
      }, timeoutMs);
    });
    this.ws!.send(JSON.stringify(payload));
    return result;
  }

  async bind(
    path = cwdPath(),
    clientKind: "client" | "daemon" = "client",
  ): Promise<WsResponse> {
    return this.request({
      type: "workspace.bind",
      path,
      clientKind,
      hostname: hostname(),
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/** One-shot request: connect, bind, call, optionally keep open handled by caller. */
export async function withWs<T>(
  token: string,
  fn: (client: ChavezWsClient) => Promise<T>,
  options: { bind?: boolean; keepOpen?: boolean; clientKind?: "client" | "daemon" } = {},
): Promise<T> {
  const client = new ChavezWsClient(token);
  await client.connect();
  if (options.bind !== false) {
    const bound = await client.bind(cwdPath(), options.clientKind || "client");
    if (!bound.ok) throw new Error(bound.error || "workspace.bind failed");
  }
  try {
    return await fn(client);
  } finally {
    if (!options.keepOpen) client.close();
  }
}
