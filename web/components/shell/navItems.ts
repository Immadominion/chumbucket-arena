import type { Icon } from "@phosphor-icons/react";
import { House, Broadcast, Users, UserCircle } from "@/components/icons";

/**
 * The one shared navigation config, used by both the desktop LeftRail and the
 * mobile BottomNav so they can never drift. Four labeled destinations matching
 * the mobile app's tabs (Home / Predictions / Friends / Profile). Every other
 * route maps onto one of these via `also`, so the right tab stays lit:
 *   /matchday, /bet, /challenge → Home (the match list + betting flow)
 *   /send                       → Friends
 *   /wallet, /results           → Profile (its money hub)
 */
export type NavItem = {
  href: string;
  label: string;
  Icon: Icon;
  also: string[];
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/arena", label: "Home", Icon: House, also: ["/matchday", "/bet", "/challenge"] },
  { href: "/predictions", label: "Predictions", Icon: Broadcast, also: [] },
  { href: "/friends", label: "Friends", Icon: Users, also: ["/send"] },
  { href: "/settings", label: "Profile", Icon: UserCircle, also: ["/wallet", "/results"] },
];

/** Is `href` (or one of its `also` prefixes) the active route for `path`? */
export function isNavActive(path: string, href: string, also: string[]): boolean {
  const seg = (p: string) => path === p || path.startsWith(`${p}/`);
  const self = href === "/arena" ? path === "/arena" : seg(href);
  return self || also.some(seg);
}
