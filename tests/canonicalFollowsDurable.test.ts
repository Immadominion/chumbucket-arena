import { expect, test } from "bun:test";
import { SupabaseCallsStore } from "../src/calls/supabaseStore.ts";
import { PgrestFake, seedUser, UUIDS } from "./pgrestFake.ts";

test("walletless canonical follows survive restart alongside legacy edges", async () => {
  const fake = new PgrestFake();
  for (const id of Object.values(UUIDS)) seedUser(fake, id, { wallet: null });
  fake.seed("follows", {
    network: "devnet", follower_wallet: "legacy-alice", followee_wallet: "legacy-bob",
    follower_user_id: UUIDS.alice, followee_user_id: UUIDS.bob,
    created_at: new Date().toISOString(),
  });
  const first = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl });
  await first.hydrate();
  expect(first.followingOf(UUIDS.alice)).toEqual([UUIDS.bob]);

  first.follow(UUIDS.alice, UUIDS.carol);
  await first.flush();
  expect(fake.rows("person_follows")).toMatchObject([{
    follower_user_id: UUIDS.alice, followee_user_id: UUIDS.carol,
  }]);
  expect(fake.log.some(r => r.table === "follows" && r.method === "POST")).toBe(false);

  const restored = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl });
  await restored.hydrate();
  expect(restored.followingOf(UUIDS.alice).sort()).toEqual([UUIDS.bob, UUIDS.carol]);
  restored.unfollow(UUIDS.alice, UUIDS.bob);
  await restored.flush();
  expect(fake.rows("follows")).toHaveLength(0);
  expect(fake.rows("person_follows")).toHaveLength(1);

  const again = new SupabaseCallsStore({ config: fake.config, fetchImpl: fake.fetchImpl });
  await again.hydrate();
  expect(again.followingOf(UUIDS.alice)).toEqual([UUIDS.carol]);
  again.unfollow(UUIDS.alice, UUIDS.carol);
  await again.flush();
  expect(fake.rows("person_follows")).toHaveLength(0);
  expect(fake.rows("follows")).toHaveLength(0);
});
