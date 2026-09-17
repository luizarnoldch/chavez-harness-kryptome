import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WsProvider } from "../lib/ws-context";
import { NotificationProvider } from "../lib/notification-context";
import { NotificationHost } from "./NotificationHost";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) => {
          const status =
            error && typeof error === "object" && "status" in error
              ? Number((error as { status: number }).status)
              : undefined;
          if (status === 401 || status === 403 || status === 404) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function AppProviders({
  children,
  notifications = true,
}: {
  children: ReactNode;
  notifications?: boolean;
}) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <WsProvider>
        <NotificationProvider enabled={notifications}>
          {notifications ? <NotificationHost /> : null}
          {children}
        </NotificationProvider>
      </WsProvider>
    </QueryClientProvider>
  );
}
