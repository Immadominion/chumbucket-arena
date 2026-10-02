/**
 * Deterministic SYNTHETIC market-creation fixtures. No credentials, no network,
 * no real venue evidence: the "create transaction" is shaped from Panta's docs
 * (an unsigned v0 tx paid and signed by the creator, invoking the program) and
 * the Panta API is a scripted function. Nothing here is a live observation.
 */
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import { PANTA_MAINNET_PROGRAM_ID } from "../src/prediction/PantaTradingRuntime.ts";
import type { CoverUpload, CreatePath, CreateRequest } from "../src/marketCreation/PantaMarketCreator.ts";
import { MarketCreationError } from "../src/marketCreation/errors.ts";

export const creator = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const wallet = creator.publicKey.toBase58();
export const program = PANTA_MAINNET_PROGRAM_ID;
export const synthetic = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
export const eventPda = synthetic(3);
export const blockhash = synthetic(4);
export const marketConfig = synthetic(5);
export const vaultAuthority = synthetic(6);
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const ata = (owner: string) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),
  new PublicKey(TOKEN).toBuffer(), new PublicKey(MAINNET_USDC_MINT).toBuffer()], new PublicKey(ATA))[0].toBase58();
export const COVER_URL = "https://res.cloudinary.com/synthetic/image/upload/v1/balr-market/events/usr_test/cover.png";
export const FEE = "50000000";

const meta = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey: new PublicKey(pubkey), isWritable, isSigner });

export interface TxShape {
  payer?: string;
  event?: string;
  extra?: TransactionInstruction[];
  omitEventWrite?: boolean;
  blockhashValue?: string;
  sign?: Keypair;
}
/** A synthetic unsigned create transaction in Panta's documented shape. */
export function createTransaction(shape: TxShape = {}): string {
  const payer = shape.payer ?? wallet;
  const vaultAta = ata(vaultAuthority);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    new TransactionInstruction({ programId: new PublicKey(ATA), data: Buffer.from([1]), keys: [meta(payer, true, true),
      meta(vaultAta, true), meta(vaultAuthority), meta(MAINNET_USDC_MINT), meta(SystemProgram.programId.toBase58()), meta(TOKEN)] }),
    new TransactionInstruction({ programId: new PublicKey(program), data: Buffer.from("create_market_usdc_synthetic"), keys: [
      meta(payer, true, true), meta(shape.event ?? eventPda, !shape.omitEventWrite), meta(marketConfig), meta(vaultAuthority), meta(vaultAta, true),
      meta(MAINNET_USDC_MINT), meta(ata(payer), true), meta(TOKEN), meta(SystemProgram.programId.toBase58())] }),
    ...(shape.extra ?? []),
  ];
  const message = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: shape.blockhashValue ?? blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (shape.sign) tx.sign([shape.sign]);
  return Buffer.from(tx.serialize()).toString("base64");
}
export function sign(payload: string, keypair = creator): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(payload, "base64"));
  tx.sign([keypair]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/** Scripted Panta. Override any path's answer, or throw from it. */
export class FakePanta {
  calls: { path: CreatePath; body: Record<string, unknown> }[] = [];
  uploads: { uploadUrl: string; fields: Record<string, string>; bytes: number }[] = [];
  fee = FEE;
  liquidity = "10000000";
  platform = "40000000";
  tx: TxShape = {};
  registerError: MarketCreationError | null = null;
  overrides: Partial<Record<CreatePath, (body: Record<string, unknown>) => unknown>> = {};
  private quotes = 0;
  /** Distinct per run when several fakes share one real database. */
  createIdPrefix = "cr_synthetic";
  /** Panta derives this from creator + question; one per proposal in reality. */
  event = eventPda;
  /** Each build carries a fresh blockhash, as a real rebuild does. */
  private builds = 0;
  nextBlockhash = (): string => this.builds++ === 0 ? blockhash : synthetic(100 + (this.builds % 100));
  constructor(private readonly now: () => number) {}

  readonly request: CreateRequest = async (path, body) => {
    this.calls.push({ path, body });
    const override = this.overrides[path];
    if (override) return override(body);
    const expiresAt = new Date(this.now() + 60_000).toISOString();
    switch (path) {
      case "/markets/create/image-upload/":
        return { uploadUrl: "https://api.cloudinary.com/v1_1/synthetic/image/upload", publicId: "balr-market/events/usr_test/cover",
          expiresAt, fields: { api_key: "public-cloudinary-id", timestamp: 1, signature: "sig", folder: "balr-market/events", public_id: "usr_test/cover", overwrite: "false" } };
      case "/markets/create/quote/":
        return { createId: `${this.createIdPrefix}_${++this.quotes}`, expectedEventPda: this.event, paymentUsdc: this.fee, liquidityInjectionUsdc: this.liquidity,
          platformRevenueUsdc: this.platform, marketType: "standard", expiresAt: new Date(this.now() + 300_000).toISOString(), blockhashExpiryHintSec: 60 };
      case "/markets/create/build/": {
        const recent = this.nextBlockhash();
        return { createId: body.createId, expectedEventPda: this.event, transaction: createTransaction({ blockhashValue: recent, event: this.event, ...this.tx }), recentBlockhash: recent,
          lastValidBlockHeight: 1000, blockhashExpiryHintSec: 60, buildFingerprint: "fp_synthetic", paymentUsdc: this.fee,
          liquidityInjectionUsdc: this.liquidity, platformRevenueUsdc: this.platform, marketType: "standard",
          derived: { event: this.event, vaultAuthority, marketConfig }, expiresAt };
      }
      case "/markets/register/":
        if (this.registerError) throw this.registerError;
        return { createId: body.createId, marketId: this.event, status: "registered", signature: body.signature, category: "crypto", title: "t", images: [COVER_URL] };
    }
  };

  readonly upload: CoverUpload = async (uploadUrl, fields, png) => {
    this.uploads.push({ uploadUrl, fields, bytes: png.length });
    return { secure_url: COVER_URL, public_id: "balr-market/events/usr_test/cover" };
  };

  count(path: CreatePath) { return this.calls.filter(call => call.path === path).length; }
}
