import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { signedMessageHash, validateSignedPantaTransaction } from "../src/prediction/PantaChain.ts";
import { walletAmendmentRefusal } from "../src/prediction/walletAmendment.ts";
import { amendmentCases, amendOwner, reviewedPayload, signedAsReviewed, walletAmended } from "./walletAmendmentFixtures.ts";

const reviewed = reviewedPayload();
const reviewedTx = VersionedTransaction.deserialize(Buffer.from(reviewed, "base64"));
const reviewedHash = createHash("sha256").update(reviewedTx.message.serialize()).digest("hex");
const owner = amendOwner.publicKey.toBase58();

for (const [name, payload, accepted] of amendmentCases(reviewed)) {
  test(`wallet amendment: ${name} -> ${accepted ? "accepted" : "refused"}`, () => {
    const attempt = () => validateSignedPantaTransaction(payload, owner, reviewedHash, reviewed);
    if (accepted) {
      const tx = attempt();
      expect(tx.messageHash).toBe(signedMessageHash(payload));
      expect(Buffer.from(tx.bytes).toString("base64")).toBe(payload);
    } else expect(attempt).toThrow("Wallet approval does not match");
  });
}

test("Solflare's amendment really is a different message, and only the reviewed bytes let it through", () => {
  const amended = walletAmended(reviewed);
  expect(signedMessageHash(amended)).not.toBe(reviewedHash);
  // Without the reviewed bytes the rule stays exact-match only (market creation, transfers).
  expect(() => validateSignedPantaTransaction(amended, owner, reviewedHash)).toThrow("Wallet approval does not match");
  expect(validateSignedPantaTransaction(signedAsReviewed(reviewed), owner, reviewedHash).messageHash).toBe(reviewedHash);
  // The reviewed bytes must themselves be the reviewed message.
  const otherTx = VersionedTransaction.deserialize(Buffer.from(reviewed, "base64"));
  otherTx.message.recentBlockhash = otherTx.message.staticAccountKeys[2]!.toBase58();
  const other = Buffer.from(otherTx.serialize()).toString("base64");
  expect(other).not.toBe(reviewed);
  expect(() => validateSignedPantaTransaction(amended, owner, reviewedHash, other)).toThrow("Wallet approval does not match");
  // And the owner must be the one who signed.
  expect(() => validateSignedPantaTransaction(amended, VersionedTransaction.deserialize(Buffer.from(reviewed, "base64")).message.staticAccountKeys[1]!.toBase58(), reviewedHash, reviewed)).toThrow();
});

test("the refusal names what changed", () => {
  const message = (payload: string) => VersionedTransaction.deserialize(Buffer.from(payload, "base64")).message;
  const cases = Object.fromEntries(amendmentCases(reviewed).map(([name, payload]) => [name, walletAmendmentRefusal(reviewedTx.message, message(payload))]));
  expect(cases["Solflare: priority fee in front, Lighthouse checks after"]).toBeNull();
  expect(cases["buy amount changed"]).toBe("reviewed instructions changed");
  expect(cases["SOL transfer added"]).toBe("reviewed instructions changed");
  expect(cases["Lighthouse MemoryWrite"]).toBe("Lighthouse instruction is not an assertion");
  expect(cases["fee above the 0.001 SOL ceiling"]).toBe("wallet priority fee above the ceiling");
  expect(cases["recent blockhash changed"]).toBe("recent blockhash changed");
});
