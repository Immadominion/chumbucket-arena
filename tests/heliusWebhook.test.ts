import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "bun:test";
import { extractArenaInstructions } from "../src/indexer/ArenaInstructionParser.ts";
import { extractHeliusTxSightings, handleHeliusWebhook } from "../src/indexer/HeliusWebhook.ts";

describe("Helius webhook parsing", () => {
  test("extracts signatures from array payloads", () => {
    const sightings = extractHeliusTxSightings([
      { signature: "sig-a", slot: 10 },
      { transactionSignature: "sig-b", transactionSlot: 11 },
      { txSignature: "sig-c" },
      { nope: true },
    ]);

    expect(sightings.map((s) => s.signature)).toEqual(["sig-a", "sig-b", "sig-c"]);
    expect(sightings[0]!.slot).toBe(10);
    expect(sightings[1]!.slot).toBe(11);
    expect(sightings[2]!.slot).toBeUndefined();
  });

  test("extracts signatures from wrapped transaction payloads", () => {
    const sightings = extractHeliusTxSightings({
      transactions: [
        { transaction: { signature: "nested-a", slot: 20 } },
        { signature: "top-level-wins", transaction: { signature: "nested-b", slot: 21 } },
      ],
    });

    expect(sightings).toHaveLength(2);
    expect(sightings[0]!.signature).toBe("nested-a");
    expect(sightings[0]!.slot).toBe(20);
    expect(sightings[1]!.signature).toBe("top-level-wins");
  });
});

describe("Arena instruction parsing", () => {
  test("decodes place_call discriminator, accounts, bucket, and amount", () => {
    const data = Buffer.from([
      11, 8, 17, 8, 195, 166, 211, 69,
      2,
      0x40, 0x42, 0x0f, 0, 0, 0, 0, 0,
    ]).toString("base64");

    const parsed = extractArenaInstructions({
      instructions: [
        {
          programId: "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG",
          data,
          accounts: ["player", "pot", "vault", "player-usdc", "position", "token", "system"],
        },
      ],
    });

    expect(parsed).toEqual([
      {
        name: "place_call",
        programId: "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG",
        accounts: ["player", "pot", "vault", "player-usdc", "position", "token", "system"],
        namedAccounts: {
          player: "player",
          pot: "pot",
          vault: "vault",
          player_usdc: "player-usdc",
          position: "position",
          token_program: "token",
          system_program: "system",
        },
        args: { bucket: 2, amount: "1000000" },
      },
    ]);
  });
});

describe("Helius webhook handler", () => {
  test("requires the configured shared secret", async () => {
    const res = responseSpy();
    await handleHeliusWebhook(
      {
        config: { indexer: { heliusWebhookAuth: "secret" } },
        social: { confirmPredictionSignature: async () => ({ ok: true }) },
      } as never,
      requestSpy([{ signature: "sig-a" }]),
      res as never,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "unauthorized" });
  });

  test("confirms each observed signature through the social store", async () => {
    const calls: unknown[] = [];
    const res = responseSpy();
    await handleHeliusWebhook(
      {
        config: { indexer: { heliusWebhookAuth: "secret" } },
        social: {
          confirmPredictionSignature: async (input: unknown) => {
            calls.push(input);
            return { ok: true, result: { positionsUpdated: 1 } };
          },
        },
      } as never,
      requestSpy([{ signature: "sig-a", slot: 123 }, { transactionSignature: "sig-b" }], {
        "x-helius-auth": "secret",
      }),
      res as never,
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        source: "helius",
        txSignature: "sig-a",
        slot: 123,
        payload: { signature: "sig-a", slot: 123 },
      },
      {
        source: "helius",
        txSignature: "sig-b",
        payload: { transactionSignature: "sig-b" },
      },
    ]);
    expect(JSON.parse(res.body).seen).toBe(2);
  });

  test("stores parsed arena instructions with the raw webhook sighting", async () => {
    const calls: Array<{ payload?: unknown }> = [];
    const res = responseSpy();
    const data = Buffer.from([
      11, 8, 17, 8, 195, 166, 211, 69,
      0,
      0x80, 0x84, 0x1e, 0, 0, 0, 0, 0,
    ]).toString("base64");

    await handleHeliusWebhook(
      {
        config: { indexer: { heliusWebhookAuth: "secret" } },
        social: {
          confirmPredictionSignature: async (input: { payload?: unknown }) => {
            calls.push(input);
            return { ok: true };
          },
        },
      } as never,
      requestSpy([{ signature: "sig-a", instructions: [{ programId: "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG", data }] }], {
        authorization: "Bearer secret",
      }),
      res as never,
    );

    expect(res.status).toBe(200);
    expect(calls[0]!.payload).toMatchObject({
      signature: "sig-a",
      arenaInstructions: [
        {
          name: "place_call",
          args: { bucket: 0, amount: "2000000" },
        },
      ],
    });
  });
});

function requestSpy(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string> };
  req.headers = headers;
  return req as unknown as IncomingMessage;
}

function responseSpy() {
  return {
    status: 0,
    body: "",
    headersSent: false,
    writeHead(status: number) {
      this.status = status;
      this.headersSent = true;
    },
    end(body: string) {
      this.body = body;
    },
  };
}
