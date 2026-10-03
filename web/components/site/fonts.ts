import localFont from "next/font/local";

/**
 * PP Neue Machina, the face the whole site is set in (the live Figma page set
 * every line in it, body copy included). Two cuts are used: Regular for body,
 * nav and the hero headline, Ultrabold for every bold heading. woff2 copies of
 * the OTFs in public/fonts (those stay for the OG image renderer).
 *
 * Exposed as the CSS variable --font-machina on .cb-site.
 */
export const machina = localFont({
  src: [
    { path: "../../app/fonts/PPNeueMachina-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../app/fonts/PPNeueMachina-Ultrabold.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-machina",
  display: "swap",
  fallback: ["system-ui", "Helvetica Neue", "Arial", "sans-serif"],
});
