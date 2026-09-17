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
  includeArchived?: boolean;
  archivedOnly?: boolean;
  pinned?: boolean;
  archived?: boolean;
  hostname?: string;
  daemonId?: string;
  requestId?: string;
  mentions?: string[];
  attachments?: unknown[];
  retryOfStreamId?: string;
  checkpoint?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  seq?: number;
  diffId?: string;
  diff?: Record<string, unknown>;
  action?: "status" | "diff" | "commit" | "push" | "pr" | "branch" | "snapshot" | "local.set";
  payload?: Record<string, unknown>;
  message?: string;
  paths?: string[];
  body?: string;
  base?: string;
  name?: string;
  remote?: string;
  force?: boolean;
  artifactId?: string;
  markdown?: string;
  enqueue?: boolean;
  queueId?: string;
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

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const RECONNECT_JITTER_MS = 250;

function reconnectDelay(attempt: number): number {
  const exp = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
  return (
    Math.min(RECONNECT_MAX_MS, exp) +
    Math.min(RECONNECT_JITTER_MS - 1, Math.floor(Math.random() * RECONNECT_JITTER_MS))
  );
}

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
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private bindPath: string | null = null;
  private autoReconnect = false;
  private connecting: Promise<void> | null = null;

  setStatusListener(fn: (s: WsStatus) => void) {
    this.onStatus = fn;
  }

  onPush(handler: (msg: WsPushMessage) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  enableAutoReconnect(opts?: { clientKind?: "client"; path?: string }) {
    this.autoReconnect = true;
    this.closedByUser = false;
    if (opts?.path) this.bindPath = opts.path;
  }

  getStatus(): WsStatus {
    return this.status;
  }

  private setStatus(s: WsStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  private attachHandlers() {
    if (!this.ws) return;
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
      if (!this.closedByUser && this.autoReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow() {
    if (this.closedByUser) return;
    try {
      await this.connect();
      if (this.bindPath) {
        await this.bind(this.bindPath);
      }
      this.reconnectAttempt = 0;
    } catch {
      this.scheduleReconnect();
    }
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.setStatus("open");
      return;
    }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
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
      this.attachHandlers();
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
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
    this.bindPath = path;
    return this.request({ type: "workspace.bind", path, clientKind: "client" });
  }

  async unbind(): Promise<WsResponse> {
    this.bindPath = null;
    return this.request({ type: "workspace.unbind" });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }
}
