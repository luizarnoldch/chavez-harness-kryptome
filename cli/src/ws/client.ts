import { hostname } from "node:os";
import { loadConfig } from "../config";
import { cwdPath } from "../workspace";
import { reconnectDelayWithJitter } from "./reconnect";

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

export type BindOpts = {
  path: string;
  clientKind: "client" | "daemon";
  hostname?: string;
  daemonId?: string;
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
  private closeHandlers = new Set<(info: { userInitiated: boolean }) => void>();
  private statusHandlers = new Set<(status: string) => void>();
  private rebindHandlers = new Set<(res: WsResponse) => void>();
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private bindOpts: BindOpts | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private token: string) {}

  onPush(handler: (msg: WsPushMessage) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  onClose(handler: (info: { userInitiated: boolean }) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStatus(handler: (status: string) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onRebind(handler: (res: WsResponse) => void): () => void {
    this.rebindHandlers.add(handler);
    return () => this.rebindHandlers.delete(handler);
  }

  enableAutoReconnect(opts: BindOpts): void {
    this.bindOpts = opts;
    this.closedByUser = false;
  }

  private emitStatus(status: string) {
    for (const h of this.statusHandlers) h(status);
  }

  private attachSocketHandlers() {
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
      const userInitiated = this.closedByUser;
      for (const [, p] of this.pending) {
        p.reject(new Error("WebSocket closed"));
      }
      this.pending.clear();
      this.ws = null;
      for (const h of this.closeHandlers) h({ userInitiated });
      if (!userInitiated && this.bindOpts) {
        this.emitStatus("reconnecting");
        this.scheduleReconnect();
      }
    });
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const url = wsUrl(this.token);
      this.ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("WS connect timeout")),
          10000,
        );
        this.ws!.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        this.ws!.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("WS connection failed"));
        });
      });
      this.attachSocketHandlers();
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = reconnectDelayWithJitter(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow() {
    if (this.closedByUser || !this.bindOpts) return;
    try {
      await this.connect();
      const bound = await this.bind(this.bindOpts.path, this.bindOpts.clientKind, {
        daemonId: this.bindOpts.daemonId,
      });
      if (!bound.ok) throw new Error(bound.error || "rebind failed");
      this.reconnectAttempt = 0;
      for (const h of this.rebindHandlers) h(bound);
      this.emitStatus("bound");
    } catch {
      this.scheduleReconnect();
    }
  }

  async request(
    partial: Omit<WsRequest, "id"> & { id?: string },
    timeoutMs = 15000,
  ): Promise<WsResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      try {
        await this.connect();
        if (this.bindOpts && partial.type !== "workspace.bind") {
          const rebound = await this.sendRequest(
            {
              type: "workspace.bind",
              path: this.bindOpts.path,
              clientKind: this.bindOpts.clientKind,
              hostname: hostname(),
              daemonId:
                this.bindOpts.clientKind === "daemon"
                  ? this.bindOpts.daemonId
                  : undefined,
            },
            timeoutMs,
          );
          if (!rebound.ok) {
            throw new Error(rebound.error || "workspace.bind failed");
          }
        }
      } catch (err) {
        if (this.bindOpts && !this.closedByUser) this.scheduleReconnect();
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    return this.sendRequest(partial, timeoutMs);
  }

  private sendRequest(
    partial: Omit<WsRequest, "id"> & { id?: string },
    timeoutMs = 15000,
  ): Promise<WsResponse> {
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
    extra?: { daemonId?: string },
  ): Promise<WsResponse> {
    const daemonId = extra?.daemonId ?? this.bindOpts?.daemonId;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    return this.sendRequest({
      type: "workspace.bind",
      path,
      clientKind,
      hostname: hostname(),
      daemonId: clientKind === "daemon" ? daemonId : undefined,
    });
  }

  dropForTest(): void {
    this.ws?.close();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
