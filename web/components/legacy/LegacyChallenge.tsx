"use client";

/**
 * A legacy Arena challenge link (/c/chg_…), with the Arena client state it
 * needs. Loaded on demand from /c so a shared call never ships this code.
 */

import AppProviders from "@/components/AppProviders";
import ChallengeLinkClient from "./ChallengeLinkClient";

export default function LegacyChallenge({ challengeId }: { challengeId: string }) {
  return (
    <AppProviders>
      <ChallengeLinkClient challengeId={challengeId} />
    </AppProviders>
  );
}
