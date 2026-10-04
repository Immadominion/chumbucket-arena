import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sharePriceFromIndicative } from "../src/prediction/sharePrices.ts";
import { PANTA_PROGRAM_ID, pantaChainRead } from "../src/prediction/PantaProgram.ts";
import * as REAL from "./fixtures/pantaChainAccounts.ts";

const url = process.env.PANTA_PRICES_TEST_DATABASE_URL;
const local = url ? describe : describe.skip;
let db: SQL;
let preexisting: { market: string; s: { id: string } };
const migrations = join(import.meta.dir, "../../chumbucket-social-calls/supabase/migrations");

local('Panta prices — disposable PostgreSQL only', () => {
  beforeAll(async () => {
    const u = new URL(url!);
    if (u.hostname !== '127.0.0.1' || u.port !== '56583' || u.pathname !== '/chumbucket_panta_prices_test') throw new Error('Refusing non-disposable database target');
    db = new SQL(url!);
    const [server] = await db`SELECT current_setting('data_directory') AS dir, to_regclass('public.users') AS users`;
    if (!String(server.dir).startsWith('/private/tmp/chumbucket-panta-prices.') || server.users) throw new Error('Require a new empty disposable cluster');
    await db.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE TABLE public.users(id UUID PRIMARY KEY);
      CREATE TABLE public.follows(follower_user_id UUID, followee_user_id UUID);
      CREATE FUNCTION public.current_app_user_id() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.app_user',true),'')::uuid $$;
      GRANT SELECT ON public.follows TO authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `);
    for (const file of ['20260913130000_venue_market_catalog.sql','20260913130500_venue_market_resolutions.sql',
      '20260913140000_social_calls_calls.sql','20260928210000_panta_share_price_evidence.sql']) {
      await db.unsafe(readFileSync(join(migrations,file),'utf8'));
    }
    // A USDC observation written under the original constraints, then the
    // SOL-quoted widening: ADD CONSTRAINT re-validates every existing row.
    preexisting = await fixture();
    await db.unsafe(readFileSync(join(migrations,'20261004090000_panta_sol_quoted_prices.sql'),'utf8'));
  });
  afterAll(async () => { if (db) await db.end(); });

  async function fixture(prices: {yesPrice: string|null; noPrice: string|null} = {yesPrice:'1.250000000000000001',noPrice:'0.35'}, age = 0) {
    const market = randomUUID(), user = randomUUID(), other = randomUUID(), at = Date.now()-age;
    const s = sharePriceFromIndicative({marketId:market, venueMarketId:'synthetic-panta-market', venue:'panta',
      currency:'USDC',unit:'per_share', ...prices, observedAt:at, executable:false,attribution:'Powered by Panta',demo:false});
    const raw = {venue:'panta',venueMarketId:'synthetic-panta-market',payloadVersion:1,fetchedAt:at,body:prices};
    await db`INSERT INTO users VALUES (${user}),(${other})`;
    await db`INSERT INTO venue_markets(id,venue,venue_event_id,venue_market_id,question,rules_text,outcomes,status,raw_status,opens_at,closes_at,payload_version,raw_payload)
      VALUES (${market},'panta',${market},${market},'Synthetic question','Synthetic exact rules','[{"side":"YES"},{"side":"NO"}]','OPEN','primary',now()-interval '1 hour',now()+interval '1 hour',1,'{"synthetic":true}')`;
    raw.venueMarketId = market;
    await db`INSERT INTO market_share_price_snapshots(id,market_id,observed_at,snapshot,raw_evidence)
      VALUES (${s.id},${market},${new Date(at)},${s}::jsonb,${raw}::jsonb)`;
    return { market,user,other,s,raw };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  async function call(f:F, patch: Record<string,unknown> = {}) {
    const row = {id:randomUUID(),user_id:f.user,market_id:f.market,side:'YES',visibility:'public',
      share_price_snapshot_id:f.s.id,entry_price:f.s,...patch};
    // Known test-controlled columns only; Bun safely binds all row values.
    await db`INSERT INTO calls ${db(row)}`;
    return row.id;
  }

  test('real migrations accept independent >1 USDC prices and keep probability null', async () => {
    const f=await fixture(); const id=await call(f); const [c]=await db`SELECT * FROM calls WHERE id=${id}`;
    expect(c.entry_price).toEqual(f.s); expect(c.entry_probability).toBeNull(); expect(c.snapshot_id).toBeNull(); expect(c.funding_state).toBe('NONE');
  });
  test('a later observation cannot rewrite the locked price or its FK', async () => {
    const f=await fixture(); const id=await call(f);
    await expect(db`UPDATE calls SET entry_price=entry_price || '{"yesPrice":"0.01"}'::jsonb WHERE id=${id}`.execute()).rejects.toThrow('immutable');
    await expect(db`UPDATE calls SET share_price_snapshot_id=null WHERE id=${id}`.execute()).rejects.toThrow('immutable');
    await db`UPDATE calls SET hidden_at=now(),hidden_reason='withdrawn' WHERE id=${id}`;
    expect((await db`SELECT entry_price FROM calls WHERE id=${id}`)[0].entry_price).toEqual(f.s);
  });
  test('snapshot UPDATE, DELETE, TRUNCATE and conflicting re-insert fail even for owner', async () => {
    const f=await fixture();
    await expect(db`UPDATE market_share_price_snapshots SET snapshot=snapshot WHERE id=${f.s.id}`.execute()).rejects.toThrow('append-only');
    await expect(db`DELETE FROM market_share_price_snapshots WHERE id=${f.s.id}`.execute()).rejects.toThrow('append-only');
    await expect(db`TRUNCATE market_share_price_snapshots CASCADE`.execute()).rejects.toThrow();
    const altered={...f.s,yesPrice:'0.1'};
    await expect(db`INSERT INTO market_share_price_snapshots VALUES (${f.s.id},${f.market},${new Date(f.s.observedAt)},${altered}::jsonb,${f.raw}::jsonb) ON CONFLICT DO NOTHING`.execute()).rejects.toThrow('rewritten');
  });
  test('missing, cross-market, changed and probability-shaped call evidence is refused', async () => {
    const a=await fixture(), b=await fixture();
    for(const patch of [{share_price_snapshot_id:null},{share_price_snapshot_id:b.s.id,entry_price:b.s},
      {entry_price:{...a.s,noPrice:'0.65'}},{entry_probability:0.5},{funding_state:'FILLED'}]) {
      await expect(call(a,patch)).rejects.toThrow();
    }
  });
  test('stale/future/missing side prices and backdated calls are refused', async () => {
    for(const [yes,no,age] of [['0.4','0.3',601000],['0.4','0.3',-60000],[null,'0.3',0],['0.4',null,0]] as const) {
      const f=await fixture({yesPrice:yes,noPrice:no},age); await expect(call(f)).rejects.toThrow('fresh prices');
    }
    const f=await fixture(); await expect(call(f,{locked_at:new Date(Date.now()-60000),created_at:new Date(Date.now()-60000)})).rejects.toThrow('fresh prices');
  });
  test('existing closed/result guards still apply', async () => {
    const f=await fixture(); await db`UPDATE venue_markets SET status='CLOSED_PENDING_RESOLUTION' WHERE id=${f.market}`;
    await expect(call(f)).rejects.toThrow('no longer taking calls');
    await db`UPDATE venue_markets SET status='OPEN' WHERE id=${f.market}`;
    await db`INSERT INTO market_resolutions(market_id,venue,venue_market_id,resolution,resolved_at,evidence_source,raw_evidence)
      VALUES (${f.market},'panta',${f.market},'YES',now(),'synthetic-fixture','{"synthetic":true}')`;
    await expect(call(f)).rejects.toThrow('answer is public');
  });
  test('public readers see price fields, never raw evidence, and clients cannot write', async () => {
    const f=await fixture();
    for(const role of ['anon','authenticated']) {
      const rows=await db.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE ${role}`);return tx`SELECT snapshot FROM market_share_price_snapshots WHERE id=${f.s.id}`;});
      expect(rows[0].snapshot).toEqual(f.s);
      await expect(db.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE ${role}`);return tx`SELECT raw_evidence FROM market_share_price_snapshots`;})).rejects.toThrow('permission denied');
      const [rights]=await db`SELECT has_table_privilege(${role},'market_share_price_snapshots','INSERT,UPDATE,DELETE,TRUNCATE') AS allowed`;
      expect(rights.allowed).toBe(false);
      const [columns]=await db`SELECT has_column_privilege(${role},'calls','entry_price','INSERT') AS entry,has_column_privilege(${role},'calls','share_price_snapshot_id','UPDATE') AS snapshot`;
      expect(columns.entry).toBe(false); expect(columns.snapshot).toBe(false);
    }
    await db`UPDATE venue_markets SET is_public=false WHERE id=${f.market}`;
    const hidden=await db.begin(async tx=>{await tx`SET LOCAL ROLE anon`;return tx`SELECT snapshot FROM market_share_price_snapshots WHERE id=${f.s.id}`;});
    expect(hidden).toHaveLength(0);
  });
  test('two-user followers-only call privacy survives new entry-price columns', async () => {
    const f=await fixture(); const id=await call(f,{visibility:'followers'});
    for(const [user,count] of [[f.user,1],[f.other,0]] as const) {
      const rows=await db.begin(async tx=>{await tx`SET LOCAL ROLE authenticated`;await tx`SELECT set_config('test.app_user',${user},true)`;return tx`SELECT entry_price FROM calls WHERE id=${id}`;});
      expect(rows).toHaveLength(count);
    }
  });
  test('malformed numeric units, extra stake fields and mismatched raw prices are rejected', async () => {
    const f=await fixture();
    for(const patch of [{yesPrice:1.2},{noPrice:'-1'},{yesPrice:'1e3'},{executable:true},{stake:'1'},{currency:'USD'},{yesPrice:'0.01'}]) {
      const s={...f.s,id:randomUUID(),...patch};
      await expect(db`INSERT INTO market_share_price_snapshots VALUES (${s.id},${f.market},${new Date(f.s.observedAt)},${s}::jsonb,${f.raw}::jsonb)`.execute()).rejects.toThrow();
    }
  });

  // ── SOL-quoted markets (20261004090000) ──────────────────────────────────
  async function solFixture(edit: (raw: Record<string, any>, s: Record<string, any>) => void = () => {}) {
    const market = randomUUID(), user = randomUUID(), venueMarketId = `synthetic-sol-${randomUUID()}`, at = Date.now();
    const s: Record<string, any> = { ...sharePriceFromIndicative({ marketId: market, venueMarketId, venue: 'panta', currency: 'SOL',
      unit: 'per_share', yesPrice: '0.671739755', noPrice: '0.328260245', observedAt: at, executable: false,
      attribution: 'Powered by Panta', demo: false }) };
    // Real account bytes; the DB checks the envelope, the BFF re-derives the bytes.
    const read = pantaChainRead({ address: REAL.SOL_OPEN_HYPE.address, owner: PANTA_PROGRAM_ID,
      data: Buffer.from(REAL.SOL_OPEN_HYPE.data, 'base64'), slot: REAL.CAPTURED_SLOT, fetchedAt: at, category: 'crypto' });
    const raw: Record<string, any> = { ...read.raw, venueMarketId, body: { ...(read.raw.body as object), account: venueMarketId } };
    edit(raw, s);
    await db`INSERT INTO users VALUES (${user})`;
    await db`INSERT INTO venue_markets(id,venue,venue_event_id,venue_market_id,question,rules_text,outcomes,status,raw_status,opens_at,closes_at,payload_version,raw_payload)
      VALUES (${market},'panta',${venueMarketId},${venueMarketId},'Synthetic SOL question','Synthetic exact rules','[{"side":"YES"},{"side":"NO"}]','OPEN','secondary',now()-interval '1 hour',now()+interval '1 hour',2,${raw.body}::jsonb)`;
    const insert = () => db`INSERT INTO market_share_price_snapshots(id,market_id,observed_at,snapshot,raw_evidence)
      VALUES (${s.id},${market},${new Date(at)},${s}::jsonb,${raw}::jsonb)`;
    return { market, user, other: user, s: s as any, raw, insert };
  }
  test('rows written before the widening are untouched and still valid', async () => {
    const [row] = await db`SELECT snapshot FROM market_share_price_snapshots WHERE id=${preexisting.s.id}`;
    expect(row.snapshot.currency).toBe('USDC');
    const [{ convalidated }] = await db`SELECT bool_and(convalidated) AS convalidated FROM pg_constraint
      WHERE conname IN ('panta_snapshot_shape','panta_snapshot_raw_evidence')`;
    expect(convalidated).toBe(true);
  });
  test('a SOL-quoted price with its program-account evidence is accepted, and a free call pins it', async () => {
    const f = await solFixture(); await f.insert();
    const id = await call(f as any); const [c] = await db`SELECT entry_price FROM calls WHERE id=${id}`;
    expect(c.entry_price).toEqual(f.s); expect(c.entry_price.currency).toBe('SOL');
  });
  test('a SOL price cannot borrow partner-API evidence, relabel its currency, or disagree with its evidence', async () => {
    const edits: [string, (raw: Record<string, any>, s: Record<string, any>) => void][] = [
      ['v1 evidence', raw => { raw.payloadVersion = 1; }],
      ['USDC label on chain evidence', (_raw, s) => { s.currency = 'USDC'; }],
      ['evidence says USDC', raw => { raw.body.quoteAsset = 'USDC'; }],
      ['evidence from another account', raw => { raw.body.account = 'someone-else'; }],
      ['evidence without bytes', raw => { delete raw.body.data; }],
      ['not an account read', raw => { raw.body.source = 'website'; }],
      ['different observed price', raw => { raw.body.yesPrice = '0.9'; }],
      ['an unknown currency', (_raw, s) => { s.currency = 'USD'; }],
    ];
    for (const [label, edit] of edits) {
      const f = await solFixture(edit);
      await expect(f.insert().execute(), label).rejects.toThrow();
    }
  });
});
