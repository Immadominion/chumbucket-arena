"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Plus } from "@/components/icons";
import { NAV_ITEMS, isNavActive } from "@/components/shell/navItems";

export default function LeftRail() {
  const path = usePathname();

  return (
    <div className="lrail">
      <div className="logo">
        <Image src="/img/logo.png" alt="ChumBucket" width={30} height={30} style={{ objectFit: "contain" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 30, width: "100%", alignItems: "center" }}>
        {NAV_ITEMS.map(({ href, label, Icon, also }) => {
          const on = isNavActive(path, href, also);
          return (
            <Link
              key={href}
              href={href}
              className={`railbtn${on ? " railon" : ""}`}
              aria-current={on ? "page" : undefined}
              style={{ width: 68, height: "auto", padding: "9px 0", flexDirection: "column", gap: 4 }}
            >
              <Icon size={21} weight={on ? "fill" : "regular"} />
              <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".01em", lineHeight: 1, color: on ? "#fff" : "#6f6169" }}>{label}</span>
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
