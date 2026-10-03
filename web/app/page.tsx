/**
 * chumbucket.fun: the landing page.
 *
 * Hand-written replacement for the Figma export that used to render the
 * live page (components/troof/AppLandingPage.jsx). Same design, real
 * layout: one component per section under components/site/landing, shared
 * tokens in components/site/site.css. docs/website-structure.md maps every
 * visual element to its component and animation hook.
 *
 * Server-rendered and revalidated every minute: the social-proof section
 * shows the real top callers (people.leaderboard, cached five minutes) and
 * a real public call from the calls feed, or says plainly that there is
 * none (or that the feed is down). Nothing on the page is invented.
 */

import type { Metadata } from "next";
// The shell (and with it site.css) first, so landing.css cascades after it.
import { SiteShell } from "@/components/site/SiteShell";
import { WEB_APP_URL } from "@/components/site/config";
import { Benefits } from "@/components/site/landing/Benefits";
import { Faq } from "@/components/site/landing/Faq";
import { Features } from "@/components/site/landing/Features";
import { GetTheApp } from "@/components/site/landing/GetTheApp";
import { Hero } from "@/components/site/landing/Hero";
import { SocialProof } from "@/components/site/landing/SocialProof";
import "@/components/site/landing/landing.css";
import "@/components/site/landing/landing-motion.css";
import { getFeed, getLeaderboard, getSuggested, maybe } from "@/lib/callsBff";
import { pickCallers } from "@/lib/landingPeople";
import { heroProofLink, proofState } from "@/lib/landingProof";

export const revalidate = 60;

const TITLE = "Chumbucket: FOMO for prediction markets";
const DESCRIPTION =
  "See what people call on real Panta prediction markets and how often they’re right. Back them, fade them or make your own call, free, and keep the receipt.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { siteName: "Chumbucket", title: TITLE, description: DESCRIPTION, url: "/", images: ["/img/logo-320.png"] },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default async function HomePage() {
  // Three public reads in parallel; any of them failing leaves its part of
  // the page in its honest empty state rather than failing the page.
  const [feed, leaderboard, suggested] = await Promise.all([maybe(getFeed(12)), maybe(getLeaderboard()), maybe(getSuggested())]);
  const state = proofState(feed);
  const callers = pickCallers({ leaderboard, suggested, feed });
  return (
    <SiteShell current="home" className="cb-landing">
      <Hero proofLink={heroProofLink(state, WEB_APP_URL)} />
      <Features />
      <Benefits />
      <SocialProof state={state} callers={callers} />
      <Faq />
      <GetTheApp />
    </SiteShell>
  );
}
