import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiJson, apiUrl, authHeaders } from "./api";
import { authClient } from "./auth-client";
import { queryKeys } from "./query-keys";
import type { TurnFileDiff } from "./diff-display";
import type { ContextUsage } from "./context-budget";
import type { ChatUsageView } from "./usage-codec";
import type { OnboardingPublic } from "./onboarding";

export type { OnboardingPublic } from "./onboarding";

export type { TurnFileDiff } from "./diff-display";

export type MeUser = { id: string; email: string; name?: string };

export type EffortLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelInfo = {
  id: string;
  label: string;
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  effortLevels?: EffortLevel[];
};

export type CursorParamSelection = { id: string; value: string };

export type CursorModelInfo = {
  id: string;
  displayName?: string;
  label?: string;
  description?: string;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  variants?: Array<{
    params: CursorParamSelection[];
    displayName: string;
    isDefault?: boolean;
  }>;
};

export type ProviderCatalog = {
  id: string;
  label: string;
  models?: unknown[];
  raw?: unknown;
  runnable?: boolean;
  catalogError?: string | null;
};

export type ProvidersResponse = {
  activeProvider: string | null;
  activeModel: string | null;
  activeEffort: string | null;
  activeParams?: CursorParamSelection[] | null;
  activeExecutionMode?: string | null;
  lastRunnableExecutionMode?: string | null;
  catalogs?: Array<{
    id: string;
    label: string;
    runnable?: boolean;
    raw?: unknown;
    models?: unknown[];
    catalogError?: string | null;
  }>;
  providers: Record<
    string,
    {
      linked: boolean;
      authKind?: string;
      label?: string;
      runnable?: boolean;
      models?: unknown[];
      catalogError?: string | null;
      updatedAt?: string;
    }
  >;
};

export type Workspace = {
  id: string;
  path?: string;
  name?: string;
  openConnections?: number;
  daemonBound?: boolean;
  daemonConnections?: number;
  daemonHostname?: string | null;
  daemonPath?: string;
  daemonLastSeen?: string | null;
  daemonRole?: string | null;
  userRulesEnabled?: boolean;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Connection = {
  connectionId?: string;
  id?: string;
  workspaceId?: string | null;
  path?: string | null;
  cwd?: string | null;
  clientKind?: "client" | "daemon";
  hostname?: string | null;
  daemonId?: string | null;
  role?: "primary" | "standby" | "client" | string;
  connectedAt?: string;
  firstBoundAt?: string;
  lastSeen?: string;
  turnBusy?: boolean;
};

export type AgentSession = {
  id: string;
  workspaceId: string;
  userId?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ChatMessage = {
  id: string;
  chatId?: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
};

export type Chat = {
  id: string;
  sessionId: string;
  userId?: string;
  title: string;
  titleSource?: "default" | "auto" | "user";
  pinnedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  recentMessages?: ChatMessage[];
  sessionTitle?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
};

export type ChatDetail = {
  chat: Chat;
  messages: ChatMessage[];
  usage?: ChatUsageView;
  currentPlanArtifactId?: string | null;
  context?: ContextUsage;
  diffs?: unknown;
};

export type WorkspaceSessionOverview = AgentSession & {
  chats: Chat[];
  chatCount?: number;
  hasMoreChats?: boolean;
};

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiJson<{ ok: boolean }>("/health"),
    refetchInterval: 30_000,
  });
}

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async (): Promise<MeUser | null> => {
      try {
        const session = await authClient.getSession();
        if (session.data?.user) {
          const u = session.data.user;
          return {
            id: u.id,
            email: u.email,
            name: u.name ?? undefined,
          };
        }
      } catch {
        /* fall through to /me */
      }
      const token =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("token")
          : null;
      if (token) {
        try {
          const data = await apiJson<{ user: MeUser }>("/me", {
            headers: authHeaders(token),
          });
          return data.user;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 401)) throw err;
        }
      }
      try {
        const data = await apiJson<{ user: MeUser }>("/me");
        return data.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

export function useProviders(token?: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.providers(token),
    enabled,
    queryFn: () =>
      apiJson<ProvidersResponse>("/providers", {
        headers: authHeaders(token),
      }),
  });
}

export function useWorkspaces(enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaces,
    enabled,
    refetchInterval: 3000,
    queryFn: async () => {
      const data = await apiJson<{ workspaces: Workspace[] }>("/workspaces");
      return data.workspaces ?? [];
    },
  });
}

export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: queryKeys.onboarding,
    enabled,
    queryFn: () => apiJson<OnboardingPublic>("/me/onboarding"),
  });
}

export function useOnboardingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "skip" | "complete") =>
      apiJson<OnboardingPublic>("/me/onboarding", {
        method: "PUT",
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.onboarding });
    },
  });
}

export function useConnections(enabled = true) {
  return useQuery({
    queryKey: queryKeys.connections,
    enabled,
    refetchInterval: 3000,
    queryFn: async () => {
      const data = await apiJson<{ connections: Connection[] }>("/connections");
      return data.connections ?? [];
    },
  });
}

export function useWorkspaceSessions(
  workspaceId: string,
  enabled = true,
  opts: { includeArchived?: boolean; chatsLimit?: number } = {},
) {
  const includeArchived = opts.includeArchived ?? false;
  const chatsLimit = opts.chatsLimit ?? 20;
  return useQuery({
    queryKey: queryKeys.workspaceSessions(
      workspaceId,
      includeArchived,
      chatsLimit,
    ),
    enabled: enabled && Boolean(workspaceId),
    queryFn: async () => {
      const data = await apiJson<{
        workspace: Workspace;
        sessions: WorkspaceSessionOverview[];
        openConnections: number;
        daemonBound?: boolean;
        daemonConnections?: number;
        daemonHostname?: string | null;
        daemonPath?: string;
        daemonLastSeen?: string | null;
        daemonRole?: string | null;
      }>(
        `/workspaces/${workspaceId}/sessions?chatsLimit=${chatsLimit}` +
          `&includeArchived=${includeArchived ? "1" : "0"}`,
      );
      return {
        ...data,
        workspace: {
          ...data.workspace,
          daemonBound: data.daemonBound ?? data.workspace.daemonBound,
          daemonConnections:
            data.daemonConnections ?? data.workspace.daemonConnections,
        },
      };
    },
  });
}

export function useSession(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.session(sessionId),
    enabled: enabled && Boolean(sessionId),
    queryFn: () =>
      apiJson<{
        session: AgentSession;
        workspace: { id: string; path: string; name: string };
      }>(`/sessions/${sessionId}`),
  });
}

export function useSessionChats(
  sessionId: string,
  enabled = true,
  opts: { includeArchived?: boolean; limit?: number } = {},
) {
  const includeArchived = opts.includeArchived ?? false;
  const limit = opts.limit ?? 100;
  return useQuery({
    queryKey: queryKeys.sessionChats(sessionId, includeArchived),
    enabled: enabled && Boolean(sessionId),
    queryFn: async () => {
      const data = await apiJson<{
        sessionId: string;
        chats: Chat[];
        total?: number;
        hasMore?: boolean;
      }>(
        `/sessions/${sessionId}/chats?limit=${limit}` +
          `&includeArchived=${includeArchived ? "1" : "0"}`,
      );
      return data.chats ?? [];
    },
  });
}

export function useChatSearch(
  q: string,
  opts: {
    workspaceId?: string;
    sessionId?: string;
    includeArchived?: boolean;
    enabled?: boolean;
  } = {},
) {
  return useQuery({
    queryKey: queryKeys.chatSearch(
      q,
      opts.workspaceId,
      opts.sessionId,
      opts.includeArchived ?? false,
    ),
    enabled: (opts.enabled ?? true) && q.trim().length >= 2,
    queryFn: () =>
      apiJson<{ query: string; chats: Chat[] }>(
        `/chats/search?q=${encodeURIComponent(q)}` +
          (opts.workspaceId
            ? `&workspaceId=${encodeURIComponent(opts.workspaceId)}`
            : "") +
          (opts.sessionId
            ? `&sessionId=${encodeURIComponent(opts.sessionId)}`
            : "") +
          (opts.includeArchived ? "&includeArchived=1" : ""),
      ),
  });
}

export function usePatchChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      chatId: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      sessionId?: string;
    }) =>
      apiJson<{ chat: Chat }>(`/chats/${input.chatId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: input.title,
          pinned: input.pinned,
          archived: input.archived,
          sessionId: input.sessionId,
        }),
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chat(input.chatId) });
      void qc.invalidateQueries({ queryKey: ["workspaceSessions"] });
      void qc.invalidateQueries({ queryKey: ["sessionChats"] });
      void qc.invalidateQueries({ queryKey: ["chatSearch"] });
    },
  });
}

export function useChat(chatId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chat(chatId),
    enabled: enabled && Boolean(chatId),
    queryFn: () =>
      apiJson<ChatDetail & { diffs?: TurnFileDiff[] }>(`/chats/${chatId}`),
  });
}

export type ChatReplayResponse = {
  replay: import("./turn-replay").TurnReplay;
  text: string;
};

export function useChatReplay(
  chatId: string,
  streamId: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.chatReplay(chatId, streamId),
    enabled: enabled && Boolean(chatId),
    queryFn: () => {
      const q = streamId ? `?streamId=${encodeURIComponent(streamId)}` : "";
      return apiJson<ChatReplayResponse>(`/chats/${chatId}/replay${q}`);
    },
  });
}

export function useProviderCredentials(
  provider: string,
  token?: string | null,
  enabled = false,
) {
  return useQuery({
    queryKey: queryKeys.providerCredentials(provider, token),
    enabled: enabled && Boolean(provider),
    queryFn: () =>
      apiJson<{ provider: string; authKind: string; secret: string }>(
        `/providers/${provider}/credentials`,
        { headers: authHeaders(token) },
      ),
  });
}

export function useMagicLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      email: string;
      callbackURL: string;
      name: string;
    }) => {
      const { error } = await authClient.signIn.magicLink({
        email: input.email,
        callbackURL: input.callbackURL,
        newUserCallbackURL: input.callbackURL,
        name: input.name,
      });
      if (error) {
        throw new Error(error.message || "No se pudo enviar el magic link");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useSignInEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const { error } = await authClient.signIn.email({
        email: input.email.trim().toLowerCase(),
        password: input.password,
      });
      if (error) {
        throw new Error(error.message || "No se pudo iniciar sesión");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useSignUpEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      email: string;
      password: string;
      name?: string;
    }) => {
      const email = input.email.trim().toLowerCase();
      const { error } = await authClient.signUp.email({
        email,
        password: input.password,
        name: input.name || email.split("@")[0] || "Chavez user",
      });
      if (error) {
        const msg = error.message || "No se pudo crear la cuenta";
        if (/already|exists|USE_ANOTHER/i.test(msg)) {
          throw new Error(
            "Ese email ya tiene cuenta. Inicia sesión con password o magic link. Si solo usaste magic link, entra y define una contraseña.",
          );
        }
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useSetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (newPassword: string) => {
      await apiJson<{ ok: boolean }>("/me/password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut();
      if (error) {
        throw new Error(error.message || "No se pudo cerrar sesión");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useSetActiveProvider(token?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string | null) =>
      apiJson("/providers/active", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ provider }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.providers(token) });
    },
  });
}

export function useProviderPreferences(token?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      activeProvider?: string | null;
      activeModel?: string | null;
      activeEffort?: string | null;
      activeParams?: CursorParamSelection[] | null;
      activeExecutionMode?: string | null;
    }) =>
      apiJson("/providers/preferences", {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.providers(token) });
    },
  });
}

export function useLinkProvider(token?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: string;
      secret: string;
      authKind: "api_key" | "oauth_token";
    }) =>
      apiJson(`/providers/${input.provider}/credentials`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({
          authKind: input.authKind,
          secret: input.secret,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.providers(token) });
    },
  });
}

export function useUnlinkProvider(token?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      apiJson(`/providers/${provider}/credentials`, {
        method: "DELETE",
        headers: authHeaders(token),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.providers(token) });
    },
  });
}

export function useVerifyDeviceCode() {
  return useMutation({
    mutationFn: async (userCode: string) => {
      const sessionRes = await fetch(apiUrl("/api/auth/get-session"), {
        credentials: "include",
      });
      const session = await sessionRes.json().catch(() => null);
      if (!session?.user) {
        return { needsSignIn: true as const, userCode };
      }
      const verify = await fetch(
        apiUrl(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`),
        { credentials: "include" },
      );
      if (!verify.ok) {
        throw new Error("Código inválido o expirado");
      }
      return { needsSignIn: false as const, userCode };
    },
  });
}

export function useDeviceAction() {
  return useMutation({
    mutationFn: async (input: {
      action: "approve" | "deny";
      userCode: string;
    }) => {
      const path =
        input.action === "approve" ? "device/approve" : "device/deny";
      const res = await fetch(apiUrl(`/api/auth/${path}`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: input.userCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { message?: string; error?: string }).message ||
            (data as { error?: string }).error ||
            "Error",
        );
      }
      return data;
    },
  });
}

export type UserRule = {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  disallowTools: string[];
  allowTools: string[];
  createdAt: string;
  updatedAt: string;
};

export type UserSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export function useSkills(enabled = true) {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: () => apiJson<{ skills: UserSkill[] }>("/skills"),
    enabled,
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      body: string;
      enabled?: boolean;
    }) =>
      apiJson<{ skill: UserSkill }>("/skills", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      name?: string;
      description?: string;
      body?: string;
      enabled?: boolean;
    }) =>
      apiJson<{ skill: UserSkill }>(`/skills/${input.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          body: input.body,
          enabled: input.enabled,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiJson<{ ok: boolean }>(`/skills/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });
}

export type MemoryScope = "user" | "workspace";
export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  title: string;
  fact: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function useMemories(
  workspaceId: string | null | undefined,
  enabled = true,
) {
  const q = workspaceId
    ? `/memories?workspaceId=${encodeURIComponent(workspaceId)}`
    : "/memories";
  return useQuery({
    queryKey: queryKeys.memories(workspaceId ?? null),
    queryFn: () => apiJson<{ memories: MemoryRecord[] }>(q),
    enabled,
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      fact: string;
      scope: MemoryScope;
      workspaceId?: string | null;
      title?: string;
    }) =>
      apiJson<{ memory: MemoryRecord }>("/memories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["memories"] });
    },
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiJson<{ ok: boolean }>(`/memories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["memories"] });
    },
  });
}

export function useUserRules(enabled = true) {
  return useQuery({
    queryKey: queryKeys.userRules,
    queryFn: () => apiJson<{ rules: UserRule[] }>("/rules"),
    enabled,
  });
}

export function useCreateUserRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      title: string;
      body: string;
      enabled?: boolean;
      disallowTools?: string[];
      allowTools?: string[];
    }) =>
      apiJson<{ rule: UserRule }>("/rules", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.userRules });
    },
  });
}

export function usePatchUserRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      title?: string;
      body?: string;
      enabled?: boolean;
      disallowTools?: string[];
      allowTools?: string[];
    }) =>
      apiJson<{ rule: UserRule }>(`/rules/${input.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          enabled: input.enabled,
          disallowTools: input.disallowTools,
          allowTools: input.allowTools,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.userRules });
    },
  });
}

export function useDeleteUserRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiJson<{ ok: boolean }>(`/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.userRules });
    },
  });
}

export function useWorkspaceUserRulesEnabled(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userRulesEnabled: boolean) =>
      apiJson(`/workspaces/${workspaceId}/preferences`, {
        method: "PUT",
        body: JSON.stringify({ userRulesEnabled }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      void qc.invalidateQueries({
        queryKey: queryKeys.workspaceSessions(workspaceId),
      });
    },
  });
}

export function useChatExport() {
  return useMutation({
    mutationFn: (input: { chatId: string; format: "md" | "json" }) =>
      apiJson<Record<string, unknown> | { markdown: string }>(
        `/chats/${input.chatId}/export?format=${input.format}`,
      ),
  });
}

export function useChatImport(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (document: unknown) =>
      apiJson<{ chat: Chat }>(`/sessions/${sessionId}/chats/import`, {
        method: "POST",
        body: JSON.stringify(document),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessionChats(sessionId) });
    },
  });
}

export function useChatShare(chatId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chatShare(chatId),
    enabled: enabled && Boolean(chatId),
    queryFn: () =>
      apiJson<{ token: string; url: string; createdAt: string }>(
        `/chats/${chatId}/share`,
      ),
    retry: false,
  });
}

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      apiJson<{ token: string; url: string; createdAt: string }>(
        `/chats/${chatId}/share`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: (_d, chatId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatShare(chatId) });
    },
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      apiJson<{ revoked: true }>(`/chats/${chatId}/share`, { method: "DELETE" }),
    onSuccess: (_d, chatId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatShare(chatId) });
    },
  });
}

export function useShareView(token: string) {
  return useQuery({
    queryKey: queryKeys.shareView(token),
    enabled: Boolean(token),
    queryFn: () =>
      apiJson<{
        title: string;
        createdAt: string;
        messages: ChatMessage[];
        banner: string;
      }>(`/share/${encodeURIComponent(token)}`),
    retry: false,
  });
}

export function formatQueryError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return "No autorizado — inicia sesión o pasa ?token= del CLI";
    }
    if (err.status === 0) return err.message;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Error desconocido";
}
