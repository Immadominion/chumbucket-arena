"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { House, SoccerBall, ChartDonut, Wallet, Users, Plus, Basket } from "@/components/icons";

const items = [
  { href: "/arena", Icon: House, also: [] as string[] },
  { href: "/matchday", Icon: SoccerBall, also: ["/call", "/challenge"] },
  { href: "/calls", Icon: Basket, also: [] },
  { href: "/results", Icon: ChartDonut, also: [] },
  { href: "/wallet", Icon: Wallet, also: [] },
  { href: "/friends", Icon: Users, also: ["/send"] },
];

export default function LeftRail() {
  const path = usePathname();
  const matchesSegment = (p: string) => path === p || path.startsWith(`${p}/`);
  const active = (href: string, also: string[]) =>
    (href === "/arena" ? path === "/arena" : matchesSegment(href)) ||
    also.some((p) => matchesSegment(p));

  return (
    <div className="lrail">
      <div className="logo">
        <Image src="/img/logo.png" alt="ChumBucket" width={30} height={30} style={{ objectFit: "contain" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 34 }}>
        {items.map(({ href, Icon, also }) => {
          const on = active(href, also);
          return (
            <Link key={href} href={href} className={`railbtn${on ? " railon" : ""}`} aria-current={on ? "page" : undefined}>
              <Icon size={22} weight={on ? "fill" : "regular"} />
            </Link>
          );
        })}
      </div>
      <div style={{ marginTop: "auto" }}>
        <Link
          href="/matchday"
          title="Start a bet"
          style={{ width: 46, height: 46, borderRadius: 14, border: "1.5px dashed #E6C9D0", background: "none", color: "#FF3355", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <Plus size={22} weight="bold" />
        </Link>
      </div>
    </div>
  );
}
