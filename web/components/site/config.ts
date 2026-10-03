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

export const X_HANDLE = "HeIsJoel0x";
export const X_URL = `https://x.com/${X_HANDLE}`;
export const PANTA_URL = "https://panta.market";

/** Primary navigation, in page order of the sections they jump to. */
export const NAV_ITEMS = [
  { href: "/", label: "Home", id: "home" },
  { href: "/#features", label: "Features", id: "features" },
  { href: "/#benefits", label: "Benefits", id: "benefits" },
  { href: "/#faq", label: "FAQs", id: "faq" },
  { href: "/#live", label: "Live calls", id: "live" },
] as const;

/**
 * Product screenshots shown inside the phone mockups. Swap a path here to
 * change every mockup that shows that screen.
 *
 * These are captures of the Android app from before the move to Panta
 * markets (they still show football fixtures). Replace them with current
 * captures at the same 1170 x 2462 size; see docs/website-structure.md.
 */
export const SCREENS = {
  home: { src: "/product-shots/home.png", label: "Home" },
  calls: { src: "/product-shots/calls.png", label: "Calls" },
  friends: { src: "/product-shots/friends.png", label: "Friends" },
  profile: { src: "/product-shots/profile.png", label: "Profile" },
} as const;

export type ScreenName = keyof typeof SCREENS;
