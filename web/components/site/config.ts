/**
 * Site-wide links and the product screenshots, in one place.
 *
 * Nothing here is invented: the install link comes from the deploy's
 * environment (unset means "search the Solana dApp Store"), the X account is
 * the one the site has always linked, and Panta is the venue every market is
 * on.
 */

/** Where "Get the app" goes. Unset: every CTA points at the #get section. */
export const INSTALL_URL = process.env.NEXT_PUBLIC_ANDROID_INSTALL_URL || null;

/** The href every "get the app" button uses. */
export const GET_APP_HREF = INSTALL_URL ?? "/#get";

/**
 * The signed-in web app, once it serves the calls product. Set
 * NEXT_PUBLIC_WEB_APP_URL and the hero's second link becomes "open web app"
 * and the FAQ says there is one. Unset (today) the link shows a real
 * receipt: /signin and /arena in this project are still the retired
 * football-and-escrow product, so the site does not send anyone there.
 */
export const WEB_APP_URL = process.env.NEXT_PUBLIC_WEB_APP_URL || null;

export const X_HANDLE = "HeIsJoel0x";
export const X_URL = `https://x.com/${X_HANDLE}`;
export const PANTA_URL = "https://panta.market";

/** Primary navigation, in page order of the sections they jump to. */
export const NAV_ITEMS = [
  { href: "/", label: "Home", id: "home" },
  { href: "/#features", label: "How it works", id: "features" },
  { href: "/#benefits", label: "Receipts", id: "benefits" },
  { href: "/#live", label: "Live calls", id: "live" },
  { href: "/#faq", label: "FAQ", id: "faq" },
] as const;

/**
 * Product screenshots shown inside the phone mockups. Swap a path here to
 * change every mockup that shows that screen.
 *
 * Captures of the current Android app on a Seeker, signed in as the owner
 * (@dev). The real status bar is replaced by a neutral one (9:41, full
 * signal and battery) and the gesture handle is cropped off. Each is
 * 720 x 1558, the phone screen's ratio (0.4622); the call-to-action phones
 * crop a hair off the sides. `label` says what the screen shows; the phones
 * themselves are decorative (the copy beside them says the same).
 * See docs/website-structure.md, "Product screenshots".
 */
export const SCREENS = {
  home: { src: "/product-shots/home-feed.webp", label: "Home: a receipt banner over the feed of calls" },
  call: { src: "/product-shots/call-on-record.webp", label: "A call: “You’re on record”, with its side, percent and time" },
  receipt: { src: "/product-shots/receipt-missed.webp", label: "A receipt: “Missed this one.”, settled by Panta" },
  markets: { src: "/product-shots/markets.webp", label: "Markets: categories and each side’s percent" },
  profile: { src: "/product-shots/profile-record.webp", label: "Profile: wallet and the record of calls" },
  welcome: { src: "/product-shots/welcome.webp", label: "Welcome: “Call it before it happens.”" },
} as const;

export type ScreenName = keyof typeof SCREENS;

/**
 * The first call's header from the Home screen (caller, side, close, free
 * call), lifted off the phone in Benefits. 804 x 246, the card's ratio.
 */
export const CALL_CARD = {
  src: "/product-shots/home-call-card.webp",
  label: "A call on Home: Dominion (@dev), NO, closes in 47d, free call",
} as const;
