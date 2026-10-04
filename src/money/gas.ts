/**
 * Gas stays invisible: whether a wallet's SOL pays for what it is about to
 * sign, and if not, the gasless USDC→SOL swap (src/solTopUp) to run first.
 * Never asks the person for SOL.
 *
 * The need is mainnet's own numbers (src/solTopUp/need.ts): a Panta buy
 * costs one fee plus, for a new position, its account's rent; a USDC transfer
 * costs one fee plus, when the destination has no USDC account, that
 * account's rent. The wallet itself must stay rent-exempt after paying.
 */
import type { DepositPerson } from "../deposits/accounts.ts";
import { solNeed, tradesCovered, TRADE_FEE_ALLOWANCE_LAMPORTS, type RentReader } from "../solTopUp/need.ts";
import type { SolTopUpService } from "../solTopUp/service.ts";
import { MoneyError } from "./errors.ts";

export type GasAnswer =
  | { needsSol: false }
  | { needsSol: true; topUp: { amountBaseUnits: string } | null };

export interface GasPort {
  forTrade(person: DepositPerson, wallet: string, lamports: bigint): Promise<GasAnswer>;
  /** `extraLamports`: rent the transfer pays on top of its fee (a new USDC account). */
  forTransfer(person: DepositPerson, wallet: string, lamports: bigint, extraLamports: bigint): Promise<GasAnswer>;
}

/** An SPL token account's size: the rent a new destination USDC account costs. */
export const TOKEN_ACCOUNT_BYTES = 165;

export class MoneyGas implements GasPort {
  constructor(private readonly deps: { rent: RentReader | null; topUp: () => SolTopUpService | null }) {}

  private rent(): RentReader {
    if (!this.deps.rent) throw new MoneyError("UNAVAILABLE", "We couldn't check network fees just now. Nothing was signed. Try again in a moment.");
    return this.deps.rent;
  }

  async forTrade(person: DepositPerson, wallet: string, lamports: bigint): Promise<GasAnswer> {
    const need = await solNeed(this.rent());
    if (tradesCovered(lamports, need) >= 1) return { needsSol: false };
    return { needsSol: true, topUp: await this.topUp(person, wallet) };
  }

  async forTransfer(person: DepositPerson, wallet: string, lamports: bigint, extraLamports: bigint): Promise<GasAnswer> {
    const floor = await this.rent().minimumBalance(0);
    if (lamports >= floor + TRADE_FEE_ALLOWANCE_LAMPORTS + extraLamports) return { needsSol: false };
    return { needsSol: true, topUp: await this.topUp(person, wallet) };
  }

  /** The swap src/solTopUp would suggest for this wallet, or its usual amount; null when swaps are off. */
  private async topUp(person: DepositPerson, wallet: string): Promise<{ amountBaseUnits: string } | null> {
    const service = this.deps.topUp();
    if (!service) return null;
    try {
      const plan = await service.plan(person, wallet);
      if (plan.suggestion) return { amountBaseUnits: plan.suggestion.amountBaseUnits };
    } catch { /* the usual amount below */ }
    return { amountBaseUnits: service.config.targetUsdcBaseUnits.toString() };
  }
}
