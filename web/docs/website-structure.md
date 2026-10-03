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
| `components/site/decor/Decor.tsx` | `Glow`, `Orbit`, `Sparkle`, `Phone`, `DecorLayer`, the `at()` placement helper and the shared SVG filters. |
| `components/site/config.ts` | Links (install URL, X, Panta), the nav, and the product screenshots used in every phone. |
| `components/site/icons.tsx` | Every icon. The four line icons are the exact Figma outlines. |
| `components/site/fonts.ts` | PP Neue Machina via `next/font/local` (woff2 in `app/fonts`). |
| `lib/landingProof.ts` | What the social-proof section shows for each state of the feed (tested in `tests/webLanding.test.ts`). |
| `components/public/*` | Share pages `/c`, `/u`, `/m` (now inside `SiteShell`, styled by `public.css`). |
| `components/legal/*` | `/terms`, `/privacy`, `/delete-account` (inside `SiteShell`, styled by `legal.css`). |

Assets: `public/site/phone-frame.png` (the Figma device frame),
`public/img/bucket.png` (the Chum Bucket logo, served through `next/image`),
`public/product-shots/*.png` (app screenshots, see "Assets to replace").

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
| `--cb-pink` | `#ff5a76` | eyebrows, FAQ cards, icon badges, glows |
| `--cb-pink-strong` | `#ff3355` | icon strokes, floating button, focus ring |
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
| Nav links (Home is pink and bold on `/`) | `header.nav`, `header.nav.{home,features,benefits,faq,live}` |
| Black "Get the app" button | `header.cta` |
| Menu button + panel (under 1024px; header is sticky there) | `header.menu` (`MobileMenu.tsx`, the only client JS on the page) |

### Hero (`Hero.tsx`, `HeroRibbon.tsx`, `data-section="hero"`)
| Visual | Hook |
| --- | --- |
| Pink glow behind the headline | `hero.glow` |
| Headline "Call it before / it happens." | `hero.title` (each line is a `.cb-line`) |
| Grey lead | `hero.lead` |
| Black "get the app →" button | `hero.cta`, arrow `.cb-hero__arrow` |
| Round play badge + "see a receipt" (links to a real settled call) | `hero.proof-link`, `.cb-hero__play` |
| Folded ribbon illustration (one SVG) | `hero.ribbon`; parts `hero.ribbon.band` (black band), `.stop-1` / `.stop-2` (its two labelled stops), `.fold` (pink band + "Make a call"), `.tag` (pink tag, bar, dividers), `.sparkle`, `.tag-label`, `.glyph` (the big "a") |
| Phone cluster | `hero.visual`; glow `hero.visual.glow`, rings `hero.visual.orbit`, phones `hero.phone-1` (front, Home), `-2` (Calls), `-3` (back, Friends), sparkles `hero.visual.sparkle-1..3` |
| Sparkles left of the logo and under the button | `hero.sparkle-1`, `hero.sparkle-2` |

### Features (`Features.tsx`, `#features`)
| Visual | Hook |
| --- | --- |
| Phone (Home) in its rings with the flipped glow | `features.visual`, `features.phone`, `features.orbit`, `features.glow-1` |
| Right-edge glow, left sparkle | `features.glow-2`, `features.sparkle` |
| "features" / "What you can do" | `features.eyebrow`, `features.title` |
| Three items (icon, title, body) | `features.item.{call,back-fade,receipt}` |

### Benefits (`Benefits.tsx`, `#benefits`)
| Visual | Hook |
| --- | --- |
| "advantages" / "Why people use it" | `benefits.eyebrow`, `benefits.title` |
| Row 1: bell badge + "Follow people who call it" | `benefits.follow.item` |
| Row 1: phone (Calls), rings, glow, lifted call card | `benefits.follow.visual`, `.phone`, `.orbit`, `.glow`, `.card` |
| Row 2: phone (Calls), rings, rotated glow | `benefits.settle.visual`, `.phone`, `.orbit`, `.glow` |
| Row 2: star badge + "Panta settles it" | `benefits.settle.item` |
| Sparkles | `benefits.follow.sparkle`, `benefits.settle.sparkle-1/-2` |

### Social proof (`SocialProof.tsx`, `#live`)
| Visual | Hook |
| --- | --- |
| "on record" / "from people calling it" | `proof.eyebrow`, `proof.title` |
| Rings, glow, five circles, pink quote badge | `proof.art`, `proof.orbit`, `proof.glow`, `proof.circle.{centre,top-right,bottom-right,top-left,bottom-left}`, `proof.quote-badge` |
| Market question (links to `/m/…`) | `proof.question` |
| Who called which side, at what price, on what day, and Panta's result | `proof.text` |
| Avatars of the people behind recent calls (link to `/u/…`) | `proof.people`, `proof.person` |
| "Settled · Incorrect" + "See the receipt" | `proof.status` |

Data: `calls.feed` from the public BFF, server-side, every 60s. Featured:
the newest settled call, else the newest call. The circles show real
avatars when a person has one (https only), otherwise stay plain as in
Figma. Empty feed: "No public calls yet." Feed down: "Live calls can't load
right now." Nothing is invented.

### FAQ (`Faq.tsx`, `#faq`)
| Visual | Hook |
| --- | --- |
| "faq" / "Questions" | `faq.eyebrow`, `faq.title` |
| Six cards, pink on the diagonal (alternating in one column) | `faq.item.{who-decides,cost,money,app,lose,start}` |
| Sparkle | `faq.sparkle` |

### Call to action (`GetTheApp.tsx`, `#get`)
| Visual | Hook |
| --- | --- |
| Black panel | `cta.panel` |
| White rings, glow, white sparkles | `cta.orbit-1/-2`, `cta.glow`, `cta.sparkle-3/-4` |
| Glow and sparkles outside the panel | `cta.glow-outside`, `cta.sparkle-1/-2` |
| "Ready to make a call?" + text | `cta.title`, `cta.text` |
| White button "get the app" (when `NEXT_PUBLIC_ANDROID_INSTALL_URL` is set) or the white "Search Chumbucket in the Solana dApp Store" badge | `cta.button` |
| Three phones rising out of the panel (Home, Profile, Calls) | `cta.phones`, `cta.phone-left`, `cta.phone-centre`, `cta.phone-right` |

### Footer (`SiteFooter.tsx`)
`footer.brand`, `footer.links`, `footer.more`, `footer.product`,
`footer.updates`, `footer.follow`, `footer.money` (the plain statement that
calls are free and trades are real USDC that can be lost), `footer.copyright`.

### Floating button
`float.get-app`, class `.cb-fab` (desktop only; phones get the sticky header
instead). Not `.cb-float`: `app/globals.css` gives that class the Arena's
idle bob, which would make this button drift up and down.

## Adding motion

- Target `[data-section="…"]` for section entrances and `[data-el="…"]` for
  single elements. Hooks are stable; class names may be restyled.
- Placed decor (`.cb-at`: phones, sparkles, glows, orbits) already uses
  `transform` for its Figma rotation. Animate with the individual
  properties `translate`, `scale` and `rotate`, which compose with it,
  rather than `transform`, which would replace it. Each one turns about its
  top-left corner (`transform-origin: 0 0`; glows use their Figma corner).
- Orbit rings are SVG `<ellipse>` elements with `data-ring="1..3"`; the
  ribbon is one SVG with a `data-el` on every part.
- Everything respects `prefers-reduced-motion` through the rule at the end of
  `site.css`; keep new motion behind
  `@media (prefers-reduced-motion: no-preference)`.
- The page is server-rendered. Scroll-driven motion can use CSS
  `animation-timeline: view()` with no JavaScript, or a small client
  component per section.

## Copy rules

Truthful for the current product: people's calls on real Panta markets;
calls are free; Back, Fade and Dare are free; trading is optional, real
USDC on Panta (Solana mainnet), paid from the person's own wallet, and can
lose money; Panta settles every market; a receipt exists once Panta has
settled. Never: bet, odds, stake, pot, win money, earn, risk-free,
guaranteed, airdrop, jackpot. `tests/webLanding.test.ts` checks the site
components for those words.

## Assets to replace

The phone screenshots (`public/product-shots/{home,calls,friends,profile}.png`,
mapped in `components/site/config.ts`) are captures from before the move
to Panta markets: they show football fixtures, SOL challenges and "Call too"
pots. They are kept so the page matches the old one; replace them with
current captures (1170 x 2462 PNG, status bar included) of the Home feed of
calls, a call or receipt, a profile with its record, and the Calls / people
feed, and every mockup updates.

## Known differences from the old page

Intentional:
- Copy rewritten for the current product (same structure and rhythm); the
  invented testimonial is replaced by a real call from the feed.
- Template glitches fixed: the ribbon's "What is it?" no longer overlaps its
  second line; "open arena" and "Settled by TxLINE" are no longer clipped;
  the clipped "+234 802 508" phone number and the email address with no mail
  server behind it are replaced by "Android · dApp Store" and "Markets by
  Panta"; the copyright sits on one centred line; the black rectangles over
  the CTA phones are gone; the FAQ cards are an even height with the same
  gap under every question (Figma's ran 41 to 74px; the gap below the grid
  keeps the CTA and footer where they were); the CTA button shows the
  Android robot instead of an Apple logo.
- A short money statement sits above the copyright.
- Body grey is 54% black instead of 50%, and the footer's @handle is
  `#7f7076` instead of `#988990`, so both pass WCAG AA.
- Kept from Figma on purpose, though they look accidental: 27px then 37px
  between the three feature items, and the footer "Follow" label set 40px
  from the left of its button rather than centred.
- From 720 to 1023px the phone stages leave room on the copy side for their
  rings (they reach 142 design px past the phone), so no ring runs under
  text.

Not yet:
- White text on the `#ff5a76` FAQ cards is 3:1, under AA for 18px text; it
  is kept for fidelity. Darkening `--cb-pink` on those cards fixes it.
