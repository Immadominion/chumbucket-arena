import { describe, expect, test } from "bun:test";
import { SupabaseSocialStore } from "../src/social/SocialStore.ts";

describe("SupabaseSocialStore", () => {
  test("records prediction calls through the PostgREST RPC shape", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify("position-1"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const store = new SupabaseSocialStore(
      {
        supabaseUrl: "https://example.supabase.co/",
        serviceRoleKey: "service-role",
        network: "devnet",
      },
      fetchImpl as typeof fetch,
    );

    const result = await store.recordPredictionCall({
      wallet: "wallet123",
      matchId: "fixture-1",
      marketId: "RESULT",
      bucket: "HOME",
      stakeBaseUnits: "1000000",
      txSignature: "sig123",
      metadata: { home: "A", away: "B" },
    });

    expect(result).toEqual({ ok: true, positionId: "position-1" });
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/record_prediction_call");
    expect(requests[0]!.init?.method).toBe("POST");
    expect((requests[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer service-role");
    expect(JSON.parse(requests[0]!.init?.body as string)).toEqual({
      p_network: "devnet",
      p_wallet_address: "wallet123",
      p_match_id: "fixture-1",
      p_market_id: "RESULT",
      p_bucket: "HOME",
      p_stake_base_units: "1000000",
      p_tx_signature: "sig123",
      p_position_address: null,
      p_slot: null,
      p_metadata: { home: "A", away: "B" },
    });
  });

  test("confirms prediction signatures through an idempotent RPC", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ positionsUpdated: 1, activityUpdated: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const store = new SupabaseSocialStore(
      {
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "service-role",
        network: "devnet",
      },
      fetchImpl as typeof fetch,
    );

    const result = await store.confirmPredictionSignature({
      source: "helius",
      txSignature: "sig123",
      slot: 42,
      payload: { type: "ENHANCED_TRANSACTION" },
    });

    expect(result.ok).toBe(true);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/confirm_prediction_signature");
    expect(JSON.parse(requests[0]!.init?.body as string)).toEqual({
      p_network: "devnet",
      p_source: "helius",
      p_tx_signature: "sig123",
      p_slot: 42,
      p_payload: { type: "ENHANCED_TRANSACTION" },
    });
  });

  test("queries positions with wallet and network filters", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify([]), { status: 200 });
    };
    const store = new SupabaseSocialStore(
      {
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "service-role",
        network: "mainnet-beta",
      },
      fetchImpl as typeof fetch,
    );

    await store.myPositions("wallet123", 25);

    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/rest/v1/prediction_positions");
    expect(url.searchParams.get("network")).toBe("eq.mainnet-beta");
    expect(url.searchParams.get("wallet_address")).toBe("eq.wallet123");
    expect(url.searchParams.get("order")).toBe("placed_at.desc");
    expect(url.searchParams.get("limit")).toBe("25");
  });
});
