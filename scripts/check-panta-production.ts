/** Public, zero-spend production smoke. No credentials, .env, signing or fill.
 * bun --no-env-file scripts/check-panta-production.ts
 */
const base = "https://chumbucket-calls-bff-production.up.railway.app";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function request(path: string, input?: unknown, post = false, headers?: Record<string,string>) {
  const query = post || input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({json:input}))}`;
  const res = await fetch(`${base}/${path}${query}`, { method: post ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { ...(post?{"Content-Type":"application/json"}:{}),...headers },
    ...(post?{body:JSON.stringify({json:input??null})}:{}) });
  const data = await res.json() as any;
  return {status:res.status,data:data.result?.data?.json,error:data.error?.json?.data?.code};
}
const config = await request("predictions.config");
assert(config.status === 200 && config.data?.venue === "panta" && config.data?.fundedPositions === true && config.data?.demo === false &&
  config.data.jupiterConfigured === false && config.data.polymarketConfigured === false, "Production has not reached the native Panta-funded build");
const health = await request("health");
assert(health.status === 200 && health.data?.ok === true, "Health check failed");
const native = await request("pantaTrading.status",undefined,true);
assert(native.status === 200 && native.data?.enabled === true && native.data?.attribution === "Powered by Panta", "Native readiness failed");
const markets = await request("markets.open",{category:"crypto"});
assert(markets.status === 200 && Array.isArray(markets.data) && markets.data.length>0 &&
  markets.data.every((m:any)=>m.venue === "panta" && m.category === "crypto"), "Durable crypto discovery failed or returned another venue");
const intent = {callId:"10000000-0000-4000-8000-000000000001",wallet:"J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf",
  amountBaseUnits:"2000000",idempotencyKey:"production-anonymous-refusal",maxSlippageBps:100};
// These MUST refuse before ledger or venue work. The public synthetic wallet
// is not a trading/funding target; no signing seed is used by this script.
const anon = await request("pantaTrading.prepare",intent,true);
const forged = await request("pantaTrading.prepare",intent,true,{Authorization:"Bearer synthetic-invalid-session"});
const privateOrder = await request("pantaTrading.order",{orderId:"no-such-private-order"},true);
for(const r of [anon,forged,privateOrder]) assert(r.status === 401 && r.error === "UNAUTHORIZED", "Private authorization refusal failed");
const legacy = await request("predictions.createOrder",{idempotencyKey:"legacy-spoof-refusal",venueMarketId:"6wXkUmZdLSU1Fm2wRY3rrTuPZ3a3t2rzZarFAYqUXM98",
  side:"NO",amountBaseUnits:"2000000"},true,{"x-wallet":intent.wallet});
assert([401,403].includes(legacy.status) && ["UNAUTHORIZED","FORBIDDEN"].includes(legacy.error), "Old wallet-string trading route is reachable");
console.log(JSON.stringify({base,checks:8,venue:"panta",fundedPositions:true,nativeReady:true,durableCryptoMarkets:markets.data.length,
  anonymousAndForgedDenied:true,privateOrderDenied:true,legacyTradingDenied:true,socialNetwork:health.data.readiness.socialNetwork,
  signed:false,broadcast:false,filled:false}));
