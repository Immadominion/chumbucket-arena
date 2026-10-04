"use client";

/**
 * The web app's root. It renders nothing session-dependent on the server
 * (the account lives in this browser), so the first paint is the brand mark
 * and the next is either the app on its saved data or the way in.
 */

import { useEffect, useState } from "react";
import { DataProvider, ToastProvider } from "./data";
import { useAuth, AuthProvider } from "./session";
import { ChumbucketWalletRoot } from "./chumbucketWallet";
import { ClaimScreen, SignInScreen } from "./screens/DoorScreens";
import { Shell } from "./Shell";
import { StateScreen } from "./ui";

/* eslint-disable @next/next/no-img-element */

function Splash() {
  return (
    <div className="wa-splash" aria-busy="true" aria-label="Opening Chumbucket">
      <img src="/img/logo-192.png" alt="" width={64} height={64} />
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  switch (auth.status) {
    case "loading":
      return <Splash />;
    case "signedOut":
      return <SignInScreen />;
    case "needsAccount":
      return <ClaimScreen mode="new" />;
    case "needsHandle":
      return <ClaimScreen mode="handle" />;
    case "offline": {
      // "Offline" only when the network is the reason; a BFF failure gets the error art and its own line.
      const offline = auth.failure?.offline ?? true;
      return (
        <main className="wa-door-panel" style={{ justifyContent: "center" }}>
          <StateScreen
            art={offline ? "offline" : "error"}
            line={auth.failure?.line ?? "You’re offline"}
            action={{ label: "Try again", onClick: auth.retry }}
          />
        </main>
      );
    }
    case "ready":
      return (
        <DataProvider userId={auth.identity!.userId}>
          <ToastProvider>
            <Shell>{children}</Shell>
          </ToastProvider>
        </DataProvider>
      );
  }
}

export function WebAppRoot({ className, children }: { className: string; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className={`wa ${className}`}>
      {mounted ? (
        <AuthProvider>
          <ChumbucketWalletRoot>
            <Gate>{children}</Gate>
          </ChumbucketWalletRoot>
        </AuthProvider>
      ) : (
        <Splash />
      )}
      <div id="wa-portal" />
    </div>
  );
}
