# THE GAFFER
### A staking prediction game with a manager who never forgets.

> **Working name:** *The Gaffer* (UK football slang for "the manager / the boss"). The competitive layer is *The Gaffer's League*.
> **Built for:** Walrus Memory World Cup (FIFA World Cup 2026).
> **This document covers:** what we're building, the full page-by-page flow, and the game theory underneath it. It does **not** cover colours, fonts, or visual design — that's the designer's job. Everything here is *what each thing does and why it exists.*

---

## 1. The one-sentence pitch

**You stake WAL on World Cup matches; an AI manager called the Gaffer remembers every call you make and every bias you have, uses that memory to roast you, coach you, and rank you — and the longer you play, the more he knows, the sharper he gets, and the harder it is to walk away.**

---

## 2. The 30-second version

- The World Cup is on. Every day there are real matches.
- You "make a call" on a match — a prediction — and **stake real WAL** behind it.
- All the players' stakes on a match form a **Pot**. Get it right, you take a share of the Pot. Get it wrong, you fund the people who got it right.
- Over you, the whole time, is **the Gaffer**: an AI football manager with **persistent memory stored on Walrus**. He remembers your every pick, your every excuse, *how* you bet (do you chase losses? do you only back favourites? did you swear Argentina were finished?).
- That memory does three jobs at once:
  1. **It coaches you** — he warns you about your own patterns before you bet, which genuinely helps you win money. (Memory you can feel the value of.)
  2. **It ranks you** — your skill becomes a **Gaffer Rating**, and he promotes/demotes you up a **Squad Ladder** (Trialist → … → Director of Football).
  3. **It roasts you** — he produces a shareable **Verdict** card that quotes your past self back at you. That card is the viral engine *and* a live proof that the memory is real.
- Your record lives on Walrus: **owned by you, verifiable, un-fakeable.** Nobody — not even us — can edit your reputation.

The flywheel: **more play → deeper memory → sharper coaching + meaner roasts + higher stakes → better cards → more shares → more players.** Memory depth *is* the growth engine, not a side feature.

---

## 3. Why this shape wins (the three judged criteria, mapped)

We don't bolt the memory on; the memory is the spine, and every mechanic feeds it.

| Judging criterion | How this design nails it |
|---|---|
| **1. Memory Depth & Authenticity** (does memory change behaviour over time; day-1 vs day-4) | The Gaffer's read on you is the centrepiece (the **Dossier**), with a literal Day-1→today timeline. He *uses* memory to coach and rank — not just log. The before/after is unavoidable. |
| **2. Creativity & Flair** (shareable, fun, unexpected, not same-as-everyone) | A manager who trash-talks your *betting psychology* with receipts is not "prediction tracker #47." The Verdict card is built to be screenshotted. Real stakes raise the emotional temperature. |
| **3. Technical Execution & Completeness** (live on Walrus mainnet, works, focused) | The core loop (call → stake → resolve → remember → roast) is small and fully closeable. Staking is deliberately the *simplest real-stakes mechanism* (see §8) so the build effort lands on the memory and the loop. |

**The single most important strategic rule in this whole document:** staking and gamification earn *zero* points directly — the rubric is 100% about the *memory*. Stakes and ranks exist to create the **return loop** and the **emotional stakes** that make the memory deep and the roasts shareable. They serve the memory. They never compete with it.

---

## 4. The vocabulary (the product speaks football)

Everything is named in manager/football language. This is part of the product, not flavour.

| Term | Meaning |
|---|---|
| **The Gaffer** | The AI manager. The persistent character you play under. |
| **Signing / The Contract** | Onboarding. You "sign for the Gaffer." |
| **A Call** | A staked prediction on a real match. |
| **A Bold Call** | A harder prediction (exact score, an upset, a scorer) — higher risk, higher reward, better roast material. |
| **A Hot Take** | An *unstaked* opinion you declare in chat ("Messi's washed"). Free. The Gaffer holds you to it forever. |
| **The Pot** | The parimutuel pool of all WAL staked on one match. |
| **The Dossier** | The Gaffer's evolving file *on you*. The memory, made visible. |
| **Gaffer Rating (GR)** | Your **skill** number. Goes up for correct *and difficult* calls, independent of how much you staked. |
| **P&L** | Your **money** — WAL won and lost. |
| **Form** | Your recent run (hot/cold streak). The Gaffer references it constantly. |
| **The Squad Ladder** | The rank tiers. Driven by GR, not by money. |
| **The Verdict** | The Gaffer's roast/summary of you — the shareable artifact. |
| **The Touchline** | The home hub once you're signed. |
| **Matchday** | The daily window of fixtures you can call. |
| **The Manager's Pot** | A season-long jackpot (see §8) paid out at the Final. |

---

## 5. The spine: how the memory actually works

This is the part the judges score. It must be the most considered system in the app.

### 5.1 Where it lives
All of a player's memory lives on **Walrus Memory** (via the MemWal SDK / managed relayer, encrypted, on Walrus mainnet), scoped to a **per-user namespace** (e.g. `gaffer:<wallet>`). One player = one namespace = one continuous, owned, verifiable memory. This is the "all agent state and memory stored on Walrus" requirement, satisfied literally.

### 5.2 What the Gaffer remembers (three layers)

1. **Raw calls** — every prediction: the match, the pick, the stake, the crowd-implied odds at the time, confidence, timestamp, and the eventual result. (The factual record.)
2. **Behavioural traits** — distilled from the raw record + chat (via memory "analyze"): *"Brazil homer," "chases losses — doubles stake after losing," "talks up underdogs, never backs them," "overconfident on favourites," "goes cold on late-night calls."* (The psychology — this is what makes it feel alive.)
3. **The relationship & quotes** — your Hot Takes, your beefs, your promotions, the moment you called the upset that made your name. (The story between you and him.)

### 5.3 How memory *changes behaviour* (the before/after that wins criterion #1)

| | **Day 1 (the "before")** | **Day 5+ (the "after")** |
|---|---|---|
| Greeting | "Don't know you from Adam. Give me three calls and we'll see if you've got an eye." | "Back again. Last Tuesday you swore Argentina were finished — they're in the quarters. Still want to die on that hill?" |
| Before you bet | (nothing — he can't) | "You're about to double up right after a loss. You're 1-and-6 when you do that. Think." |
| After a result | Generic "wrong, that one." | "Wrong again, and exactly the way I said you'd be wrong — you bottled the underdog at the last second. Again." |
| The roast | Thin, about the single pick. | Has receipts: quotes you, names your pattern, tracks your arc. |

The Day-5 column is *literally impossible* without persistent memory. We will demonstrate it with the same user account on camera: blank Gaffer → Gaffer who knows you cold.

### 5.4 The memory is *valuable*, not ornamental
The killer move: **the Gaffer's memory gives you an edge in the staking game.** When he tells you "you always tilt after a loss" and you listen, you bet better and win more WAL. So engaging with the memory is not a novelty — it directly improves your P&L. That's the answer to "does crypto/memory need to be here": the memory is the thing that makes you money, and Walrus is what makes that record yours and provable.

### 5.5 The public proof (a hackathon requirement)
Every player has a **public Dossier page** (§11) — anyone can view the Gaffer's read on a player, their verifiable record, and his latest Verdict. This is the "publicly accessible interface where the memory in action can be seen," done as a first-class, shareable page.

---

## 6. The core loop (one match, start to finish)

```
1. A real World Cup fixture is open for calls.
2. You open it. The Gaffer gives you his pre-bet read — based on YOUR history.
3. You make a Call (pick + stake WAL). Optionally a Bold Call.
4. Calls lock at kickoff. Your stake joins the Pot.
5. The match is played. We resolve the result from a live data source.
6. Settlement: winners split the Pot; your P&L, GR, and Form update.
7. The Gaffer delivers his Verdict — coaching + roast, from memory.
8. You share the Verdict card (built-in #Walrus share).
9. He has now learned more about you. Tomorrow he's sharper. ↺
```

Everything in the app is in service of running this loop daily for the length of the tournament.

---

## 7. The game theory (the meat)

The design has to reward **skill**, sustain **daily engagement**, create real **stakes**, resist **gaming**, and keep **money** from buying status. Here's how each is handled.

### 7.1 Staking is parimutuel (the crowd sets the odds)
- Each match has a **Pot**, split into outcome buckets (Home / Draw / Away, plus Bold-Call buckets).
- You stake WAL on a bucket before kickoff. **Winners split the entire Pot** proportional to their stake (i.e. you get your stake back plus a share of the losers' stakes), minus a small rake (§8).
- **Live implied odds = the pool sizes.** If everyone piles on the favourite, the favourite's payout shrinks; a correct contrarian call pays big.
- Why parimutuel and not a bookmaker/fixed odds: no house has to price risk, no liquidity to provide, no oracle for odds — the crowd prices it. It's simple, self-balancing, and trust-minimised. This is the lowest-complexity real-stakes mechanism that still feels like a real market.

**Consequence (good):** safe betting on heavy favourites earns almost nothing (huge pool, tiny share). The game *pushes* you toward conviction and difficulty — which is exactly where the Gaffer's memory and the best roast material live.

### 7.2 Three separate numbers — money does NOT buy status
This is the most important anti-pay-to-win decision.

- **P&L (money):** WAL won/lost. Influenced by stake size and luck.
- **Gaffer Rating (GR) (skill):** moves on **correctness weighted by difficulty** (how unlikely the crowd thought your call was), **independent of stake size.** A £1 correct upset call moves your GR the same as a £1,000 one. Calling a heavy favourite barely moves it.
- **Record:** raw wins/losses, for honesty.

The **Squad Ladder is driven by GR only.** A whale can win money but cannot buy rank — they have to actually *call games well*. The Gaffer respects GR and openly sneers at people who are "rich and wrong": *"Up forty quid, rating flat. You got lucky and we both know it."*

### 7.3 The Squad Ladder (status progression)
GR bands map to tiers. The Gaffer promotes and **demotes** you, narrating it from memory.

```
Trialist  →  Squad Player  →  First Team  →  Captain  →  Assistant Manager  →  Director of Football
```

- Promotion is a **moment** — the Gaffer makes a thing of it, references how you got there.
- **Demotion is real** — a cold run drops you, and he'll remind you that you "used to be First Team."
- This creates long-horizon engagement *beyond* any single bet: you're defending and building a rank, not just chasing one Pot.

### 7.4 Form (the streak mechanic)
Your recent run is your **Form** (e.g. last 5 calls: `W W L W W`). Hot Form gives a small, temporary **GR multiplier** and unlocks sharper Gaffer banter ("you're on fire, son"). Cold Form benches you in his eyes. Form drives **loss-averse daily return** — you don't want to break a run or stay benched.

### 7.5 Bold Calls & Hot Takes (memory fuel + skill expression)
- **Bold Calls** (exact score, an upset, first scorer) sit in their own small Pots, pay more, and move GR more because they're harder. They're also the richest roast/quote material.
- **Hot Takes** are *free, unstaked* declarations in chat. They cost nothing but **the Gaffer holds you to them forever.** Declaring "France are bottlers" with no stake is free engagement that deepens the memory and writes its own future roast.

### 7.6 The Manager's Pot (season-long meta-incentive)
A small rake (§8) accumulates into the **Manager's Pot**, a season jackpot paid at the World Cup Final, split among the top of the **Squad Ladder** (skill, not money). This gives a reason to keep climbing for the *whole tournament*, not just to win individual matches — and it ties the long game to GR, reinforcing skill-over-bankroll.

### 7.7 Anti-gaming & Sybil resistance
- **One Dossier per wallet.** The entire value of the product is a *deep* single identity. Spreading across many wallets gives you many *shallow, worthless* dossiers, low GR, and no rank. The game punishes Sybil naturally because depth is the prize.
- **Calls lock at kickoff** — no betting on in-progress information.
- **Thin-pool protection:** in very small Pots, parimutuel can be distorted; for thin markets we fall back to reference implied-odds (from a data source) for payout, or set a minimum participants threshold before a Pot pays parimutuel. *(Open decision — §15.)*
- **Optional signing friction:** a tiny one-time signing stake (refundable/usable) deters throwaway accounts. *(Open decision — §15.)*

---

## 8. The economy (how WAL moves)

- **Deposit:** you fund your Gaffer balance with WAL from your Sui wallet.
- **Staking:** WAL moves from your balance into a match Pot when you make a Call.
- **Settlement:** after a verified result, the **dedicated Sessions wallet** (required by the hackathon) settles the Pot — winners' balances credited, parimutuel split applied.
- **Rake:** a small cut (target ~2–3%) of each Pot funds the **Manager's Pot** (§7.6). Everything else is returned to players. *(Rake % is an open decision — §15. Could be 0% with a sponsor-seeded jackpot instead.)*
- **Withdraw:** you can withdraw your balance to your wallet at any time.
- **Custody model (recommended):** the Sessions wallet acts as the **resolver/escrow** — fastest real-stakes path. Trade-off: custodial (players trust us to settle). A fully trustless on-chain escrow contract is the heavier alternative and a later upgrade, not the MVP. *(Open decision — §15.)*

> **Regulatory note for the record:** real-money sports prediction is regulated gambling in many jurisdictions. For a mainnet hackathon demo with small stakes and a dedicated wallet this is an accepted grey area; a "play-money season token" variant (no cash value) is the zero-risk fallback if we ever need it.

---

## 9. The progression & relationship arc

The Gaffer is one continuous character with one continuous relationship per player. The arc:

1. **The Trial (Day 1):** he's a cold skeptic. You're nobody. He's just watching.
2. **Sizing you up (Days 2–3):** results land, patterns emerge, the first real reads appear, first promotion is in reach.
3. **He knows you (Day 4+):** full Dossier, pre-bet coaching, receipts in every roast. This is the "after."
4. **The run-in (knockouts):** stakes rise, the Manager's Pot looms, demotions sting, rivalries on the leaderboard.
5. **The Final / Season Review:** the Gaffer delivers a definitive **Verdict on your whole tournament** — your best call, your worst tilt, your final rank — a permanent, shareable, verifiable artifact you own forever.

---

## 10. The virality loop

- **The Verdict card** is the unit of sharing: the Gaffer quoting your past self and dunking on (or grudgingly crediting) you, with your rank/record, and a quiet "Powered by Walrus Memory" mark.
- It's generated at three moments: **after a big result**, **on promotion/demotion**, and **on demand** ("Get the Gaffer's verdict on me").
- One tap → posts to **X with #Walrus** (a submission requirement, turned into the core growth action).
- **Public Dossier pages** are linkable and crawlable — a shared card links to your live, verifiable profile, where a visitor can see the memory in action and is one click from signing.
- **Why people share it:** it's a flex *and* a self-deprecating laugh. **Why Walrus loves it:** every share is a live demo of persistent memory. The same artifact serves both.

---

## 11. The full page-by-page flow

Format for each: **Purpose · Who sees it · Key elements · What the user does · The Gaffer / memory role.**

### A. Public (logged-out)

#### A1. Landing Page
- **Purpose:** explain the hook in one scroll and convert to "sign the contract."
- **Who:** everyone, logged out.
- **Key elements:** the pitch ("the manager who never forgets"); a **live demo strip** showing a real Verdict card and a real Day-1-vs-Day-5 example; the live **Leaderboard** preview (top of the Squad Ladder right now); a "how it works" 3-step (Call → Stake → Get read); a wall of recent shared Verdicts; primary CTA **"Sign for the Gaffer."**
- **User does:** reads, clicks sign.
- **Gaffer/memory role:** the proof is front-loaded — real memory artifacts are the hero of the landing page, not screenshots of a chat box.

#### A2. Public Leaderboard
- **Purpose:** social proof + competition, viewable without an account.
- **Who:** everyone.
- **Key elements:** the **Squad Ladder** ranking (by GR) with tiers; a toggle for the **Winnings** board (by P&L); each row links to that player's public Dossier; current Manager's Pot size.
- **User does:** browse, click into players, feel the pull to compete.
- **Gaffer/memory role:** ranks are the visible output of accumulated memory/skill.

#### A3. Public Dossier (a player's profile) — *the "memory in action" page*
- **Purpose:** show the Gaffer's read on a player to anyone; satisfies the public-interface requirement; the share target.
- **Who:** everyone.
- **Key elements:** the player's traits (the Gaffer's read), record, GR, rank, Form, a **timeline of how the read evolved**, their landmark calls, the Gaffer's latest **public Verdict** on them, and a **"verifiable on Walrus"** indicator. CTA for visitors: "Think you can do better? Sign for the Gaffer."
- **User does:** read, share, or convert.
- **Gaffer/memory role:** this *is* the memory, rendered for an audience.

#### A4. Verdict Permalink
- **Purpose:** the landing spot when someone clicks a shared card on X.
- **Who:** everyone.
- **Key elements:** the full Verdict, context (which match/streak triggered it), a link to the player's Dossier, sign CTA.

### B. Auth & onboarding

#### B1. Sign In — "The Contract"
- **Purpose:** authenticate via Sui wallet and create the player's memory namespace.
- **Who:** new/returning users.
- **Key elements:** connect-wallet ("sign the contract"); for returning players, the Gaffer welcomes them back *by memory*.
- **User does:** connect wallet, approve.
- **Gaffer/memory role:** on first connect, the namespace is created; on return, his greeting is already memory-driven.

#### B2. The Trial (first session / Day 1 onboarding)
- **Purpose:** establish the "before" state and get the first calls in fast.
- **Who:** brand-new players.
- **Key elements:** a short, sharp Gaffer interview (a couple of taste questions + a free or low-stake **first Call** on a live fixture); deposit prompt; sets expectations ("come back when it's played and we'll talk").
- **User does:** answer, make a first call, optionally deposit.
- **Gaffer/memory role:** he openly has *no read yet* — this is deliberately the blank slate we'll contrast against later. First memories are written here.

### C. Core app (logged-in)

#### C1. The Touchline (home hub)
- **Purpose:** the daily landing; everything one tap away.
- **Who:** signed players.
- **Key elements:** today's **Matchday** fixtures open for calls; your open calls awaiting results; anything that just **settled** (with the Gaffer's reaction); your GR, rank, Form, balance; a nudge from the Gaffer ("two fixtures close in an hour, and you owe me a call after that France disaster").
- **User does:** triage their day — make calls, check results, read the Gaffer.
- **Gaffer/memory role:** the hub greeting and nudges are memory-driven and specific to you.

#### C2. Matchday / Fixtures
- **Purpose:** browse the matches available to call.
- **Who:** signed players.
- **Key elements:** list of upcoming fixtures with kickoff times, current Pot size and live implied odds per outcome, whether you've already called it.
- **User does:** pick a match to call.
- **Gaffer/memory role:** subtle flags from memory ("you're 0-3 on Group F games — sure?").

#### C3. Make a Call (the prediction + stake flow)
- **Purpose:** the central action. Pick + stake.
- **Who:** signed players.
- **Key elements:** the match; outcome buckets with live implied odds and live payout estimate as you size your stake; **Bold Call** options; stake input (from balance); a prominent **pre-bet read from the Gaffer**; confirm.
- **User does:** choose outcome, set stake, optionally a Bold Call, confirm. Lockable until kickoff.
- **Gaffer/memory role:** the **pre-bet read is the coaching moment** — "you tilt after losses, you just lost, this is exactly when you overstake." This is memory creating value in real time.

#### C4. The Gaffer (conversation)
- **Purpose:** talk to him directly; make Hot Takes; get coached; get roasted.
- **Who:** signed players.
- **Key elements:** a conversation with the manager character; he recalls and references your history unprompted; you can drop **Hot Takes** here; you can ask "what do you make of me?" and get a read; "give me your verdict" to generate a shareable card.
- **User does:** banter, declare takes, ask for reads/verdicts.
- **Gaffer/memory role:** the rawest expression of the memory — every reply is shaped by recall.

#### C5. My Dossier (private, full)
- **Purpose:** your complete profile and the **before/after centrepiece**.
- **Who:** you (private view; a public version is A3).
- **Key elements:** all your traits with the Gaffer's confidence; full record, GR, P&L, rank, Form; landmark calls; **a Day-1→today timeline scrubber** that shows how his read on you hardened over time; controls to generate/share a Verdict.
- **User does:** study yourself, scrub the timeline, share.
- **Gaffer/memory role:** this page is the memory made fully legible — the single clearest demonstration of criterion #1.

#### C6. The Pot / Match Detail
- **Purpose:** see a single match's live market and your position.
- **Who:** signed players.
- **Key elements:** live Pot size and split across buckets, implied odds, number of players in, your stake and projected payout, countdown to lock.
- **User does:** monitor, decide whether to call before lock.
- **Gaffer/memory role:** optional colour commentary ("the whole league's on Brazil — you hate the crowd, don't you").

#### C7. Results / Settlement Feed
- **Purpose:** the resolution moment — the dopamine and the consequence.
- **Who:** signed players.
- **Key elements:** matches resolving, your outcome on each, WAL won/lost, GR change, Form update, any promotion/demotion, and the Gaffer's immediate reaction per result.
- **User does:** see how they did, react, jump to Verdict/share.
- **Gaffer/memory role:** every settlement writes new memory and triggers a memory-aware reaction.

#### C8. The Verdict (post-result roast + share)
- **Purpose:** turn a result/streak/promotion into a shareable artifact.
- **Who:** signed players.
- **Key elements:** the generated Verdict (with receipts), the card preview, one-tap **share to X with #Walrus**, link to your public Dossier.
- **User does:** read, laugh/wince, share.
- **Gaffer/memory role:** the card is a memory proof; sharing is the growth action.

#### C9. Leaderboard (logged-in)
- **Purpose:** see where you stand and who to chase.
- **Who:** signed players.
- **Key elements:** the Squad Ladder with **your** position highlighted, the Winnings board toggle, Manager's Pot, rivals near you, links to public Dossiers.
- **User does:** measure themselves, get provoked into more calls.
- **Gaffer/memory role:** the Gaffer may single out a rival from your memory ("you're one place behind the bloke who copied your Brazil call — fix that").

#### C10. Wallet / Stakes
- **Purpose:** money management.
- **Who:** signed players.
- **Key elements:** balance, **deposit** / **withdraw** WAL, full staking history, open stakes, P&L over time.
- **User does:** fund, cash out, review.
- **Gaffer/memory role:** none (kept clean and trustworthy — this is the money page).

#### C11. Settings / Account
- **Purpose:** account, wallet, notifications, privacy of public Dossier.
- **Key elements:** connected wallet, notification preferences (matchday reminders, settlement alerts), toggle for what's shown on the public Dossier, data/ownership info ("your memory is on Walrus, owned by you").

---

## 12. A day in the life (the loop, humanised)

> **Morning.** Push: *"Three fixtures today. And we need to talk about last night."* You open the Touchline. The Gaffer has already settled your France call — you lost, because (he reminds you) you backed the favourite again. GR down a touch. Form now `W L L`.
>
> **Midday.** You go to make a call on Brazil–Croatia. Before you stake, the Gaffer: *"You're about to overstake to win it back. You're 1-and-6 doing that. Half the stake or walk."* You (grudgingly) halve it. You also drop a Hot Take in chat: *"Croatia are too old."* He files it.
>
> **Evening.** Match resolves. You were right, contrarian, decent payout. GR up, Form `W L L W`, and he *promotes you to Squad Player* — narrating that you only got here because you finally listened. He fires a Verdict card: *"Backed himself when the league didn't. Also still thinks Croatia are 'too old' — we'll see."* You share it. #Walrus.
>
> Tomorrow he knows you better than today.

---

## 13. The season arc (Group Stage → Final)

- **Group stage:** high fixture volume → fast memory accumulation → the before/after is fully visible within days.
- **Knockouts:** fewer, bigger matches → higher stakes, bigger Pots, more dramatic Verdicts, the Manager's Pot becomes a talking point.
- **Final:** the Gaffer's **Season Review** Verdict on each player — a permanent, owned, verifiable capstone artifact. Manager's Pot pays out to the top of the Squad Ladder.

---

## 14. Edge cases & rules

- **Result resolution:** from a live football data source; the result and settlement are public and verifiable. Calls lock at kickoff.
- **Postponed/abandoned matches:** Pot voided, stakes returned, no GR change.
- **Ties in parimutuel:** standard pro-rata split by stake within the winning bucket.
- **No-result Bold Calls:** if a Bold Call can't be adjudicated, that sub-Pot is voided and returned.
- **Thin pools:** see §7.7 (reference-odds fallback or minimum-participants threshold).
- **Abuse / Sybil:** see §7.7 (depth-as-prize disincentive, one Dossier per wallet).
- **Withdrawal during open stakes:** open-staked WAL is locked until settlement; only free balance is withdrawable.

---

## 15. Open decisions (need a call before/while building)

1. **Custody model:** custodial resolver wallet (fast, recommended) vs. trustless on-chain escrow (heavier). *Default: resolver.*
2. **Real WAL vs. play-money season token:** real stakes (recommended, your call) vs. zero-reg play token. *Default: real WAL, small stakes.*
3. **Rake:** ~2–3% into the Manager's Pot, vs. 0% with a seeded jackpot. *Default: small rake.*
4. **Thin-pool handling:** reference-odds fallback vs. minimum-participants threshold. *Default: minimum-participants, reference-odds as backup.*
5. **Signing friction:** tiny one-time signing stake to deter throwaways, or fully free signup. *Default: free, revisit if abused.*
6. **Hot Takes scope for v1:** free-text takes the Gaffer files, vs. a guided set of weekly "declarations." *Default: free-text.*

---

## 16. What this is NOT (to keep it sharp)

- Not a sportsbook with fixed odds and a house edge — it's a parimutuel game among players.
- Not a generic prediction tracker with a chat sidebar — the memory is the product, on screen.
- Not a casino of confetti and badges — the gamification is one rank and one relationship, kept clean.
- Not pay-to-win — money is P&L; status is skill (GR).

---

## 17. The north star

**A manager who remembers everything, stakes that make it matter, and a record you own and can prove — so that the single most memorable thing about using it is "wait… it actually remembered that about me."** Everything in this document exists to produce that one reaction, and to make it worth sharing.
