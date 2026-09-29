import { expect, test } from "bun:test";
import { SupabaseExistingAccountStore } from "../src/auth/ExistingAccountStore.ts";
import { SupabaseIdentityStore } from "../src/auth/IdentityStore.ts";
import { GoTrueJwtVerifier } from "../src/auth/SupabaseJwt.ts";

const subject = "10000000-0000-4000-8000-000000000001";
const person = "20000000-0000-4000-8000-000000000001";
const token = `synthetic.${Buffer.from(JSON.stringify({ sub: subject, exp: 9999999999 })).toString('base64url')}.synthetic`;
const binding = { authUserId: subject, walletAddress: "1".repeat(32), network: "devnet" as const,
  nonceHash: "a".repeat(64), messageHash: "b".repeat(64) };

for (const status of [301, 302, 307, 308]) {
  for (const action of ["verify", "whoami", "profile", "claim"] as const) {
    test(`identity ${action} refuses HTTP ${status} without forwarding credentials`, async () => {
      let reached = 0;
      const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        reached++;
        return Response.json(action === "verify" ? { id: subject }
          : action === "whoami" ? [{ id: person }]
          : action === "profile" ? person : { ok: true, user_id: person, outcome: "claimed" });
      }});
      const origin = Bun.serve({ hostname: "127.0.0.1", port: 0,
        fetch: () => new Response(null, { status, headers: { location: `http://127.0.0.1:${sink.port}/sink` } }) });
      const config = { supabaseUrl: `http://127.0.0.1:${origin.port}`, serviceRoleKey: "synthetic-server-only", network: "devnet" as const };
      let refused = false;
      try {
        if (action === "verify") refused = await new GoTrueJwtVerifier(config).verify(token) === null;
        else if (action === "whoami") await new SupabaseIdentityStore(config).userIdForAuthUser(subject);
        else if (action === "profile") await new SupabaseIdentityStore(config).createPersonForAuthUser(subject, "Synthetic");
        else await new SupabaseExistingAccountStore(config).claim(binding);
      } catch (error) {
        refused = true;
        expect(error).toMatchObject({ code: "IDENTITY_STORE_ERROR" });
      } finally { origin.stop(true); sink.stop(true); }
      expect(reached).toBe(0);
      expect(refused).toBe(true);
    });
  }
}

for (const action of ["verify", "whoami", "profile", "claim"] as const) {
  for (const kind of ["throw", "json"] as const) {
    test(`identity ${action} sanitizes ${kind} failures and bounds the request`, async () => {
      let bounded = false;
      const fetcher = (async (_url: unknown, init?: RequestInit) => {
        bounded = init?.signal instanceof AbortSignal;
        if (kind === "throw") throw new Error("synthetic-private-provider-error");
        return new Response("synthetic-private-provider-error");
      }) as typeof fetch;
      const config = { supabaseUrl: "https://test.invalid", serviceRoleKey: "synthetic-server-only", network: "devnet" as const };
      let caught: unknown;
      try {
        if (action === "verify") await new GoTrueJwtVerifier(config, fetcher).verify(token);
        else if (action === "whoami") await new SupabaseIdentityStore(config, fetcher).userIdForAuthUser(subject);
        else if (action === "profile") await new SupabaseIdentityStore(config, fetcher).createPersonForAuthUser(subject, "Synthetic");
        else await new SupabaseExistingAccountStore(config, fetcher).claim(binding);
      } catch (error) { caught = error; }
      // Boolean assertions cannot echo a thrown credential-bearing payload.
      expect(String(caught).includes("synthetic-private")).toBe(false);
      expect(caught).toMatchObject({ code: "IDENTITY_STORE_ERROR" });
      expect(bounded).toBe(true);
    });
  }
}
