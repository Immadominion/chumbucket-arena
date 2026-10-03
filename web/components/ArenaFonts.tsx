/**
 * Inter (body) and JetBrains Mono (numbers) for the Arena routes, from
 * Google Fonts. Only those routes use them; the public site (landing, share
 * pages, legal pages) is set in PP Neue Machina from next/font, so it no
 * longer waits on this stylesheet. React hoists the link into <head>.
 */

import { preconnect } from "react-dom";

const ARENA_FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap";

export function ArenaFonts() {
  preconnect("https://fonts.googleapis.com");
  preconnect("https://fonts.gstatic.com", { crossOrigin: "anonymous" });
  return <link rel="stylesheet" href={ARENA_FONTS_CSS} precedence="default" />;
}
