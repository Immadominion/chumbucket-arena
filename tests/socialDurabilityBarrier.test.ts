import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { callsRouter } from "../src/api/calls.ts";
import { buildCallsRuntime, setCallsRuntime } from "../src/calls/runtime.ts";
import { SupabaseCallsStore } from "../src/calls/supabaseStore.ts";
import { WriteQueue } from "../src/prediction/pgrest.ts";
import { harness, market, person } from "./socialCallsFixtures.ts";

const marketId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function rig(fetchImpl: typeof fetch) {
  const h = harness({ markets: [market(marketId)] });
  const id = crypto.randomUUID();
  const store = new SupabaseCallsStore({
    config: { supabaseUrl: "https://test.invalid", serviceRoleKey: "test-only", network: "devnet" },
    queue: new WriteQueue({ onFailure: () => {} }), fetchImpl, clock: h.clock,
  });
  store.upsertPerson(person(id, { walletAddress: null }));
  const app = await createApp({ config: loadConfig({}) });
  setCallsRuntime(app.config, buildCallsRuntime(app.config, {
    config: h.rt.config, store, markets: h.rt.markets, clock: h.clock, viewer: { resolve: async () => id },
  }));
  return { store, caller: callsRouter.createCaller({ app }) };
}

test("create and concurrent feed both wait for the database acknowledgement", async () => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(r => start = r);
  const blocked = new Promise<void>(r => release = r);
  const r = await rig((async () => { start(); await blocked; return Response.json([]); }) as unknown as typeof fetch);
  let acknowledged = false;
  const creating = r.caller.calls.create({ marketId, side: "YES" }).then(x => { acknowledged = true; return x; });
  await started;
  let distributed = false;
  const reading = r.caller.calls.feed({ mode: "global" }).then(x => { distributed = true; return x; });
  await new Promise(r => setTimeout(r, 5));
  expect(acknowledged).toBe(false);
  expect(distributed).toBe(false);
  release();
  expect((await creating).call.fundingState).toBe("NONE");
  expect((await reading).entries).toHaveLength(1);
});

test("rejected persistence cannot be acknowledged or exposed later from the mirror", async () => {
  const r = await rig((async () => Response.json({ code: "P0001", message: "database refused" }, { status: 400 })) as unknown as typeof fetch);
  await expect(r.caller.calls.create({ marketId, side: "YES" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(r.store.failures.length).toBeGreaterThan(0);
  expect(r.store.failures[0]!.sqlState).toBe("P0001");
  await expect(r.caller.calls.feed({ mode: "global" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  await expect(r.caller.calls.get({ callId: r.store.listCalls()[0]!.id })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});

test("a follow is not acknowledged until its canonical edge is durable", async () => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => start = resolve);
  const blocked = new Promise<void>(resolve => release = resolve);
  const r = await rig((async () => {
    start();
    await blocked;
    return Response.json([]);
  }) as unknown as typeof fetch);
  const target = crypto.randomUUID();
  r.store.upsertPerson(person(target, { walletAddress: null }));
  let acknowledged = false;
  const following = r.caller.people.follow({ personRef: target }).then(state => {
    acknowledged = true;
    return state;
  });
  await started;
  expect(acknowledged).toBe(false);
  release();
  expect(await following).toEqual({ personId: target, following: true });
  expect(acknowledged).toBe(true);
});
