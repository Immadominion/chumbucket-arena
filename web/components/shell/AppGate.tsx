"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "@/lib/session";

/**
 * Connects the journey: you can't be inside the app until you've signed the
 * contract and been through the Trial. Guests go to /contract; signed-but-not-
 * onboarded players go to /trial.
 */
export default function AppGate({ children }: { children: React.ReactNode }) {
  const { session, ready } = useSession();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!ready) return;
    if (session.status === "guest") router.replace("/contract");
    else if (!session.onboarded && path !== "/trial") router.replace("/trial");
  }, [ready, session.status, session.onboarded, path, router]);

  if (!ready || session.status === "guest" || !session.onboarded) {
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
