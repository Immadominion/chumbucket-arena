/**
 * Mock data layer for the UI pass. Every screen reads from here so that swapping
 * in the live tRPC client (which mirrors the backend AppRouter outputs) later is
 * a drop-in: replace these constants with query hooks of the same shape.
 */

export const flag = (code: string, w: 80 | 160 = 80) =>
  `https://flagcdn.com/w${w}/${code}.png`;

export const avatar = (seed: string, bg: string) =>
  `https://api.dicebear.com/9.x/notionists/svg?seed=${seed}&backgroundColor=${bg}`;

export type Player = {
  handle: string;
  wallet: string;
  seed: string;
  bg: string;
  rating: number;
  rated: boolean; // has a settled (won/lost) call yet — until then the rating is just the baseline
  ratingDelta: number;
  record: string;
  rank: number;
  tier: string;
  balance: number;
  available: number;
  staked: number;
  form: ("W" | "L")[];
  walWon: number;
  hitRate: number;
  calls: number;
};

export const me: Player = {
  handle: "Nikitin",
  wallet: "7xKXtG…gAsU",
  seed: "Nikitin",
  bg: "d9f2e1",
  rating: 1842,
  rated: true,
  ratingDelta: 24,
  record: "18–13",
  rank: 7,
  tier: "Squad Player",
  balance: 240.5,
  available: 210.5,
  staked: 30.0,
  form: ["W", "L", "L", "W", "W"],
  walWon: 148,
  hitRate: 58,
  calls: 31,
};

export type SquadMate = {
  seed: string;
  bg: string;
  status: "online" | "away" | "offline";
};
const dot = { online: "#0BA14A", away: "#F2B705", offline: "#C0CABF" } as const;
export const dotColor = (s: SquadMate["status"]) => dot[s];

export const squad: SquadMate[] = [
  { seed: "Theo", bg: "ffe0b2", status: "online" },
  { seed: "Mara", bg: "c7e8ff", status: "away" },
  { seed: "Iben", bg: "e1d5ff", status: "online" },
  { seed: "Sven", bg: "d9f2e1", status: "offline" },
  { seed: "Priya", bg: "ffd6e0", status: "online" },
];

export type Fixture = {
  matchId: string;
  home: { name: string; code: string };
  away: { name: string; code: string };
  group: string;
  ko: string;
  koTag: string;
  pot: number;
  featured?: boolean;
  /** crowd-implied probabilities (the parimutuel pool split), 0..100 */
  pct: { home: number; draw: number; away: number };
};

export const featured: Fixture = {
  matchId: "bra-cro",
  home: { name: "Brazil", code: "br" },
  away: { name: "Croatia", code: "hr" },
  group: "Group F",
  ko: "20:00",
  koTag: "KO 20:00",
  pot: 4210,
  featured: true,
  pct: { home: 54, draw: 22, away: 24 },
};

export const matchday: Fixture[] = [
  {
    matchId: "fra-mar",
    home: { name: "France", code: "fr" },
    away: { name: "Morocco", code: "ma" },
    group: "Group A",
    ko: "Today · 22:30",
    koTag: "KO 22:30",
    pot: 2980,
    pct: { home: 49, draw: 27, away: 24 },
  },
  {
    matchId: "esp-ger",
    home: { name: "Spain", code: "es" },
    away: { name: "Germany", code: "de" },
    group: "Group B",
    ko: "Tomorrow · 18:00",
    koTag: "Tmrw 18:00",
    pot: 1540,
    pct: { home: 41, draw: 28, away: 31 },
  },
  {
    matchId: "por-ned",
    home: { name: "Portugal", code: "pt" },
    away: { name: "Netherlands", code: "nl" },
    group: "Group C",
    ko: "Tomorrow · 21:00",
    koTag: "Tmrw 21:00",
    pot: 3310,
    pct: { home: 36, draw: 27, away: 37 },
  },
];

export const allFixtures: Fixture[] = [featured, ...matchday];

export const getFixture = (matchId: string): Fixture =>
  allFixtures.find((f) => f.matchId === matchId) ?? featured;

export type OpenCall = {
  home: { name: string; code: string };
  away: { name: string; code: string };
  pick: string;
  staked: number;
  projected: number;
  lock: string;
};

export const openCall: OpenCall = {
  home: { name: "Argentina", code: "ar" },
  away: { name: "Netherlands", code: "nl" },
  pick: "ARG to win",
  staked: 30.0,
  projected: 71.4,
  lock: "1h 12m",
};

export type LadderRow = {
  rank: number;
  seed: string;
  bg: string;
  name: string;
  form: string;
  formGood: boolean;
  rating: number;
  you?: boolean;
  move?: string;
};

export const podium = [
  { place: 2, seed: "Mara", bg: "c7e8ff", name: "Mara", rating: 2310 },
  { place: 1, seed: "Theo", bg: "ffe0b2", name: "Theo", rating: 2640 },
  { place: 3, seed: "Iben", bg: "e1d5ff", name: "Iben", rating: 2180 },
];

export const ladder: LadderRow[] = [
  { rank: 4, seed: "Sven", bg: "d9f2e1", name: "Sven", form: "W3", formGood: true, rating: 2012 },
  { rank: 5, seed: "Priya", bg: "ffd6e0", name: "Priya", form: "W1", formGood: true, rating: 1944 },
  { rank: 6, seed: "Lukas", bg: "cde7d6", name: "Lukas", form: "L2", formGood: false, rating: 1901 },
  { rank: 7, seed: "Nikitin", bg: "d9f2e1", name: "You · Nikitin", form: "▲ 2", formGood: true, rating: 1842, you: true },
  { rank: 8, seed: "Dani", bg: "ffe0b2", name: "Dani", form: "W2", formGood: true, rating: 1790 },
];

export const managersPot = {
  total: 84200,
  projectedCut: 3400,
  toOvertake: "+59 pts",
};

export type TimelineEntry = {
  date: string;
  text: string;
  tone: "good" | "bad" | "neutral" | "muted";
};

export const timeline: TimelineEntry[] = [
  { date: "21 JUN", text: "Admitted he was wrong about Argentina", tone: "good" },
  { date: "18 JUN", text: "Backed England, lost 20 USDC", tone: "bad" },
  { date: "14 JUN", text: "Called Brazil's knockout run · +48 USDC", tone: "good" },
  { date: "10 JUN", text: "Signed the contract", tone: "muted" },
];

export const dossierTraits = [
  { label: "Group F curse · 0–3", fg: "#C2373B", bg: "#FBE9EA" },
  { label: "Knockouts · 71%", fg: "#0A7E40", bg: "#E7F6EC" },
  { label: "Favourite bias", fg: "#C57A12", bg: "#FBF0DC" },
  { label: "Tuesday tilt", fg: "#5B6B62", bg: "#EEF2EB" },
];

export const gafferRead =
  "Loyal to a fault — backs England and Brazil with his heart, not his head. Strong in knockout games, hopeless in Group F. Chases losses on a Tuesday, and won't admit he's wrong until the table forces him to.";

export type WalletEntry = {
  kind: "stake" | "loss" | "win" | "deposit";
  title: string;
  sub: string;
  amount: string;
  amountTone: "neutral" | "bad" | "good" | "blue";
};

export const walletActivity: WalletEntry[] = [
  { kind: "stake", title: "Staked · ARG to win", sub: "Locked · 1h 12m left", amount: "−30.0", amountTone: "neutral" },
  { kind: "loss", title: "Lost · England v Portugal", sub: "18 Jun", amount: "−20.0", amountTone: "bad" },
  { kind: "win", title: "Won · Brazil v Serbia", sub: "14 Jun", amount: "+48.0", amountTone: "good" },
  { kind: "deposit", title: "Deposit", sub: "10 Jun", amount: "+200.0", amountTone: "blue" },
];

export type ChatMsg =
  | { from: "gaffer"; text: string }
  | { from: "me"; text: string }
  | { from: "dossier"; quote: string; result: string; text: string };

export const chatThread: ChatMsg[] = [
  { from: "gaffer", text: "Back again. Last Tuesday you swore Argentina were finished. They're in the quarters." },
  { from: "gaffer", text: "Still fancy dying on that hill, or has the penny finally dropped?" },
  { from: "me", text: "Fine. I was wrong about Argentina. Happy?" },
  {
    from: "dossier",
    quote: '14 Jun · "Argentina are done, lump on Netherlands"',
    result: "Lost 20 USDC",
    text: "Happy? I'm thrilled. Now do the France game without the ego and we might get somewhere.",
  },
];

export type SettledCall = {
  id: string;
  home: { name: string; code: string };
  away: { name: string; code: string };
  score: [number, number];
  backed: string;
  outcome: "WON" | "LOST" | "VOID";
  pnl: string;
  gr: string;
  when: string;
  line: string;
};

export const results: SettledCall[] = [
  {
    id: "eng-por",
    home: { name: "England", code: "gb-eng" },
    away: { name: "Portugal", code: "pt" },
    score: [1, 2],
    backed: "England",
    outcome: "LOST",
    pnl: "−20.0",
    gr: "−12",
    when: "18 Jun · 21:00",
    line: "Backed the favourite again. We've talked about this. You don't get paid for being safe.",
  },
  {
    id: "bra-srb",
    home: { name: "Brazil", code: "br" },
    away: { name: "Serbia", code: "rs" },
    score: [2, 0],
    backed: "Brazil",
    outcome: "WON",
    pnl: "+48.0",
    gr: "+18",
    when: "14 Jun · 20:00",
    line: "Backed yourself when the league didn't. That's the version of you I want to see.",
  },
  {
    id: "fra-mex",
    home: { name: "France", code: "fr" },
    away: { name: "Mexico", code: "mx" },
    score: [3, 1],
    backed: "France",
    outcome: "WON",
    pnl: "+12.4",
    gr: "+4",
    when: "12 Jun · 18:00",
    line: "Right call, but the whole world saw it coming. Barely moves the needle.",
  },
  {
    id: "ned-uru",
    home: { name: "Netherlands", code: "nl" },
    away: { name: "Uruguay", code: "uy" },
    score: [0, 0],
    backed: "Netherlands",
    outcome: "VOID",
    pnl: "+0.0",
    gr: "0",
    when: "10 Jun · 17:00",
    line: "Match abandoned — stake returned. Lucky. We'll never know how wrong you were.",
  },
];

export const verdict = {
  result: "LOST" as const,
  match: "ENGLAND v PORTUGAL",
  score: ["1", "2"] as [string, string],
  backed: "England",
  stake: 30,
  line: "Backed the favourite again. We've talked about this. You don't get paid for being safe — you get paid for being right.",
  pnl: "−20.0",
  rating: "−12",
  streak: "L2",
};
