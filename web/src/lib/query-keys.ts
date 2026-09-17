export const queryKeys = {
  health: ["health"] as const,
  me: ["me"] as const,
  providers: (token?: string | null) =>
    ["providers", token ?? "cookie"] as const,
  providerCredentials: (provider: string, token?: string | null) =>
    ["providerCredentials", provider, token ?? "cookie"] as const,
  workspaces: ["workspaces"] as const,
  onboarding: ["onboarding"] as const,
  connections: ["connections"] as const,
  workspaceSessions: (
    workspaceId: string,
    includeArchived = false,
    chatsLimit = 20,
  ) =>
    ["workspaceSessions", workspaceId, includeArchived, chatsLimit] as const,
  session: (sessionId: string) => ["session", sessionId] as const,
  sessionChats: (sessionId: string, includeArchived = false) =>
    ["sessionChats", sessionId, includeArchived] as const,
  chat: (chatId: string) => ["chat", chatId] as const,
  chatSearch: (q: string, workspaceId?: string, sessionId?: string) =>
    ["chatSearch", q, workspaceId ?? "", sessionId ?? ""] as const,
  gitSnapshot: (workspaceId: string) => ["gitSnapshot", workspaceId] as const,
  skills: ["skills"] as const,
  userRules: ["userRules"] as const,
  workspaceRules: (id: string) => ["workspaceRules", id] as const,
};
