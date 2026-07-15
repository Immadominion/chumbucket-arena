import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { SqliteEventStore } from "../src/core/eventstore/SqliteEventStore.ts";
import { ReadModel } from "../src/core/projections/ReadModel.ts";
import { DomainError } from "../src/domain/errors.ts";
import { asWallet, playerStream, wal } from "../src/domain/ids.ts";

const PATH = "./data/test-events.sqlite";
const cleanup = () => {
  for (const ext of ["", "-wal", "-shm"]) rmSync(PATH + ext, { force: true });
};
cleanup();
afterAll(cleanup);

describe("SqliteEventStore", () => {
  test("the log survives a restart and projections rebuild from it", async () => {
    const w = asWallet("0xpersist");

    // First process: write some events, then "crash" (close).
    const s1 = new SqliteEventStore(PATH);
    await s1.append(playerStream(w), [{ type: "PlayerSigned", wallet: w }]);
    await s1.append(playerStream(w), [{ type: "Deposited", amount: wal(50) }], { expectedVersion: 1 });
    s1.close();

    // Second process: reopen the same file, replay into a fresh read model.
    const s2 = new SqliteEventStore(PATH);
    const rm = new ReadModel();
    await rm.hydrate(s2);
    expect(rm.getDossier(w)?.balance).toBe(wal(50));
    expect((await s2.readAll()).length).toBe(2);
    s2.close();
  });

  test("optimistic concurrency rejects a stale expectedVersion", async () => {
    const w = asWallet("0xconflict");
    const s = new SqliteEventStore(PATH);
    await s.append(playerStream(w), [{ type: "PlayerSigned", wallet: w }]);
    // stream is at v1; appending as if it were still v0 must conflict
    await expect(
      s.append(playerStream(w), [{ type: "Deposited", amount: wal(1) }], { expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(DomainError);
    s.close();
  });

  test("readStream returns one stream in version order", async () => {
    const a = asWallet("0xstreama");
    const b = asWallet("0xstreamb");
    const s = new SqliteEventStore(PATH);
    await s.append(playerStream(a), [{ type: "PlayerSigned", wallet: a }]);
    await s.append(playerStream(b), [{ type: "PlayerSigned", wallet: b }]);
    await s.append(playerStream(a), [{ type: "Deposited", amount: wal(5) }], { expectedVersion: 1 });

    const streamA = await s.readStream(playerStream(a));
    expect(streamA.map((e) => e.meta.version)).toEqual([0, 1]);
    expect(streamA.map((e) => e.payload.type)).toEqual(["PlayerSigned", "Deposited"]);
    s.close();
  });
});
