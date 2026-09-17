export const queryKeys = {
  health: ["health"] as const,
  me: ["me"] as const,
  providers: (token?: string | null) =>
    ["providers", token ?? "cookie"] as const,
  providerCredentials: (provider: string, token?: string | null) =>
    ["providerCredentials", provider, token ?? "cookie"] as const,
  workspaces: ["workspaces"] as const,
  connections: ["connections"] as const,
  workspaceSessions: (workspaceId: string) =>
    ["workspaceSessions", workspaceId] as const,
  session: (sessionId: string) => ["session", sessionId] as const,
  sessionChats: (sessionId: string) => ["sessionChats", sessionId] as const,
  chat: (chatId: string) => ["chat", chatId] as const,
  gitSnapshot: (workspaceId: string) => ["gitSnapshot", workspaceId] as const,
  skills: ["skills"] as const,
  userRules: ["userRules"] as const,
  workspaceRules: (id: string) => ["workspaceRules", id] as const,
};
