/**
 * Writes the wallet-amendment vectors the app's tests check against, so the
 * phone and this API accept exactly the same wallet-app rewrites.
 *
 *   bun run scripts/wallet-amendment-vectors.ts > ../chumbucket-social-calls/test/fixtures/wallet_amendment_vectors.json
 */
import { amendmentCases, amendOwner, reviewedPayload } from "../tests/walletAmendmentFixtures.ts";

const reviewed = reviewedPayload();
console.log(JSON.stringify({
  source: "chumbucket-social-calls-api/scripts/wallet-amendment-vectors.ts",
  owner: amendOwner.publicKey.toBase58(),
  reviewed,
  cases: amendmentCases(reviewed).map(([name, payload, accepted, messageAccepted]) =>
    ({ name, payload, accepted, messageAccepted: messageAccepted ?? accepted })),
}, null, 2));
