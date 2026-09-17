import { env } from "./config";

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
  limit?: number;
  seq?: number;
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

export type WsStatus = "idle" | "connecting" | "open" | "closed" | "error";

function wsBaseUrl(): string {
  const base =
    env.public.apiUrl.replace(/\/$/, "").replace(/^http/, "ws") + "/ws";
  if (typeof window === "undefined") return base;
  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
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
  private status: WsStatus = "idle";
  private onStatus?: (s: WsStatus) => void;
  private pushHandlers = new Set<(msg: WsPushMessage) => void>();

  setStatusListener(fn: (s: WsStatus) => void) {
    this.onStatus = fn;
  }

  onPush(handler: (msg: WsPushMessage) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  getStatus(): WsStatus {
    return this.status;
  }

  private setStatus(s: WsStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.setStatus("open");
      return;
    }
    this.setStatus("connecting");
    const url = wsBaseUrl();
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.setStatus("error");
        reject(new Error("WS connect timeout"));
      }, 10000);
      this.ws!.addEventListener("open", () => {
        clearTimeout(t);
        this.setStatus("open");
        resolve();
      });
      this.ws!.addEventListener("error", () => {
        clearTimeout(t);
        this.setStatus("error");
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
      this.setStatus("closed");
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

  async bind(path: string): Promise<WsResponse> {
    return this.request({ type: "workspace.bind", path, clientKind: "client" });
  }

  async unbind(): Promise<WsResponse> {
    return this.request({ type: "workspace.unbind" });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }
}
