import {expect,test} from "bun:test";
import {loadConfig} from "../src/config.ts";
import {buildPredictionRuntime} from "../src/prediction/runtime.ts";
import {InMemoryPredictionStore} from "../src/prediction/store.ts";
import {MARKET_SYNC_CURSOR} from "../src/prediction/marketSync.ts";
import {PantaVenue} from "../src/prediction/PantaVenue.ts";

test("Panta first sync never consumes or rewrites the legacy provider cursor",async()=>{
  const store=new InMemoryPredictionStore();
  const old=JSON.stringify({page:"12180",at:1700000000000});
  store.setCursor(MARKET_SYNC_CURSOR,old);
  store.setCursor(`${MARKET_SYNC_CURSOR}:panta`,old);
  const urls:string[]=[];
  const venue=new PantaVenue({apiKey:"pk_live_synthetic_cursor_test",fetchImpl:async(url)=>{
    urls.push(String(url));return new Response(JSON.stringify({items:[],nextCursor:null}));
  }});
  const runtime=buildPredictionRuntime(loadConfig({PANTA_API_KEY:"pk_live_synthetic_cursor_test"}),{store,venue});
  expect((await runtime.marketSync.runOnce()).pages).toBe(1);
  expect(new URL(urls[0]!).searchParams.has("cursor")).toBe(false);
  expect(store.getCursor(MARKET_SYNC_CURSOR)).toBe(old);
  expect(store.getCursor(`${MARKET_SYNC_CURSOR}:panta`)).toBe(old);
  expect(JSON.parse(store.getCursor(`${MARKET_SYNC_CURSOR}:panta:all`)!)).toMatchObject({page:null});
});
