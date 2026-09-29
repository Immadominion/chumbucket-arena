import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { buildPredictionRuntime } from "../src/prediction/runtime.ts";
import { buildCallsRuntime } from "../src/calls/runtime.ts";
import { PANTA_MAINNET_PROGRAM_ID } from "../src/prediction/PantaTradingRuntime.ts";

test("a refused production hydrate rejects ready without echoing database bodies or an empty-feed success", async () => {
  const config=loadConfig({PANTA_API_KEY:"pk_live_synthetic_hydrate",PANTA_PROGRAM_ID:PANTA_MAINNET_PROGRAM_ID,
    PANTA_SCHEMA_READY:"true",SUPABASE_URL:"https://synthetic.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only",SOLANA_NETWORK:"mainnet-beta"});
  const fetchImpl=Object.assign(async()=>new Response(JSON.stringify({message:"synthetic database body that must not escape"}),{status:503}),{preconnect:fetch.preconnect});
  const prediction=buildPredictionRuntime(config,{fetchImpl,hydrate:true});
  await expect(prediction.ready).rejects.toThrow("no empty-feed fallback");
  const calls=buildCallsRuntime(config,{prediction,fetchImpl,hydrate:true});
  await expect(calls.ready).rejects.toThrow("no empty-feed fallback");
  try { await calls.ready; } catch(error) { expect(String(error)).not.toContain("synthetic database body"); }
});
