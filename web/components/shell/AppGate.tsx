"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "@/lib/session";

/**
 * Gate the app behind sign-in. Guests go to /signin; a signed-in player drops
 * straight onto the dashboard (the spotlight tour handles the welcome — there's
 * no separate Trial step anymore).
 */
export default function AppGate({ children }: { children: React.ReactNode }) {
  const { session, ready } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    if (session.status === "guest") router.replace("/signin");
  }, [ready, session.status, router]);

  if (!ready || session.status === "guest") {
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf6f7" }}>
        <div className="cb-float" style={{ display: "flex", alignItems: "center", gap: 10, color: "#988990", fontWeight: 600, fontSize: 14 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/img/logo.png" alt="" style={{ width: 34, height: 34, objectFit: "contain" }} />
          Loading ChumBucket…
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
