import type { Metadata } from "next";
import TroofLanding from "@/components/troof/TroofLanding";

/**
 * Arena product entry — literal Troof Figma template (assets + layout),
 * Chumbucket wording. Marketing home for the brand remains chum-bucket/.
 * Phone screens are blank until product shots are dropped in.
 */

export const metadata: Metadata = {
  title: "Chumbucket: predict football matches with friends",
  description:
    "Predict a football match, challenge a friend, and let the real score settle it on Solana via TxLINE.",
};

export default function LandingPage() {
  return (
    <>
      {/* Troof materializer styles + bitmaps (paths point at /public/troof) */}
      <link rel="stylesheet" href="/troof/fig-tokens.css" />
      <link rel="stylesheet" href="/troof/fig-typography.css" />
      <link rel="stylesheet" href="/troof/fig-assets.css" />
      <link rel="stylesheet" href="/troof/landing.css" />
      <TroofLanding />
    </>
  );
}
