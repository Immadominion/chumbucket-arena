/**
 * Client state for the Arena web app (Privy session, React Query, tRPC and the
 * Chumbucket session). Only the routes that need it mount it: the (app)
 * group, /signin and legacy /c/chg_… challenge links. The public site (the
 * landing page, share pages, legal pages) stays free of this JavaScript and of
 * its Privy and Supabase configuration.
 */

import Providers from "@/components/Providers";
import { SessionProvider } from "@/lib/session";

export default function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <SessionProvider>{children}</SessionProvider>
    </Providers>
  );
}
