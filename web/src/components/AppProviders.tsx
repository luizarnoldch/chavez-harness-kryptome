import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WsProvider } from "../lib/ws-context";

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

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <WsProvider>{children}</WsProvider>
    </QueryClientProvider>
  );
}
