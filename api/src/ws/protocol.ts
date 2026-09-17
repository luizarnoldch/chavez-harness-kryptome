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
  parentToolCallId?: string;
  subagentId?: string;
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
  cwd?: string;
  daemonId?: string;
  requestId?: string;
  action?: string;
  branch?: string;
  mentions?: string[];
  attachments?: unknown[];
  retryOfStreamId?: string;
  checkpoint?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  seq?: number;
  diffId?: string;
  diff?: Record<string, unknown>;
  decision?: string;
  resolvedBy?: string;
  payload?: Record<string, unknown>;
  format?: string;
  token?: string;
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
  ptyId?: string;
  cols?: number;
  rows?: number;
  chunk?: string;
  encoding?: string;
  ownerConnectionId?: string;
  reason?: string;
  exitCode?: number | null;
};

export type ServerMessage = {
  type: string;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

// Plan 24: in-app notices are classified on Web/TUI from existing pushes.
// Deltas stay in RESERVED_STREAM_TYPES for fan-out, never as OS/email or a dedicated notice event.
export const RESERVED_STREAM_TYPES = [
  "chat.stream.start",
  "chat.stream.delta",
  "chat.thinking.delta",
  "chat.thinking.end",
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
