/**
 * Legacy Arena challenge links. People still open chumbucket.fun/c/chg_…
 * links shared before calls replaced challenges; next.config.ts rewrites those
 * here, so the Arena client this page needs (Privy, tRPC) stays out of the
 * /c share page that every new call link opens.
 */

import type { Metadata } from "next";
import LegacyChallenge from "@/components/legacy/LegacyChallenge";

type Params = { challengeId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { challengeId } = await params;
  // The link keeps its /c/ address, and with it the /c link-preview image.
  const image = `/c/${encodeURIComponent(challengeId)}/opengraph-image`;
  return {
    title: "A Chumbucket challenge",
    robots: { index: false },
    openGraph: { title: "A Chumbucket challenge", images: [image] },
    twitter: { card: "summary_large_image", images: [image] },
  };
}

export default async function LegacyChallengePage({ params }: { params: Promise<Params> }) {
  const { challengeId } = await params;
  return <LegacyChallenge challengeId={challengeId} />;
}
