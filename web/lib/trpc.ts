/**
 * Typed tRPC client, bound to the backend's AppRouter. The router type is
 * imported (type-only, erased at runtime) from the sibling backend in the
 * monorepo, so the whole API is end-to-end typed with zero codegen.
 */
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@server/api/router";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
