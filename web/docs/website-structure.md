# chumbucket.fun: website structure

The landing page is a hand-written rebuild of the Figma-exported page that
used to run on chumbucket.fun (`components/troof/AppLandingPage.jsx`, a
7,752-line machine export with every node absolutely positioned, now
deleted). At 1440px it matches the old page element for element; below that
it reflows instead of shrinking. This file maps every visual element to the
code that draws it, so motion can be added one element at a time.

## Where things live

| Path | What |
| --- | --- |
| `app/page.tsx` | The landing page: fetches the public calls feed, composes the sections. ISR, revalidated every 60s. |
| `components/site/SiteShell.tsx` | Frame for every public page: skip link, header, `<main>`, footer, floating "Get the Android app". Loads the font and `site.css`. |
| `components/site/site.css` | Design tokens, resets, buttons, header, footer, and the decor primitives (glow, orbit, sparkle, phone). |
| `components/site/landing/*.tsx` | One component per landing section (below). |
| `components/site/landing/landing.css` | Section layouts: desktop first, then the single-column layout under 1024px. |
| `components/site/landing/landing-motion.css` | The landing's choreography, section by section (see "Motion"). |
| `components/site/landing/FaqList.tsx` | The FAQ accordion (client): buttons, open state, breakpoint default. |
| `components/site/motion/MotionRoot.tsx` | The one motion script (client, renders nothing): reveals, loop pausing, header state, hero depth, card tilt. |
| `components/site/motion/motion.css` | Motion tokens (easing, durations), keyframes, the reveal primitive, and site-wide interactions (buttons, header, nav, menu, floating button, sparkles, glows). |
| `components/site/decor/Decor.tsx` | `Glow`, `Orbit`, `Sparkle`, `Phone`, `DecorLayer`, the `at()` placement helper and the shared SVG filters. |
| `components/site/config.ts` | Links (install URL, X, Panta), the nav, and the product screenshots used in every phone. |
| `components/site/icons.tsx` | Every icon. The four line icons are the exact Figma outlines. |
| `components/site/fonts.ts` | PP Neue Machina via `next/font/local` (woff2 in `app/fonts`). |
| `lib/landingProof.ts` | What the social-proof section shows for each state of the feed (tested in `tests/webLanding.test.ts`). |
| `lib/landingPeople.ts` | Who the "See who’s calling it" circles show, and the line under the title (tested there too). |
| `components/public/*` | Share pages `/c`, `/u`, `/m` (now inside `SiteShell`, styled by `public.css`). |
| `components/legal/*` | `/terms`, `/privacy`, `/delete-account` (inside `SiteShell`, styled by `legal.css`). |

Assets: `public/site/phone-frame.png` (the Figma device frame),
`public/img/bucket.png` (the Chum Bucket logo, served through `next/image`),
`public/product-shots/*.webp` (app screenshots, see "Product screenshots").

## Sizing model

The Figma artboard is 1440px wide with a 1090px content column (175px each
side). Every length on desktop is written in design pixels times `--u`:

```css
--container: min(1090px, calc(100vw - 2 * var(--gutter)));
--u: calc(var(--container) / 1090);   /* 1px whenever the column fits */
```

So at 1440 and wider every value is the Figma value exactly; between 1024
and ~1170px the whole composition scales with the column (text included, the
smallest body text stays above 15px). Below 1024px the page becomes one
column and each illustration sets its own `--u` so it fits the screen.

Decorative pieces are placed with `.cb-at` and the `at(x, y, { w, r, t })`
helper: absolute at `(x, y)` design px from the positioned parent, width
`w`, turned `r` degrees (or a full matrix `t`) about the top-left corner,
exactly as the Figma nodes were. Glows are drawn in a box padded by 190
design px so the 60px blur is never clipped.

What visitors saw on the old page: at 1440 the artboard at full size; at
1024 and 768 the same artboard scaled down (0.71x and 0.53x, so body text
was 13px and 10px); under 768 a separate, unrelated mobile page that
overflowed the screen. The rebuild matches 1440 and keeps 1024 the same
composition at a readable size; 768 and phones get a real one-column layout
(copy and phone side by side again from 720px).

## Design tokens (site.css, on `.cb-site`)

| Token | Value | Figma use |
| --- | --- | --- |
| `--cb-pink` | `#ff5a76` | icon badges, glows, the current nav link (20px bold, large text) |
| `--cb-pink-strong` | `#ff3355` | icon strokes, focus ring |
| `--cb-pink-deep` | `#e0294d` | pink that carries small text (eyebrows, the pink FAQ cards, the floating button): 4.6:1 with white either way, where `#ff5a76` is 3.0:1 and `#ff3355` 3.6:1. The app does the same with its darker `pinkInk` |
| `--cb-pink-soft` | `#ffb0c0` | paler half of each glow |
| `--cb-mist` | `#f5eef1` | empty avatar circles, screen placeholder |
| `--cb-plum` | `#26161b` | phone notch, lead avatar |
| `--cb-text-lead` | black 55% | hero lead (Figma 55%) |
| `--cb-text-muted` | black 54% | body copy (Figma 50%, nudged to pass WCAG AA) |
| `--cb-radius-button` / `-card` / `-chip` | 4 / 8 / 10px | buttons / cards and CTA / lifted call card |
| type | Machina Regular 400, Ultrabold 800 | display 54/62, h2 48/48, h3 28/28, lead 20/30, body 18/28, nav 20/26, footer 16/26 and 32/42, eyebrow 18/28 tracked 0.16em |

Body copy is set in PP Neue Machina, as it was on the old page. To set body
copy in another face (for example Montserrat), load it in `fonts.ts` and use
it for `.cb-site` body text while headings keep `--cb-font`.

## Element map

Every section has `data-section`, every element a stable `data-el` and BEM
class. Motion can target either.

### Header (`SiteHeader.tsx`, `data-section="header"`)
| Visual | Hook |
| --- | --- |
| Logo + CHUMBUCKET wordmark + TM | `header.brand`, `.cb-brand__logo`, `.cb-brand__word`, `.cb-brand__tm` |
| Nav links: Home, How it works, Receipts, Live calls, FAQ (Home is pink and bold on `/`) | `header.nav`, `header.nav.{home,features,benefits,live,faq}` |
| Black "Get the app" button | `header.cta` |
| Menu button + panel (under 1024px; header is sticky there) | `header.menu` (`MobileMenu.tsx`) |
| Compact bar once scrolled (desktop: sticky once the script runs; `.cb-header::before` is the bar) | `.cb-header[data-scrolled]` |

### Hero (`Hero.tsx`, `HeroRibbon.tsx`, `data-section="hero"`)
| Visual | Hook |
| --- | --- |
| Pink glow behind the headline | `hero.glow` |
| Headline "Don’t miss / the call." | `hero.title` (each line is a `.cb-line`) |
| Grey lead | `hero.lead` |
| Black "get the app →" button | `hero.cta`, arrow `.cb-hero__arrow` (parts `.cb-arrow__shaft`, `.cb-arrow__head`) |
| Round badge + second link: "open web app" with a window-and-arrow icon when `NEXT_PUBLIC_WEB_APP_URL` names a web app that serves the calls product; until then a play badge and "see a receipt" (a real settled call), "see a live call" or "see live calls" | `hero.proof-link` (`data-kind` = `web` / `receipt` / `call` / `live`), badge `hero.proof-icon` (`.cb-hero__play`) |
| The ribbon and the phones (one box under 1024px, see "Phones and tablets") | `.cb-hero__stage` |
| Folded ribbon illustration (one SVG) | `hero.ribbon`; parts `hero.ribbon.band` (black band), `.stop-1` / `.stop-2` (its two labelled stops), `.fold` (pink band + "Make a call"), `.tag` (pink tag, bar, dividers), `.sparkle`, `.tag-label`, `.glyph` (the big "a") |
| Phone cluster, in four depth layers (`.cb-depth`, `--d` 0.3 / 0.55 / 0.8 / 1) | `hero.visual`; glow `hero.visual.glow`, rings `hero.visual.orbit`, phones `hero.phone-1` (front, Home), `-2` (a call), `-3` (back, a receipt), sparkles `hero.visual.sparkle-1..3` |
| Sparkles left of the logo and under the button | `hero.sparkle-1`, `hero.sparkle-2` |

### Features (`Features.tsx`, `#features`)
| Visual | Hook |
| --- | --- |
| Phone (Markets) in its rings with the flipped glow | `features.visual`, `features.phone`, `features.orbit`, `features.glow-1` |
| Right-edge glow, left sparkle | `features.glow-2`, `features.sparkle` |
| "how it works" / "Your move" | `features.eyebrow`, `features.title` |
| Three items (icon, title, body) | `features.item.{call,back-fade,receipt}` |

### Benefits (`Benefits.tsx`, `#benefits`)
| Visual | Hook |
| --- | --- |
| "why chumbucket" / "Receipts, not hype" | `benefits.eyebrow`, `benefits.title` |
| Row 1: bell badge + "Follow people who call it" | `benefits.follow.item` |
| Row 1: phone (Home), rings, glow, lifted call card | `benefits.follow.visual`, `.phone`, `.orbit`, `.glow`, `.card` |
| Row 2: phone (a receipt), rings, rotated glow | `benefits.settle.visual`, `.phone`, `.orbit`, `.glow` |
| Row 2: star badge + "Panta settles it" | `benefits.settle.item` |
| Sparkles | `benefits.follow.sparkle`, `benefits.settle.sparkle-1/-2` |

### Social proof (`SocialProof.tsx`, `#live`)
| Visual | Hook |
| --- | --- |
| "on record" / "See who’s calling it" | `proof.eyebrow`, `proof.title` |
| The line under the title: who is calling it, true for one, two or many people ("Dominion (@dev) is calling it. There’s room for you.") | `proof.callers-line` |
| Rings, glow, five circles, pink quote badge | `proof.art`, `proof.orbit`, `proof.glow`, `proof.circle.{centre,top-right,bottom-left,top-left,bottom-right}` (filled in that order, biggest first), `proof.quote-badge` |
| A person's circle: their picture, a link to `/u/<handle>`, their @handle tag (always on the centre circle, on hover or focus on the rest) | `.cb-proof__seat--person`, `.cb-proof__face`, `.cb-proof__tag` |
| A seat nobody is in yet: dashed ring with a plus (plain mist circles when nobody can be shown) | `.cb-proof__seat--open` |
| The live call card (white surface `::before`, pink hover glow `::after`) | `proof.call` |
| Market question (links to `/m/…`) | `proof.question` |
| Who called which side, at what price, on what day, and Panta's result | `proof.text` |
| Avatars of the people behind recent calls (link to `/u/…`) | `proof.people`, `proof.person` |
| "Settled · Incorrect" + "See the receipt" | `proof.status` |

Data, all from the public BFF, server-side:

- The circles: `people.leaderboard` (its `ranked` callers, then `building`),
  then `people.suggested` (only people who have made a call), then the
  authors of recent public calls; each person once, at most five
  (`lib/landingPeople.ts`). The leaderboard and suggestions are cached five
  minutes (records only move when Panta settles a market). A picture is
  the one the app shows (`avatarSrc` in `lib/callsBff.ts`, the same rule as
  the app's `avatar_catalog.dart`): the person's own https photo (X or
  Google, when they signed in with one), else the preset they picked
  (`avatarId` 1..5, the app's own images mirrored in
  `public/img/profile`), else their initials. With fewer people than
  circles the rest are open seats and the line says how many there really
  are; "others" appears only when there are more real people than the two
  it names. Nobody shown is invented, and no well-known account is used.
- The card: `calls.feed`, every 60s. Featured: the newest settled call,
  else the newest call. Empty feed: "No public calls yet." Feed down:
  "Live calls can't load right now."

### FAQ (`Faq.tsx`, `#faq`)
| Visual | Hook |
| --- | --- |
| "faq" / "Questions" | `faq.eyebrow`, `faq.title` |
| Eight cards, pink on the diagonal (alternating in one column) | `faq.item.{free,panta,settle,lose,wallet,web,where,start}` |
| Each card is an accordion item: the question is a button (`aria-expanded`, `aria-controls`) over the answer panel; `data-open` on the card. Keyboard focus rings the whole card (`:has()`), outside it, like every other focus ring | `.cb-faq__toggle`, `.cb-faq__icon` (plus / minus), `.cb-faq__panel` > `.cb-faq__panel-inner` |

Open by default on desktop (all eight, as the grid always showed them),
folded under 1024px. CSS draws that default from the breakpoint before
`FaqList` hydrates, so nothing moves when it does; without JavaScript a
`<noscript>` style opens every answer.
| Sparkle | `faq.sparkle` |

### Call to action (`GetTheApp.tsx`, `#get`)
| Visual | Hook |
| --- | --- |
| Black panel | `cta.panel` |
| White rings, glow, white sparkles | `cta.orbit-1/-2`, `cta.glow`, `cta.sparkle-3/-4` |
| Glow and sparkles outside the panel | `cta.glow-outside`, `cta.sparkle-1/-2` |
| "Call it before it happens." (the app's Welcome title) + text | `cta.title`, `cta.text` |
| White button "get the app" (when `NEXT_PUBLIC_ANDROID_INSTALL_URL` is set) or the white "Search Chumbucket in the Solana dApp Store" badge | `cta.button` |
| Three phones rising out of the panel (a call, Welcome, Profile) | `cta.phones`, `cta.phone-left`, `cta.phone-centre`, `cta.phone-right` |

### Footer (`SiteFooter.tsx`)
`footer.brand`, `footer.links`, `footer.more`, `footer.product`,
`footer.updates`, `footer.follow`, `footer.money` (the plain statement that
calls are free and trades are real USDC that can be lost), `footer.copyright`.
Headings and links are all lower case (the Figma footer's voice; it mixed in
a few capitals).

### Floating button
`float.get-app`, class `.cb-fab` (desktop only; phones get the sticky header
instead). Not `.cb-float`: `app/globals.css` gives that class the Arena's
idle bob, which would make this button drift up and down. It tucks away
(`data-fab="away"` on the root) while the get-the-app panel is on screen,
where it would repeat the panel's own button; tucked away it is
`visibility: hidden`, so it takes no Tab stop. It sits in its own `<aside>`
landmark.

## Motion

Everything moves with CSS plus one small client component. No animation
library: framer-motion / motion is not a dependency of this project, and
nothing here needs what it adds (layout animation, gestures, exit
animations). It would put tens of KB of JavaScript on a page that is
otherwise server-rendered. What CSS cannot do alone (knowing when a block
scrolls into view, the pointer position, the scroll position) is
`components/site/motion/MotionRoot.tsx`, about 150 lines, which only sets
data attributes and CSS variables.

### Rules

- Only `translate`, `scale`, `rotate` and `opacity` move, so animations run
  on the compositor at 60fps. The one exception is the FAQ answer's height
  (grid rows `0fr` to `1fr`), on one small card at a time. Layout never
  shifts (CLS 0 measured at 320 to 1440px).
- Placed decor (`.cb-at`) already uses `transform` for its Figma rotation:
  motion uses the individual properties, which compose with it.
- Every rule that moves something sits inside
  `@media (prefers-reduced-motion: no-preference)`; with `reduce` the page is
  the static design (and the rule at the end of `site.css` stops anything
  that slips through). The header's compact state and the floating
  button's tuck still apply, without transitions.
- Nothing is hidden unless MotionRoot is running (`data-motion="on"` on
  `.cb-site`), so without JavaScript everything shows. Blocks already on
  screen when it starts get `data-inview="static"` and show without
  animating; nothing visible ever blinks out.
- Loops (float, twinkle, breathe, nudge, ping) pause while their section is
  off screen (`data-playing` on each `[data-section]`).
- Entrances use backwards fill: once done, the element's resting values
  apply again, so a loop or a hover can take over the same property.

### Tokens (`motion.css`, on `.cb-site`)

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | everything arriving |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | loops |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | pops, small overshoot |
| `--ease-swing` | `cubic-bezier(0.37, 0, 0.63, 1)` | the ribbon's pendulum |
| `--dur-press` / `--dur-micro` / `--dur-short` / `--dur-medium` | 90 / 140 / 220 / 320ms | press / hover colour / icon nudges, underline / header, accordion, menu |
| `--dur-reveal` / `--dur-entrance` | 700 / 1000ms | scroll reveals / hero pieces, phones rising |
| `--stagger` | 80ms | between siblings (x `--i`) |
| `--rise` | 20px (56px for the CTA panel) | how far a revealed block travels |

### Reveal hooks

| Attribute | Effect |
| --- | --- |
| `data-reveal` | fades up `--rise` when it scrolls in; `style="--i: n"` delays it n x `--stagger` |
| `data-reveal="stage"` | the element stays; its phone rises, rings and glow fade in, a lifted card comes off (per-section rules) |
| `data-reveal="panel"` | fades up further (the CTA panel); its copy and phones follow |
| `data-inview="in"` / `"static"` | set by MotionRoot: scrolled in (animate) / was already on screen, or took keyboard focus before it scrolled in (just show) |

### Every animation, by name

Change one by its name: the keyframes and timings are in the file shown.

| Name | What it does | Hook | Timing | File |
| --- | --- | --- | --- | --- |
| Headline lines | each line rises out of its own line box | `hero.title` > `.cb-line__in` | 1000ms, at 100 and 210ms (`cb-line-up`) | landing-motion.css |
| Lead and actions | fade up | `hero.lead`, `hero.cta`, `hero.proof-link` | 800/700ms at 420, 540, 630ms (`cb-rise`) | landing-motion.css |
| Glows breathe | slow opacity swell (all glows) | `.cb-glow`, `hero.glow` | 9s loop (`cb-breathe`) | motion.css |
| Phones rise | back to front, from 72px lower | `hero.phone-3/-2/-1` | 1000ms at 240, 340, 440ms (`cb-rise-far`) | landing-motion.css |
| Phones float | drift up 8 to 11px and back, each on its own period | `hero.phone-*` (`--period`, `--float`) | 8s / 7s / 6.2s loops after rising (`cb-float`) | landing-motion.css |
| Depth | the four layers follow the pointer (18 x 12px at the front) and drift up as the hero scrolls away (90px at the front) | `.cb-depth` (`--d`), vars `--px`, `--py`, `--sy` on `hero` | eased in MotionRoot | landing-motion.css, MotionRoot.tsx |
| Ribbon swing | swings in on the "a" it hangs from and settles like a tag | `hero.ribbon` | 1500ms at 620ms (`cb-swing`) | landing-motion.css |
| Ribbon stops | the two stop dots light up in reading order | `hero.ribbon.stop-1/-2` `.cb-ribbon__dot` | 620ms at 1500, 1720ms (`cb-dot`) | landing-motion.css |
| Tag sparkle | turns in | `hero.ribbon.sparkle` | 900ms at 1950ms (`cb-sparkle-in`) | landing-motion.css |
| Sparkles pop | spin in from nothing (hero) | `hero.sparkle-*`, `hero.visual.sparkle-*` (`--pop`) | 800ms, 760 to 1400ms | landing-motion.css |
| Sparkles twinkle | shrink, turn and dim, offset per sparkle | `.cb-sparkle svg` (`--tw` from its position) | 4.8s loop (`cb-twinkle`) | motion.css |
| Arrow nudge | the forward arrow nudges, echoes, rests | `.cb-hero__arrow` | 3.8s loop from 2.4s (`cb-nudge`) | landing-motion.css |
| Arrow stretch | on hover/focus the shaft stretches and the head steps forward | `.cb-arrow__shaft`, `.cb-arrow__head` | 220ms | landing-motion.css |
| Badge ping | a ring pings out of the round badge | `hero.proof-icon::after` | 2.8s loop from 2.2s (`cb-ping`) | landing-motion.css |
| Badge hover | fills pink; the play triangle steps right, or the web arrow leaves its window | `hero.proof-icon`, `.cb-web__arrow` | 140 / 220ms | landing-motion.css |
| Web arrow | (web app link) the arrow leaves its window and returns | `.cb-web__arrow` | 3.4s loop from 2.6s (`cb-web-out`) | landing-motion.css |
| Reveals | fade up as they scroll in, staggered | every `data-reveal` | 700ms, `--i` x 80ms | motion.css |
| Stage | phone rises, rings then glow fade in | `features.visual`, `benefits.*.visual` | 1000 / 1400 / 1600ms | landing-motion.css |
| Feature icons | spring in after their line | `.cb-feature__icon` | 700ms (`cb-icon-pop`) | landing-motion.css |
| Lifted card | comes off the phone; lifts 8px more on hover | `benefits.follow.card` | 900ms at 650ms (`cb-lift`) | landing-motion.css |
| Badges | pop in; grow on hover | `.cb-benefit__badge` | 700ms | landing-motion.css |
| Bell | rings after it pops in, and again on hover | `benefits.follow.item` icon | 1000ms (`cb-ring`), 700ms (`cb-ring-again`) | landing-motion.css |
| Star | turns in; a quarter more on hover | `benefits.settle.item` icon | 900ms (`cb-star-turn`) | landing-motion.css |
| Callers pop | circles pop in one by one, people first, the quote badge last | `proof.circle.*`, `proof.quote-badge` | 760ms, 110ms apart (`cb-seat`) | landing-motion.css |
| Caller hover | the circle grows 5% and its @handle tag rises in | `.cb-proof__face`, `.cb-proof__tag` | 220ms | landing-motion.css |
| Card tilt + glow | the live call card leans toward the pointer (up to 3 degrees) and shows a pink glow | `proof.call` (`data-tilt`: `--tilt-x/-y`, `--glow-x/-y`) | 600ms follow | landing-motion.css, MotionRoot.tsx |
| FAQ | answer opens/closes by height and fades; plus turns into minus | `.cb-faq__panel`, `.cb-faq__icon` | 320ms | landing-motion.css |
| CTA panel | rises in; its title, text and button follow | `cta.panel` | 700ms; copy at 280, 370, 460ms | motion.css, landing-motion.css |
| CTA phones | rise out of the bottom edge one by one, then float | `cta.phone-left/-centre/-right` | 1100ms at 520, 640, 760ms; 6.6 to 8.2s floats | landing-motion.css |
| Buttons | press down to 97% | `.cb-btn:active` | 90ms | motion.css |
| Nav underline | slides in from the left, leaves to the right | `.cb-nav__link::after` | 220ms | motion.css |
| Header | compact bar fades in, row moves up 28px, logo and button shrink | `.cb-header[data-scrolled]` | 320ms | site.css (states), motion.css |
| Logo | the bucket tips on hover | `.cb-brand__logo` | 320ms spring | motion.css |
| Menu | panel drops in; the three lines fold into a cross | `.cb-menu__panel`, `.cb-menu__line--*` | 220 / 320ms | motion.css |
| Floating button | springs up after the hero; tucks away at the get-the-app panel; robot tilts on hover | `float.get-app` | 700ms at 1.5s (`cb-fab-in`); 320ms | motion.css |

## Phones and tablets

Under 1024px the hero is one screen tall under the sticky header
(`min-height: 100svh` minus `--cb-header-h`, more only if the copy needs
it): the headline, lead and both actions on top, then `.cb-hero__stage`
filling the rest. In the stage the phones rise and fade into the page
toward the bottom of the screen, and the ribbon, drawn large, hangs from
its "a" at the left edge and runs off the right edge: "What is it? FOMO for
prediction markets" reads in full, the rest bleeds off. Both scale with the
screen's width (the stage is an inline-size container) and its height
(`svh`), so on short phones they shrink to stay under the copy
(`max-height: 720px` also tightens the copy). Checked at 320 x 568,
360 x 740, 375 x 667, 390 x 844, 414 x 896, 600 x 900, 720 x 900,
768 x 1024 and 844 x 390: no horizontal scroll, the hero exactly one screen
(at 320 x 568 it runs 52px past it, the ribbon's tag below the fold), and
every tap target on small screens is at least 44px (footer links, the
logos and the small avatars get the extra through padding or a `::before`,
so the layout does not move).

## Copy rules

Truthful for the current product: people's calls on real Panta markets;
calls are free; Back, Fade and Dare are free; trading is optional, real
USDC on Panta (Solana mainnet), paid from the person's own wallet, and can
lose money; Panta settles every market; a receipt exists once Panta has
settled. Never: bet, odds, stake, pot, win money, earn, risk-free,
guaranteed, airdrop, jackpot, safe, chance, profit, "challenge a friend".
`tests/webLanding.test.ts` checks the site components, the page and the
root metadata for those words, and that nothing links `/signin` or `/arena`
(still the retired football product). Positioning, proof points and voice:
`docs/positioning.md`.

## Product screenshots

The phones show the current Android app, captured on a Seeker signed in as
the owner (@dev), mapped in `components/site/config.ts` (`SCREENS`, plus
`CALL_CARD` for the card lifted off the Benefits phone):

| Slot | Screen | File |
| --- | --- | --- |
| Hero front / back / middle | Home feed, a receipt, a call | `home-feed`, `receipt-missed`, `call-on-record` |
| Features ("Your move") | Markets | `markets` |
| Benefits row 1 + lifted card | Home feed + its first call's header | `home-feed`, `home-call-card` |
| Benefits row 2 ("Panta settles it") | Receipt "Missed this one." | `receipt-missed` |
| CTA left / centre / right | A call, Welcome, Profile | `call-on-record`, `welcome`, `profile-record` |

How they were made from the 1200 x 2670 captures: the real status bar
(rows 0-110, with personal notification icons) is rebuilt from the
screen's own background, column by column (Welcome keeps its coral
gradient), and a neutral one is drawn on top (9:41, wifi, full signal, full
battery, black at 60% like Android's own icons). Rows 28-2624 are kept,
which drops the gesture handle and gives the phone screen's exact ratio
(`.cb-phone__shot`, 0.4622); exported at 720 x 1558 WebP, over 3x the
largest rendered phone screen (224 CSS px). The CTA phones are a touch
narrower (0.454 to 0.457) and crop under 1% off each side with
`object-fit: cover`; their top band hides the status bar by design. The
lifted card is 804 x 246, the card's own ratio.

Profile is only used in the CTA, where the panel edge cuts it above its
"Escrow challenge still open" card (a leftover of the retired escrow
product that would contradict "Panta settles it"). Its wallet line shows
the owner's real balance.

`public/product-shots/home.png` is the old football-era Home: only the
retired `/signin` page still uses it.

## Known differences from the old page

Intentional:
- Copy rewritten for the current product (same structure and rhythm); the
  invented testimonial is replaced by a real call from the feed, on a card.
- The testimonial circles show real top callers (see "Social proof").
- The FAQ cards fold (open on desktop, folded on smaller screens).
- On desktop the header stays at the top as a compact bar once the page
  scrolls.
- Template glitches fixed: the ribbon's "What is it?" no longer overlaps its
  second line; "open arena" and "Settled by TxLINE" are no longer clipped;
  the clipped "+234 802 508" phone number and the email address with no mail
  server behind it are replaced by "Android · dApp Store" and "Markets by
  Panta"; the copyright sits on one centred line; the black rectangles over
  the CTA phones are gone; the FAQ cards are an even height with the same
  gap under every question (Figma's ran 41 to 74px; the gap below the grid
  keeps the CTA and footer where they were); the CTA button shows the
  Android robot instead of an Apple logo; the footer's "TM" is a superscript
  after the wordmark instead of a 4px mark over the K.
- A short money statement sits above the copyright.
- Body grey is 54% black instead of 50%, and the footer's @handle is
  `#7f7076` instead of `#988990`, so both pass WCAG AA.
- Small pink text and the pink FAQ cards use `--cb-pink-deep` (`#e0294d`)
  instead of `#ff5a76`, and the floating button instead of `#ff3355`, so
  their text passes WCAG AA (axe finds no contrast failures at 1440 or 390).
- The three feature items are spaced evenly (32px, 32px); Figma's 27px then
  37px fitted its old copy.
- Kept from Figma on purpose, though it looks accidental: the footer
  "Follow" label set 40px from the left of its button rather than centred.
- From 720 to 1023px the phone stages leave room on the copy side for their
  rings (they reach 142 design px past the phone), so no ring runs under
  text.
