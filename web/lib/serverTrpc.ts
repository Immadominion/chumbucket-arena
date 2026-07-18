/**
 * Server-side tRPC client for React Server Components (public queries only — no
 * auth token). Used by the shareable public Dossier at /p/[wallet].
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@server/api/router";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://chumbucket-arena-production.up.railway.app";

export const serverTrpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: BACKEND_URL, transformer: superjson })],
});
