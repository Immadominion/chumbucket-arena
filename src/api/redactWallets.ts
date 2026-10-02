/**
 * No social payload names anybody's wallet (M2).
 *
 * The person directory keeps `walletAddress` server-side (it maps a wallet
 * credential to a canonical person), and the live feed used to put it on every
 * author, linking each person to their on-chain holdings. This walks a
 * response and returns a COPY in which every person-shaped object
 * ({ id, handle, displayName, walletAddress }) carries `walletAddress: null`.
 * Self included: a person reads their own wallet from `account.me`.
 *
 * It copies rather than mutates, because services hand back objects that may
 * be the in-process mirror's own.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isPersonShaped = (o: Record<string, unknown>): boolean =>
  "walletAddress" in o && typeof o.id === "string" && typeof o.handle === "string" && typeof o.displayName === "string";

export function redactWallets<T>(value: T, depth = 0): T {
  if (depth > 32) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = redactWallets(v, depth + 1);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? out : value) as T;
  }
  if (!isPlainObject(value)) return value;
  let copy: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value)) {
    const r = redactWallets(v, depth + 1);
    if (r !== v) (copy ??= { ...value })[k] = r;
  }
  if (isPersonShaped(value) && (value.walletAddress !== null || !("avatarId" in value))) {
    copy ??= { ...value };
    copy.walletAddress = null;
    if (!("avatarId" in copy)) copy.avatarId = null;
  }
  return (copy ?? value) as T;
}
