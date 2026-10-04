# Account linking and fold: switches

One account, many sign-in methods (Settings → Sign-in methods; the
`auth.signInMethods`, `auth.unlinkSignIn`, `auth.startSignInLink`,
`auth.previewSignInLink`, `auth.completeSignInLink` procedures; the
`20261004120000_account_sign_ins.sql` functions). Two switches:

| env | default | meaning |
|---|---|---|
| `ACCOUNT_LINKING_ENABLED` | off | link and unlink sign-ins; an additional sign-in, or a linked wallet's sign-in, lands on its account |
| `ACCOUNT_FOLD_ENABLED` | off | a sign-in already on another account can fold that account in, with proof of both (needs linking) |

Each takes `true` (every account), `admins` (only the accounts in
`TRUST_ADMIN_USER_IDS`), or anything else (off). Unknown values are off.

With `admins`, every decision is per account, from the account the one
resolver gives for the session:
- an additional sign-in reaches its account only if linking is on for that
  account; for any other account it resolves exactly as with linking off (no
  account), and a linked wallet's first sign-in binds nothing for it (the
  BFF reads whose wallet it is before `resolve_wallet_sign_in_v1`);
- `auth.signInMethods` answers `linking`/`fold` for the caller's account, and
  `auth.identityStatus` for the session in the `Authorization` header (with
  none, as flag-off);
- start/unlink refuse a non-admin (or a session with no account) with
  `ACCOUNT_LINKING_DISABLED`, as when off; preview/complete decide by the
  ticket's own account, and fold is allowed only if fold is on for it;
- linking a wallet skips the other-account check for non-admins, exactly the
  pre-linking path.

The store reads additional sign-ins whenever linking is not off (so admins'
links work); the per-account rule above decides whether one counts.
