import { expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { PantaExecution } from "../src/prediction/PantaExecution.ts";
import { PantaTradingService, type PantaPrepareInput } from "../src/prediction/PantaTradingService.ts";
import type { PantaCallIntent, PantaTradeSession, PantaTradingStore } from "../src/prediction/PantaTradingStore.ts";
import { PantaVenue } from "../src/prediction/PantaVenue.ts";
import { PantaChain, validateSignedPantaTransaction, confirmsUsdcDeposit, MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import { pantaPost } from "../src/prediction/PantaHttp.ts";
import { pantaTradingReadiness, setPantaTradingRuntime, PANTA_MAINNET_PROGRAM_ID } from "../src/prediction/PantaTradingRuntime.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { pantaTradingRouter } from "../src/api/pantaTrading.ts";
import { predictionsRouter } from "../src/api/predictions.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";
import { TestClock } from "./predictionFixtures.ts";
import { asWallet } from "../src/domain/ids.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import { createHash } from "node:crypto";

// Deterministic SYNTHETIC test keys/rows. No credentials or real venue evidence.
const owner = Keypair.fromSeed(new Uint8Array(32).fill(9));
const wallet = owner.publicKey.toBase58();
const market = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const program = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const blockhash = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const callId = "30000000-0000-4000-8000-000000000001";
const user = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const syntheticAddress = (byte:number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const userTokenAccount=PublicKey.findProgramAddressSync([owner.publicKey.toBuffer(),new PublicKey(TOKEN).toBuffer(),new PublicKey(MAINNET_USDC_MINT).toBuffer()],new PublicKey(ATA))[0].toBase58();
const derived={marketConfig:syntheticAddress(5),vaultAuthority:syntheticAddress(6),vaultTokenAccount:syntheticAddress(7),userPosition:syntheticAddress(8),userTokenAccount,treasuryTokenAccount:syntheticAddress(10)};
function syntheticInstructions(canonicalUser:string) {
  const meta=(pubkey:string,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
  const data=Buffer.alloc(17);createHash("sha256").update("global:primary_order_usdc").digest().copy(data,0,0,8);data[8]=0;data.writeBigUInt64LE(1_000_000n,9);
  return [
    {programId:ATA,data:"AQ==",accounts:[meta(wallet,true,true),meta(userTokenAccount,true),meta(wallet),meta(MAINNET_USDC_MINT),meta("11111111111111111111111111111111"),meta(TOKEN)]},
    {programId:program,data:data.toString("base64"),accounts:[meta(wallet,true,true),meta(market,true),meta(derived.marketConfig),meta(derived.vaultAuthority),meta(derived.vaultTokenAccount,true),meta(derived.userPosition,true),meta(MAINNET_USDC_MINT),meta(userTokenAccount,true),meta(derived.treasuryTokenAccount,true),meta(TOKEN),meta(ATA),meta("11111111111111111111111111111111")]},
    {programId:MEMO,data:Buffer.from(`panta:v1:${canonicalUser}:qt_test:ord_test`).toString("base64"),accounts:[meta(wallet,false,true)]},
  ];
}

class MemoryLedger implements PantaTradingStore {
  rows = new Map<string,PantaTradeSession>(); writes = 0; failQuoteWrite = false;
  async callIntent(userId: string, id: string): Promise<PantaCallIntent | null> {
    return userId === user && id === callId ? { callId,marketId:"20000000-0000-4000-8000-000000000001",venueMarketId:market,side:"YES" } : null;
  }
  async find(userId: string, key: string) { return [...this.rows.values()].find(r => r.user_id === userId && r.idempotency_key === key) ?? null; }
  async byOrder(userId: string, id: string) { return [...this.rows.values()].find(r => r.user_id === userId && r.provider_order_id === id) ?? null; }
  async activeForCall(userId: string, id: string, owner: string) {
    return [...this.rows.values()].find(r => r.user_id === userId && r.call_id === id && r.wallet_address === owner && ["SUBMITTED","FILLED"].includes(r.state)) ?? null;
  }
  async reserve(intent: Parameters<PantaTradingStore["reserve"]>[0]) {
    if (await this.find(intent.user_id,intent.idempotency_key)) return null;
    const row: PantaTradeSession = {...intent,state:"PREPARING",provider_order_id:null,prepared:null,signed_transaction:null,signature:null,fill_evidence:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    this.rows.set(row.id,row); this.writes++; return row;
  }
  async update(id: string, state: PantaTradeSession["state"], patch: Partial<PantaTradeSession>) {
    if (this.failQuoteWrite && patch.state === "QUOTED") throw new Error("synthetic durable failure");
    const row = this.rows.get(id); if (!row || row.state !== state) return null;
    const next = {...row,...patch}; this.rows.set(id,next); this.writes++; return next;
  }
}

function rig() {
  const clock = new TestClock(); const ledger = new MemoryLedger(); let confirms = false; let rpcSuccess = true;
  const operations: string[] = []; let broadcasts = 0; let throwBroadcast = false;
  let providerFailed = false; let chainFailed = false;
  const execution = new PantaExecution({ programId:program,providerUserId:"usr_synthetic_partner",clock,verifyTransaction:async () => rpcSuccess,
    request:async (path,body) => {
      operations.push(path);
      const expiresAt = new Date(clock.now()+60_000).toISOString();
      if (path === "/primaryorderquote/") return {quoteId:"qt_test",marketId:market,side:"yes",amountUsdc:body.amountUsdc,shares:"1.1",avgPrice:"1.2",feeUsdc:"0.01",expiresAt};
      if (path === "/primaryorderbuild/") return {orderId:"ord_test",quoteId:"qt_test",wallet,marketId:market,side:"yes",amountUsdc:"1.000000",expectedShares:"1.1",feeUsdc:"0.01",status:"built",recentBlockhash:blockhash,lastValidBlockHeight:123,expiresAt,derived,instructions:syntheticInstructions("usr_synthetic_partner")};
      if (path === "/primaryordersubmit/") return {orderId:body.orderId,status:"submitted",signature:body.signature};
      if (path === "/primaryorderverify/") return {orderId:body.orderId,status:providerFailed?"failed":confirms?"confirmed":"submitted",signature:body.signature,marketId:market,side:"yes",amountUsdc:1000000};
      if (path === "/trades/") return {signature:body.signature,status:"processed",wallet,marketId:market,side:"yes",kind:"buy"};
      throw new Error("unexpected synthetic endpoint");
    },
  });
  const venue = new PantaVenue({apiKey:"pk_live_synthetic_trading_test",clock,fetchImpl:Object.assign(async () => new Response(JSON.stringify({marketId:market,category:"crypto",title:"Synthetic question?",description:"Synthetic rules",phase:"primary",status:"primary",resolved:false,startTime:Math.floor(clock.now()/1000)-3600,endTime:Math.floor(clock.now()/1000)+86400,resolutionTime:null,yesPrice:"1.2",noPrice:"0.3",onChain:{isActive:true,resolutionRule:"Synthetic rules"}})),{preconnect:fetch.preconnect})});
  const deps={store:ledger,execution,venue,maxAmountBaseUnits:"100000000",now:()=>clock.now(),chain:{failed:async()=>chainFailed,broadcast:async () => { broadcasts++; const row=[...ledger.rows.values()][0]!;expect(row.state).toBe("SUBMITTED");expect(row.signature).not.toBeNull();if(throwBroadcast) throw new Error("synthetic lost RPC reply");}}};
  const service = new PantaTradingService(deps);
  const input: PantaPrepareInput = {callId,wallet,amountBaseUnits:"1000000",idempotencyKey:"synthetic-intent-key",maxSlippageBps:100};
  return {clock,ledger,service,input,operations,restart:()=>new PantaTradingService(deps),get broadcasts(){return broadcasts;},confirm(){confirms=true;},rpcMissing(){rpcSuccess=false;},loseBroadcast(){throwBroadcast=true;},providerFailure(){providerFailed=true;},chainFailure(){chainFailed=true;}};
}
function signed(payload:string) {const tx=VersionedTransaction.deserialize(Buffer.from(payload,"base64"));tx.sign([owner]);return Buffer.from(tx.serialize()).toString("base64");}

test("native flag honors explicit true but readiness names the actual missing production requirement",()=>{
  const cfg=loadConfig({FUNDED_POSITIONS:"true",PANTA_API_KEY:"pk_live_synthetic_trading_test"});
  expect(cfg.predictions?.flags?.fundedPositions).toBe(true);
  expect(pantaTradingReadiness(cfg)).toMatchObject({enabled:false,venue:"panta",attribution:"Powered by Panta"});
  expect(pantaTradingReadiness(cfg).reason).toContain("durable account");
  const ready=loadConfig({FUNDED_POSITIONS:"true",PANTA_API_KEY:"pk_live_synthetic_trading_test",PANTA_PARTNER_USER_ID:"usr_synthetic_partner",SUPABASE_URL:"https://synthetic.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only",SOLANA_NETWORK:"mainnet-beta",PANTA_SCHEMA_READY:"true",PANTA_PROGRAM_ID:PANTA_MAINNET_PROGRAM_ID});
  expect(pantaTradingReadiness(ready)).toMatchObject({enabled:true,reason:null});
  expect(pantaTradingReadiness({...ready,social:{...ready.social!,network:"devnet"}}).enabled).toBe(true);
  const paused={...ready,predictions:{...ready.predictions,flags:{fundedPositions:false}}};
  expect(pantaTradingReadiness(paused).enabled).toBe(false);
  expect(pantaTradingReadiness(paused,true).enabled).toBe(true);
  expect(pantaTradingReadiness({...ready,predictions:{...ready.predictions,panta:{...ready.predictions!.panta!,programId:program}}}).enabled).toBe(false);
});
test("one durable reservation yields an exact reusable unsigned review, never funded",async()=>{
  const h=rig(); const first=await h.service.prepare(user,h.input); const again=await h.service.prepare(user,{...h.input});
  expect(again).toEqual(first);expect(first.order.fundingState).toBe("QUOTED");expect(first.order.quotedProbability).toBeNull();
  expect(first.review.avgPrice).toBe("1.2");expect(first.review.attribution).toBe("Powered by Panta");
  expect(h.operations).toEqual(["/primaryorderquote/","/primaryorderbuild/"]);expect(h.broadcasts).toBe(0);
});
test("idempotency conflict, wrong person, expired quote and excessive amount refuse without a second buy",async()=>{
  const h=rig();await h.service.prepare(user,h.input);
  await expect(h.service.prepare(user,{...h.input,amountBaseUnits:"2000000"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await expect(h.service.prepare(other,h.input)).rejects.toThrow("your own call");
  await expect(h.service.prepare(user,{...h.input,amountBaseUnits:"100000001",idempotencyKey:"synthetic-other-key"})).rejects.toThrow("limit");
  h.clock.advance(61_000);await expect(h.service.prepare(user,h.input)).rejects.toThrow("expired");
  expect(h.operations).toHaveLength(2);expect(h.broadcasts).toBe(0);
});
test("a durable save failure never releases a wallet-signable quote",async()=>{
  const h=rig();h.ledger.failQuoteWrite=true;
  await expect(h.service.prepare(user,h.input)).rejects.toThrow("durable failure");
  expect([...h.ledger.rows.values()][0]!.state).toBe("FAILED");expect(h.broadcasts).toBe(0);
});
test("signed approval is committed before broadcast; pending and partial evidence is not money",async()=>{
  const h=rig();const prepared=await h.service.prepare(user,h.input);const approval=signed(prepared.order.transaction.payload);
  const submitted=await h.service.submit(user,prepared.order.orderId,approval);
  expect(submitted.fundingState).toBe("SUBMITTED");expect(submitted.fillTxSignature).toBeNull();
  expect((await h.service.order(user,prepared.order.orderId)).fundingState).toBe("SUBMITTED");
  h.confirm();h.rpcMissing();expect((await h.service.order(user,prepared.order.orderId)).fundingState).toBe("SUBMITTED");
  expect([...h.ledger.rows.values()][0]!.state).toBe("SUBMITTED");
});
test("dropped broadcast reply survives a fresh service and fills only after provider attribution plus RPC proof",async()=>{
  const h=rig();const prepared=await h.service.prepare(user,h.input);h.loseBroadcast();
  await expect(h.service.submit(user,prepared.order.orderId,signed(prepared.order.transaction.payload))).rejects.toThrow("lost RPC reply");
  h.confirm();h.clock.advance(180_000);
  const restarted=h.restart();
  const filled=await restarted.order(user,prepared.order.orderId);
  expect(filled.fundingState).toBe("FILLED");expect(filled.fillTxSignature).not.toBeNull();
  expect((await restarted.order(user,prepared.order.orderId))).toEqual(filled);
  expect(h.broadcasts).toBe(1);expect([...h.ledger.rows.values()][0]!.fill_evidence).toMatchObject(filled);
});
test("unsigned approval, foreign signature and changed message cannot reach broadcast",async()=>{
  const h=rig();const prepared=await h.service.prepare(user,h.input);
  for (const payload of [prepared.order.transaction.payload,Buffer.from("bad").toString("base64")]) {
    await expect(h.service.submit(user,prepared.order.orderId,payload)).rejects.toThrow("Wallet approval");
  }
  const changed=VersionedTransaction.deserialize(Buffer.from(prepared.order.transaction.payload,"base64"));
  changed.message.recentBlockhash=new PublicKey(new Uint8Array(32).fill(8)).toBase58();changed.sign([owner]);
  await expect(h.service.submit(user,prepared.order.orderId,Buffer.from(changed.serialize()).toString("base64"))).rejects.toThrow("Wallet approval");
  expect(h.broadcasts).toBe(0);expect([...h.ledger.rows.values()][0]!.state).toBe("QUOTED");
});
test("private orders cannot be read or submitted by another canonical person",async()=>{
  const h=rig();const prepared=await h.service.prepare(user,h.input);
  await expect(h.service.order(other,prepared.order.orderId)).rejects.toMatchObject({code:"VENUE_NOT_FOUND"});
  await expect(h.service.submit(other,prepared.order.orderId,signed(prepared.order.transaction.payload))).rejects.toMatchObject({code:"VENUE_NOT_FOUND"});
  expect(h.broadcasts).toBe(0);
});
test("a cold restart recovers the private order and refuses a new buy for the same call",async()=>{
  const h=rig(); const prepared=await h.service.prepare(user,h.input);
  await h.service.submit(user,prepared.order.orderId,signed(prepared.order.transaction.payload));
  const cold=h.restart();
  const recovered=await cold.forCall(user,callId,wallet);
  expect(recovered.order?.fundingState).toBe("SUBMITTED");
  expect(JSON.stringify(recovered)).not.toMatch(/signed_transaction|prepared|messageHash|fillEvidence/);
  expect(await cold.forCall(other,callId,wallet)).toEqual({order:null});
  expect(await cold.forCall(user,callId,market)).toEqual({order:null});
  await expect(cold.prepare(user,{...h.input,idempotencyKey:"cold-new-key"})).rejects.toThrow("Check that order");
  expect(h.operations.filter(x=>x==="/primaryorderquote/")).toHaveLength(1);
  h.confirm();await cold.order(user,prepared.order.orderId);
  const settled=await h.restart().forCall(user,callId,wallet);
  expect(settled.order?.fundingState).toBe("FILLED");
  expect(JSON.stringify(settled)).not.toMatch(/signed_transaction|prepared|messageHash|fillEvidence/);
});
test("provider failure cannot free the duplicate-buy guard without independently confirmed chain failure",async()=>{
  const h=rig();const prepared=await h.service.prepare(user,h.input);
  await h.service.submit(user,prepared.order.orderId,signed(prepared.order.transaction.payload));
  h.providerFailure();
  expect((await h.service.order(user,prepared.order.orderId)).fundingState).toBe("SUBMITTED");
  await expect(h.service.prepare(user,{...h.input,idempotencyKey:"unsafe-second-buy"})).rejects.toThrow("Check that order");
  h.chainFailure();expect((await h.service.order(user,prepared.order.orderId)).fundingState).toBe("FAILED");
  expect(await h.service.forCall(user,callId,wallet)).toEqual({order:null});
  expect(h.broadcasts).toBe(1);
});
test("credential transport is pinned, no redirects/automatic quote retry, errors cannot carry key or approval",async()=>{
  const key="pk_live_synthetic_http_test";let count=0;
  const request=pantaPost(key,500,Object.assign(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    count++;expect(String(url)).toBe("https://live-api.panta.market/api/v1/primaryorderquote/");expect(init?.redirect).toBe("error");
    return new Response(JSON.stringify({key,privateApproval:"never-log"}),{status:500});
  },{preconnect:fetch.preconnect}));
  await expect(request("/primaryorderquote/",{})).rejects.toThrow("HTTP 500");expect(count).toBe(1);
  try{await request("/account/keys/",{});}catch(error){expect(String(error)).not.toContain(key);expect(String(error)).not.toContain("never-log");}
});
test("mainnet genesis mismatch stops broadcast before sendTransaction",async()=>{
  const h=rig();const prepared=await h.service.prepare(user,h.input);const tx=validateSignedPantaTransaction(signed(prepared.order.transaction.payload),wallet,[...h.ledger.rows.values()][0]!.prepared!.binding.messageHash);
  const methods:string[]=[];const chain=new PantaChain("https://synthetic-rpc.invalid",Object.assign(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));methods.push(body.method);return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result:"synthetic-devnet-hash"}));
  },{preconnect:fetch.preconnect}));
  await expect(chain.broadcast(tx)).rejects.toThrow("mainnet verification");expect(methods).toEqual(["getGenesisHash"]);
});
test("chain proof requires exact native USDC debit, not a signature or unrelated token change",()=>{
  const balance=(amount:string,ownerValue=wallet,mint=MAINNET_USDC_MINT,decimals=6)=>({owner:ownerValue,mint,uiTokenAmount:{amount,decimals}});
  const meta={preTokenBalances:[balance("2000000")],postTokenBalances:[balance("1000000")]};
  expect(confirmsUsdcDeposit(meta,wallet,"1000000")).toBe(true);
  expect(confirmsUsdcDeposit(meta,wallet,"1000001")).toBe(false);
  expect(confirmsUsdcDeposit(meta,market,"1000000")).toBe(false);
  expect(confirmsUsdcDeposit({},wallet,"1000000")).toBe(false);
  expect(confirmsUsdcDeposit({preTokenBalances:[balance("2000000",wallet,market)],postTokenBalances:[balance("1000000",wallet,market)]},wallet,"1000000")).toBe(false);
  expect(confirmsUsdcDeposit({preTokenBalances:[balance("2000000",wallet,MAINNET_USDC_MINT,9)],postTokenBalances:meta.postTokenBalances},wallet,"1000000")).toBe(false);
  expect(confirmsUsdcDeposit({preTokenBalances:[balance("invalid")],postTokenBalances:meta.postTokenBalances},wallet,"1000000")).toBe(false);
});
test("native router rejects DevAuth wallet strings and client-selected person identity",async()=>{
  const h=rig();const cfg=loadConfig({PANTA_API_KEY:"pk_live_synthetic_router_test",PANTA_PARTNER_USER_ID:"usr_synthetic_partner",PANTA_PROGRAM_ID:PANTA_MAINNET_PROGRAM_ID,PANTA_SCHEMA_READY:"true",FUNDED_POSITIONS:"true",SUPABASE_URL:"https://synthetic.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only",SOLANA_NETWORK:"mainnet-beta"});
  const app=await createApp({config:cfg});const store=new FakeIdentityStore().addUser("auth-test",user);const verifier=new FakeJwtVerifier().issue("synthetic-session","auth-test");
  primeAuthIdentityRuntime(cfg,{store,verifier,policy:resolveAuthIdentityPolicy(cfg)});setPantaTradingRuntime(cfg,h.service);
  const unverified=pantaTradingRouter.createCaller({app,wallet:asWallet(wallet)});
  await expect(unverified.prepare(h.input)).rejects.toMatchObject({code:"UNAUTHORIZED"});
  const caller=pantaTradingRouter.createCaller({app,supabaseAccessToken:"synthetic-session"});
  await expect(caller.prepare({...h.input,userId:other} as PantaPrepareInput)).rejects.toMatchObject({code:"BAD_REQUEST"});
  // No funded trade before the 18+ / jurisdiction / venue-terms attestation is on record.
  const trust=buildTrustRuntime(cfg,{store:new InMemoryTrustStore(),authAdmin:new RecordingAuthUserAdmin()});setTrustRuntime(cfg,trust);
  await expect(caller.prepare(h.input)).rejects.toMatchObject({code:"PRECONDITION_FAILED"});
  await trust.service.acceptFundedTrading(user,trust.config.termsVersion);
  const prepared=await caller.prepare(h.input);expect(prepared.order.fundingState).toBe("QUOTED");
  await caller.submit({orderId:prepared.order.orderId,signedTransaction:signed(prepared.order.transaction.payload)});
  cfg.predictions!.flags={fundedPositions:false};
  expect((await caller.order({orderId:prepared.order.orderId})).fundingState).toBe("SUBMITTED");
  expect((await caller.forCall({callId,wallet})).order?.fundingState).toBe("SUBMITTED");
  await expect(caller.prepare({...h.input,idempotencyKey:"paused-new-intent"})).rejects.toMatchObject({code:"FORBIDDEN"});
  await expect(caller.submit({orderId:prepared.order.orderId,signedTransaction:signed(prepared.order.transaction.payload)})).rejects.toMatchObject({code:"FORBIDDEN"});
  cfg.predictions!.flags={fundedPositions:true};
  const legacy=predictionsRouter.createCaller({app,wallet:asWallet(wallet)});
  await expect(legacy.createOrder({idempotencyKey:"synthetic-legacy",venueMarketId:market,side:"YES",amountBaseUnits:"1000000"})).rejects.toThrow("wallet-signed");
});
