/**
 * Lockdown, notifications side: the deriver's cap counts writes only and it
 * reads incrementally (M4); a timer derives off the request path and pushes
 * what is new through FCM HTTP v1 to the recipient's own devices (M3, B3).
 * No real Firebase, no network: the sender's fetch is a fake.
 */

import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { InMemoryAccountStore } from "../src/account/store.ts";
import { setAccountRuntime } from "../src/account/runtime.ts";
import { notificationsRouter } from "../src/api/notifications.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import { asWallet } from "../src/domain/ids.ts";
import { NotificationDeriver } from "../src/notifications/NotificationDeriver.ts";
import { setNotificationsRuntime } from "../src/notifications/runtime.ts";
import { startNotificationScheduler } from "../src/notifications/scheduler.ts";
import { GOOGLE_TOKEN_URI, resolvePushConfig, type ServiceAccount } from "../src/push/config.ts";
import { PushDispatcher } from "../src/push/dispatcher.ts";
import { FcmHttpV1Sender, signServiceAccountJwt, type PushMessage, type PushSender, type SendOutcome } from "../src/push/fcm.ts";
import { harness, market, person, testApp } from "./socialNotificationsFixtures.ts";

const PEOPLE = ["u-ann", "u-bob", "u-cid", "u-dee", "u-eve", "u-fay", "u-gus", "u-hal", "u-ida"].map((id) =>
  person(id, { walletAddress: `Wallet_${id}` }),
);
const MARKETS = ["m1", "m2", "m3"].map((id) => market(id));

/** Ann makes three calls; eight people back one each — eight BACKED candidates. */
function backlog() {
  const n = harness({ people: PEOPLE, markets: MARKETS });
  const anns = MARKETS.map((m) => n.call("u-ann", m.id, "YES"));
  const backers = PEOPLE.slice(1);
  backers.forEach((b, i) => n.respond(b.id, anns[i % anns.length]!.call.id, "back"));
  return { n, anns };
}

class RecordingSender implements PushSender {
  sent: { token: string; message: PushMessage }[] = [];
  constructor(private readonly outcome: (token: string) => SendOutcome = () => "ok") {}
  async send(token: string, message: PushMessage): Promise<SendOutcome> {
    this.sent.push({ token, message });
    return this.outcome(token);
  }
}

describe("the deriver cap bounds writes, never replays (M4)", () => {
  test("past the cap, later passes keep delivering instead of stalling on old rows", () => {
    const { n, anns } = backlog();
    const deriver = new NotificationDeriver({
      store: n.rt.store, graph: n.rt.graph, markets: n.rt.markets, clock: n.clock, maxPerPass: 5,
      newId: (() => { let i = 0; return () => `n-${++i}`; })(),
    });
    const first = deriver.deriveNotifications();
    expect(first).toMatchObject({ created: 5, truncated: true, fullScan: true });
    const second = deriver.deriveNotifications();
    // The old code counted these 5 replays against the cap and wrote nothing,
    // forever. Now they are free.
    expect(second.created).toBe(3);
    expect(second.duplicates).toBe(5);
    expect(second.truncated).toBe(false);
    n.tick(5_000);
    n.respond("u-bob", anns[2]!.call.id, "fade");
    const third = deriver.deriveNotifications();
    expect(third.created).toBe(1);
    expect(third.fresh.map((x) => x.kind)).toEqual(["FADED"]);
    expect(n.inboxOf("u-ann")).toHaveLength(9);
  });

  test("an incremental pass re-reads only recent rows; an hourly full scan repairs the rest", () => {
    const { n } = backlog();
    const deriver = new NotificationDeriver({
      store: n.rt.store, graph: n.rt.graph, markets: n.rt.markets, clock: n.clock, overlapMs: 1_000,
      fullScanEveryMs: 3_600_000,
    });
    expect(deriver.deriveNotifications()).toMatchObject({ created: 8, fullScan: true });
    n.tick(60_000);
    // The overlap window re-reads what the previous pass saw once more, for free.
    expect(deriver.deriveNotifications()).toMatchObject({ created: 0, duplicates: 8, fullScan: false });
    n.tick(60_000);
    const quiet = deriver.deriveNotifications();
    expect(quiet).toMatchObject({ created: 0, considered: 0, fullScan: false });
    n.tick(3_600_000);
    const repair = deriver.deriveNotifications();
    expect(repair).toMatchObject({ fullScan: true, created: 0, duplicates: 8 });
  });

  test("a result synced late is still news: RESOLVED triggers on derivation, not the venue's timestamp", () => {
    const { n } = backlog();
    const deriver = new NotificationDeriver({
      store: n.rt.store, graph: n.rt.graph, markets: n.rt.markets, clock: n.clock, overlapMs: 1_000,
    });
    deriver.deriveNotifications();
    n.tick(600_000);
    n.calls.resolve("m1", "YES", n.clock.now() - 500_000);
    n.calls.rt.sync.runOnce();
    const pass = deriver.deriveNotifications();
    expect(pass.fullScan).toBe(false);
    expect(pass.fresh.map((x) => [x.kind, x.recipientUserId])).toContainEqual(["RESOLVED", "u-ann"]);
  });
});

describe("a pending call no longer breaks every pass (found while building the timer)", () => {
  test("runOnce and an inbox read succeed while someone's calls are all still pending", async () => {
    const n = harness({ people: PEOPLE.slice(0, 2), markets: MARKETS.slice(0, 1) });
    const a = n.call("u-ann", "m1", "YES");
    n.respond("u-bob", a.call.id, "back");
    // Before: buildCounts was handed the whole cell, saw lastResolvedAt null,
    // and threw RECORD_INCOMPLETE — so every inbox read answered 500.
    expect(() => n.rt.deriver.runOnce()).not.toThrow();
    const app = await testApp();
    setCallsRuntime(app.config, n.calls.rt);
    setNotificationsRuntime(app.config, n.rt);
    const ann = notificationsRouter.createCaller({ app, wallet: asWallet("Wallet_u-ann") });
    expect((await ann.notifications.unreadCount({})).unread).toBe(1);
  });
});

describe("pushes go to the recipient's own devices, with the inbox's own copy", () => {
  test("fresh notifications are pushed; stale backlog, other people and dead tokens are not", async () => {
    const { n } = backlog();
    const accounts = new InMemoryAccountStore();
    const annToken = "ann-device-" + "a".repeat(30);
    const deadToken = "dead-device-" + "d".repeat(30);
    await accounts.registerPushToken("u-ann", annToken, "android");
    await accounts.registerPushToken("u-ann", deadToken, "android");
    await accounts.registerPushToken("u-bob", "bob-device-" + "b".repeat(30), "android");
    const sender = new RecordingSender((t) => (t === deadToken ? "unregistered" : "ok"));
    const dispatcher = new PushDispatcher({
      accounts, graph: n.rt.graph, sender, maxAgeMs: 60_000, now: () => n.clock.now(),
    });

    const report = await dispatcher.dispatch(n.rt.deriver.deriveNotifications().fresh);
    expect(report).toMatchObject({ considered: 8, pushed: 8, devices: 8, forgotten: 1, stale: 0 });
    expect(new Set(sender.sent.map((s) => s.token))).toEqual(new Set([annToken, deadToken]));
    expect(await accounts.pushTokensFor("u-ann")).toEqual([{ token: annToken, userId: "u-ann", platform: "android" }]);
    const one = sender.sent.find((s) => s.token === annToken)!.message;
    expect(one.title).toMatch(/ backed your call$/);
    expect(one.body).toBe("They went on record on the same side as you.");
    expect(one.data).toMatchObject({ type: "call_notification", kind: "BACKED" });
    expect(one.data.call_id).toBeTruthy();
    // Nothing about the call's thesis, money or wallets rides along.
    expect(JSON.stringify(one)).not.toMatch(/Wallet_|thesis|amount/i);

    // A backlog older than maxAgeMs is inbox-only.
    n.tick(120_000);
    n.respond("u-ida", n.calls.calls.listCalls().find((c) => c.userId === "u-ann")!.id, "fade");
    n.tick(120_000);
    const late = await dispatcher.dispatch(n.rt.deriver.deriveNotifications().fresh);
    expect(late).toMatchObject({ considered: 1, stale: 1, pushed: 0 });
  });

  test("with no Firebase credentials nothing is sent and nothing breaks", async () => {
    const { n } = backlog();
    const dispatcher = new PushDispatcher({ accounts: new InMemoryAccountStore(), graph: n.rt.graph, sender: null, maxAgeMs: 60_000 });
    const report = await dispatcher.dispatch(n.rt.deriver.deriveNotifications().fresh);
    expect(report).toMatchObject({ disabled: true, pushed: 0, considered: 8 });
    expect(dispatcher.enabled).toBe(false);
  });
});

describe("the scheduler takes derivation off the request path", () => {
  test("ticks derive and push; inbox reads stop deriving once it runs", async () => {
    const { n } = backlog();
    const app = await testApp();
    setCallsRuntime(app.config, n.calls.rt);
    setNotificationsRuntime(app.config, n.rt);
    const accounts = new InMemoryAccountStore();
    await accounts.registerPushToken("u-ann", "ann-device-" + "a".repeat(30), "android");
    setAccountRuntime(app.config, { store: accounts, push: { enabled: false, reason: "test", maxAgeMs: 60_000 }, sender: null });
    const sender = new RecordingSender();
    const lines: string[] = [];
    const scheduler = startNotificationScheduler(app.config, {
      timer: false,
      runtime: n.rt,
      log: (l) => lines.push(l),
      dispatcher: new PushDispatcher({ accounts, graph: n.rt.graph, sender, maxAgeMs: 60_000, now: () => n.clock.now() }),
    });
    try {
      expect(n.rt.scheduled).toBe(true);
      // A read derives nothing now.
      const ann = notificationsRouter.createCaller({ app, wallet: asWallet("Wallet_u-ann") });
      expect((await ann.notifications.unreadCount({})).unread).toBe(0);
      const tick = await scheduler.tick();
      expect(lines.filter((l) => l.includes("tick failed"))).toEqual([]);
      expect(tick?.derive.created).toBe(8);
      expect(tick?.push.devices).toBe(8);
      expect((await ann.notifications.unreadCount({})).unread).toBe(8);
      expect(lines.some((l) => l.startsWith("[notifications] "))).toBe(true);
    } finally {
      scheduler.stop();
    }
    expect(n.rt.scheduled).toBe(false);
  });

  test("absent config is announced once, honestly", async () => {
    const { n } = backlog();
    const app = await testApp();
    setCallsRuntime(app.config, n.calls.rt);
    setAccountRuntime(app.config, {
      store: new InMemoryAccountStore(),
      push: { enabled: false, reason: "FIREBASE_SERVICE_ACCOUNT_JSON is not set", maxAgeMs: 60_000 },
      sender: null,
    });
    const lines: string[] = [];
    const s = startNotificationScheduler(app.config, { timer: false, runtime: n.rt, log: (l) => lines.push(l) });
    s.stop();
    expect(lines).toEqual(["[push] disabled: FIREBASE_SERVICE_ACCOUNT_JSON is not set. Notifications still reach the inbox."]);
  });
});

describe("FCM HTTP v1, configured from env", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const json = JSON.stringify({ project_id: "chum-test", client_email: "push@chum-test.iam.gserviceaccount.com", private_key: pem, token_uri: "https://evil.example/token" });

  test("config: absent, malformed, raw and base64 JSON; the token endpoint is always Google's", () => {
    expect(resolvePushConfig({})).toMatchObject({ enabled: false });
    expect(resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: "{nope" })).toMatchObject({ enabled: false });
    expect(resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "x" }) })).toMatchObject({ enabled: false });
    const raw = resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: json });
    const b64 = resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(json).toString("base64"), PUSH_MAX_AGE_MS: "5000" });
    expect(raw.enabled && raw.account.tokenUri).toBe(GOOGLE_TOKEN_URI);
    expect(b64).toMatchObject({ enabled: true, maxAgeMs: 5000 });
    // A malformed value is reported without being quoted.
    const bad = resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: "{secret-material" });
    expect(bad.enabled ? "" : bad.reason).not.toContain("secret-material");
  });

  test("the service-account assertion is a valid RS256 JWT for the messaging scope", () => {
    const cfg = resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: json });
    if (!cfg.enabled) throw new Error("expected enabled");
    const jwt = signServiceAccountJwt(cfg.account, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${h}.${c}`);
    expect(verify.verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "push@chum-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: GOOGLE_TOKEN_URI,
      exp: 1_800_003_600,
    });
  });

  test("sends to messages:send with a cached access token and maps FCM answers", async () => {
    const cfg = resolvePushConfig({ FIREBASE_SERVICE_ACCOUNT_JSON: json });
    if (!cfg.enabled) throw new Error("expected enabled");
    const account: ServiceAccount = cfg.account;
    const calls: { url: string; body: string; auth?: string }[] = [];
    let status = 200;
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: String(init?.body ?? ""), auth: (init?.headers as Record<string, string>)?.Authorization });
      if (u === GOOGLE_TOKEN_URI) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
      if (status === 404) return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
      if (status === 400) return new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 400 });
      return new Response(status === 200 ? "{}" : "busy", { status });
    }) as typeof fetch;
    const sender = new FcmHttpV1Sender(account, fake, () => 1_800_000_000_000);
    const msg = { title: "t", body: "b", data: { notification_id: "n1", type: "call_notification" } };
    expect(await sender.send("device-token", msg)).toBe("ok");
    expect(await sender.send("device-token-2", msg)).toBe("ok");
    expect(calls.filter((c) => c.url === GOOGLE_TOKEN_URI)).toHaveLength(1);
    const send = calls.find((c) => c.url.includes("messages:send"))!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/chum-test/messages:send");
    expect(send.auth).toBe("Bearer ya29.test");
    expect(JSON.parse(send.body).message).toMatchObject({ token: "device-token", notification: { title: "t", body: "b" } });
    status = 404;
    expect(await sender.send("gone", msg)).toBe("unregistered");
    status = 400;
    expect(await sender.send("gone", msg)).toBe("unregistered");
    status = 503;
    expect(await sender.send("x", msg)).toBe("retry");
    status = 403;
    expect(await sender.send("x", msg)).toBe("failed");
  });
});
