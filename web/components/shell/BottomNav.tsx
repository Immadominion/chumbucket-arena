"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartDonut, House, SoccerBall, Wallet, Users } from "@/components/icons";

const items = [
  { href: "/arena", Icon: House, also: [] as string[] },
  { href: "/matchday", Icon: SoccerBall, also: ["/call", "/challenge"] },
  { href: "/results", Icon: ChartDonut, also: [] },
  { href: "/wallet", Icon: Wallet, also: [] },
  { href: "/friends", Icon: Users, also: ["/send"] },
];

export default function BottomNav() {
  const path = usePathname();
  const active = (href: string, also: string[]) =>
    (href === "/arena" ? path === "/arena" : path.startsWith(href)) ||
    also.some((p) => path.startsWith(p));

  return (
    <nav className="bottomnav">
      <div className="bottomnav-inner">
        {items.map(({ href, Icon, also }) => {
          const on = active(href, also);
          return (
            <Link key={href} href={href} className={`navbtn${on ? " navon" : ""}`} aria-current={on ? "page" : undefined}>
              <Icon size={21} weight={on ? "fill" : "regular"} />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
