"use client";

/**
 * Client providers: Privy (auth + Solana embedded wallet) → React Query → typed
 * tRPC client pointed at the live backend. The Privy access token is attached to
 * every tRPC call (HTTP header + WS connectionParams); the backend's PrivyAuth
 * verifies it and resolves the player's Solana wallet.
 */

import { useRef, useState } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@server/api/router";
import { TRPCProvider } from "@/lib/trpc";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://chumbucket-arena-production.up.railway.app";
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "cmqn0pa6s00240djp985c7mp8";
const WS_URL = BACKEND_URL.replace(/^http/, "ws");

function TRPCStack({ children }: { children: React.ReactNode }) {
  // getAccessToken is stable from Privy; keep a ref so the links always read the
  // current token at request time (including before/after login).
  const { getAccessToken } = usePrivy();
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;

  const authHeader = async (): Promise<Record<string, string>> => {
    try {
      const t = await tokenRef.current?.();
      return t ? { authorization: `Bearer ${t}` } : {};
    } catch {
      return {};
    }
  };

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Longer cache + keep previous data so navigating between screens shows
          // cached content instantly and refetches quietly in the background.
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, placeholderData: keepPreviousData },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: wsLink({
            transformer: superjson,
            client: createWSClient({
              url: WS_URL,
              lazy: { enabled: true, closeMs: 10_000 },
              connectionParams: async () => {
                try {
                  const t = await tokenRef.current?.();
                  return t ? { token: t } : {};
                } catch {
                  return {};
                }
              },
            }),
          }),
          false: httpBatchLink({ url: BACKEND_URL, transformer: superjson, headers: authHeader }),
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "twitter", "wallet"],
        appearance: { theme: "light", accentColor: "#F2385A", logo: "/img/logo.png" },
        // The player's Solana wallet is provisioned + custodied server-side (PrivyAuth
        // on the backend resolves it from the Privy user id), so no client-side
        // embedded-wallet creation is needed here.
      }}
    >
      <TRPCStack>{children}</TRPCStack>
    </PrivyProvider>
  );
}
