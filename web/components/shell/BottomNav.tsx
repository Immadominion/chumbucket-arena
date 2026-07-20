"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isNavActive } from "@/components/shell/navItems";

export default function BottomNav() {
  const path = usePathname();

  return (
    <nav className="bottomnav">
      <div className="bottomnav-inner">
        {NAV_ITEMS.map(({ href, label, Icon, also }) => {
          const on = isNavActive(path, href, also);
          return (
            <Link
              key={href}
              href={href}
              className={`navbtn${on ? " navon" : ""}`}
              aria-current={on ? "page" : undefined}
              style={{ width: "auto", minWidth: 58, height: "auto", padding: "6px 8px", flexDirection: "column", gap: 3 }}
            >
              <Icon size={20} weight={on ? "fill" : "regular"} />
              <span style={{ fontSize: 10, fontWeight: 700, lineHeight: 1 }}>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
