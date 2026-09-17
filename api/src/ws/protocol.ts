export type ClientMessage = {
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
  decision?: string;
  resolvedBy?: string;
  action?: "status" | "diff" | "commit" | "push" | "pr" | "branch";
  message?: string;
  paths?: string[];
  body?: string;
  base?: string;
  name?: string;
  remote?: string;
  force?: boolean;
};

export type ServerMessage = {
  type: string;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

export const RESERVED_STREAM_TYPES = [
  "chat.stream.start",
  "chat.stream.delta",
  "chat.stream.end",
  "chat.stream.error",
] as const;

export function ok(type: string, id: string, data?: unknown): ServerMessage {
  return { type, id, ok: true, data };
}

export function fail(type: string, id: string, error: string): ServerMessage {
  return { type, id, ok: false, error };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || path;
}

export function basename(path: string): string {
  const n = normalizePath(path);
  const parts = n.split("/");
  return parts[parts.length - 1] || n;
}
