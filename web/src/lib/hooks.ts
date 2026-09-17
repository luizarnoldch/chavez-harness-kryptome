import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiJson, apiUrl, authHeaders } from "./api";
import { authClient } from "./auth-client";
import { queryKeys } from "./query-keys";

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
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type Connection = {
  connectionId?: string;
  id?: string;
  workspaceId?: string | null;
  path?: string | null;
  clientKind?: "client" | "daemon";
  hostname?: string | null;
  connectedAt?: string;
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
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  recentMessages?: ChatMessage[];
};

export type WorkspaceSessionOverview = AgentSession & {
  chats: Chat[];
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
    queryFn: async () => {
      const data = await apiJson<{ workspaces: Workspace[] }>("/workspaces");
      return data.workspaces ?? [];
    },
  });
}

export function useConnections(enabled = true) {
  return useQuery({
    queryKey: queryKeys.connections,
    enabled,
    queryFn: async () => {
      const data = await apiJson<{ connections: Connection[] }>("/connections");
      return data.connections ?? [];
    },
  });
}

export function useWorkspaceSessions(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceSessions(workspaceId),
    enabled: enabled && Boolean(workspaceId),
    queryFn: async () => {
      const data = await apiJson<{
        workspace: Workspace;
        sessions: WorkspaceSessionOverview[];
        openConnections: number;
      }>(`/workspaces/${workspaceId}/sessions`);
      return data;
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

export function useSessionChats(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sessionChats(sessionId),
    enabled: enabled && Boolean(sessionId),
    queryFn: async () => {
      const data = await apiJson<{ sessionId: string; chats: Chat[] }>(
        `/sessions/${sessionId}/chats`,
      );
      return data.chats ?? [];
    },
  });
}

export function useChat(chatId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chat(chatId),
    enabled: enabled && Boolean(chatId),
    queryFn: () =>
      apiJson<{ chat: Chat; messages: ChatMessage[] }>(`/chats/${chatId}`),
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
